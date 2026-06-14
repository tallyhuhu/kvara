import { useCallback, useMemo, useState } from "react";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";
import { decodeDelegations } from "@metamask/smart-accounts-kit/utils";
import { bytesToHex } from "viem/utils";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider
} from "viem";
import { base } from "viem/chains";
import {
  BASE_CHAIN_HEX,
  BASE_CHAIN_ID,
  BASE_EXPLORER_URL,
  BASE_RPC_URL,
  DEFAULT_PERMISSION_BUFFER_PERCENT,
  RENT_PERIOD_SECONDS,
  USDC_BASE_ADDRESS,
  type PermissionGrant,
  type RentGroup,
  type Roommate
} from "../lib/groupStorage";

type RelayerCapabilities = Record<
  string,
  {
    feeCollector: `0x${string}`;
    targetAddress: `0x${string}`;
    tokens: Array<{ address: `0x${string}`; symbol?: string; decimals: number | string }>;
  }
>;

type FeeData = {
  minFee: string;
  feeCollector: `0x${string}`;
  targetAddress?: `0x${string}`;
  token: { address: `0x${string}`; decimals: number; symbol?: string };
};

type Wallet7715 = {
  requestExecutionPermissions: (permissions: unknown[]) => Promise<Array<{ context?: unknown }>>;
  getSupportedExecutionPermissions?: () => Promise<unknown>;
};

type PermissionRequestState = {
  loading: boolean;
  account?: `0x${string}`;
  error?: string;
  detail?: string;
};

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? "https://relayer.1shotapi.com/relayers";
const FEE_BUFFER_USDC = import.meta.env.VITE_RELAYER_FEE_BUFFER_USDC ?? "0.05";

export function useMetaMaskPermissions() {
  const [state, setState] = useState<PermissionRequestState>({ loading: false });

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: base,
        transport: http(BASE_RPC_URL)
      }),
    []
  );

  const requestRentPermission = useCallback(
    async (group: RentGroup, roommate: Roommate): Promise<PermissionGrant> => {
      setState({ loading: true, error: undefined, detail: "Connecting MetaMask" });

      try {
        const ethereum = getEthereum();
        await ensureBaseNetwork(ethereum);
        const [account] = (await ethereum.request({ method: "eth_requestAccounts" })) as [`0x${string}`];
        const connected = account.toLowerCase();
        if (connected !== roommate.walletAddress.toLowerCase()) {
          throw new Error(`Connected wallet ${account} does not match invite wallet ${roommate.walletAddress}.`);
        }

        setState({ loading: true, account, detail: "Fetching relayer capabilities" });
        const capabilities = await relayerRpc<RelayerCapabilities>("relayer_getCapabilities", [
          String(BASE_CHAIN_ID)
        ]);
        const chainCaps = capabilities[String(BASE_CHAIN_ID)];
        if (!chainCaps) throw new Error("1Shot relayer does not report Base mainnet support.");

        const usdc =
          chainCaps.tokens.find((token) => token.address.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase()) ??
          chainCaps.tokens.find((token) => token.symbol?.toUpperCase() === "USDC");
        if (!usdc) throw new Error("1Shot relayer does not accept Base USDC for fees.");

        const feeData = await relayerRpc<FeeData>("relayer_getFeeData", {
          chainId: String(BASE_CHAIN_ID),
          token: usdc.address
        });

        const tokenDecimals = Number(usdc.decimals);
        const shareAtoms = parseUnits(roommate.share, tokenDecimals);
        const bufferPercent = group.permissionBufferPercent ?? DEFAULT_PERMISSION_BUFFER_PERCENT;
        const adjustmentBufferAtoms = (shareAtoms * BigInt(Math.max(0, Math.round(bufferPercent)))) / 100n;
        const minFeeAtoms = BigInt(feeData.minFee);
        const feeBufferAtoms = maxBigInt(parseUnits(FEE_BUFFER_USDC, tokenDecimals), minFeeAtoms);
        const allowanceAtoms = shareAtoms + adjustmentBufferAtoms + feeBufferAtoms;
        const relayerTarget = feeData.targetAddress ?? chainCaps.targetAddress;

        setState({ loading: true, account, detail: "Requesting ERC-7715 permission in MetaMask" });
        const walletClient = createWalletClient({
          account: account as Address,
          chain: base,
          transport: custom(ethereum)
        });
        const wallet7715 = walletClient.extend(erc7715ProviderActions()) as unknown as Wallet7715;

        if (!wallet7715.requestExecutionPermissions) {
          throw new Error("Connected wallet does not expose wallet_requestExecutionPermissions.");
        }

        await maybeCheckSmartAccount(publicClient as CodeReader, account);
        await wallet7715.getSupportedExecutionPermissions?.().catch(() => undefined);

        const granted = await wallet7715.requestExecutionPermissions([
          {
            chainId: BASE_CHAIN_ID,
            to: relayerTarget,
            permission: {
              type: "erc20-token-periodic",
              data: {
                tokenAddress: USDC_BASE_ADDRESS,
                periodAmount: allowanceAtoms,
                periodDuration: RENT_PERIOD_SECONDS,
                justification: `Kvara rent agent: ${formatUnits(
                  shareAtoms,
                  tokenDecimals
                )} USDC share plus ${bufferPercent}% adjustment buffer and relayer fee`
              },
              isAdjustmentAllowed: false
            },
            expiry: Math.floor(Date.now() / 1000) + RENT_PERIOD_SECONDS * 12
          }
        ]);

        const rawContext = granted[0]?.context;
        if (!rawContext) throw new Error("MetaMask did not return a permission context.");

        const permissionContext = decodeDelegations(rawContext as Parameters<typeof decodeDelegations>[0]).map(
          (delegation) => toRelayerJson(delegation)
        );
        const permission: PermissionGrant = {
          status: "granted",
          walletAddress: account,
          rawContext: typeof rawContext === "string" ? rawContext : JSON.stringify(toRelayerJson(rawContext)),
          permissionContext,
          allowanceAtoms: allowanceAtoms.toString(),
          shareAtoms: shareAtoms.toString(),
          adjustmentBufferAtoms: adjustmentBufferAtoms.toString(),
          adjustmentBufferPercent: bufferPercent,
          feeBufferAtoms: feeBufferAtoms.toString(),
          tokenAddress: USDC_BASE_ADDRESS,
          tokenDecimals,
          relayerTargetAddress: relayerTarget,
          feeCollector: feeData.feeCollector ?? chainCaps.feeCollector,
          grantedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + RENT_PERIOD_SECONDS * 12
        };

        setState({
          loading: false,
          account,
          detail: `Permission covers ${formatUnits(allowanceAtoms, tokenDecimals)} USDC per 30 days`
        });
        return permission;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Permission request failed";
        setState({ loading: false, error: message });
        throw error;
      }
    },
    [publicClient]
  );

  return { ...state, requestRentPermission };
}

async function ensureBaseNetwork(ethereum: EIP1193Provider): Promise<void> {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_HEX }]
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_CHAIN_HEX,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [BASE_RPC_URL],
          blockExplorerUrls: [BASE_EXPLORER_URL]
        }
      ]
    });
  }
}

async function relayerRpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RELAYER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  const json = (await response.json()) as
    | { result: T }
    | { error: { code: number; message: string; data?: unknown } };
  if (!response.ok) throw new Error(`Relayer HTTP ${response.status}`);
  if ("error" in json) throw new Error(`[${json.error.code}] ${json.error.message}`);
  return json.result;
}

function getEthereum(): EIP1193Provider {
  const provider = window.ethereum as EIP1193Provider | undefined;
  if (!provider) {
    throw new Error("MetaMask is not available in this browser.");
  }
  return provider;
}

type CodeReader = {
  getCode: (args: { address: `0x${string}` }) => Promise<unknown>;
};

async function maybeCheckSmartAccount(publicClient: CodeReader, account: `0x${string}`): Promise<void> {
  await publicClient.getCode({ address: account }).catch(() => undefined);
}

function toRelayerJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(toRelayerJson);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = toRelayerJson(nested);
    return output;
  }
  return value;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
