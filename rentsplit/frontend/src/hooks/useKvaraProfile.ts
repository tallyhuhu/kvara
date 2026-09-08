import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type EIP1193Provider
} from "viem";
import { base } from "viem/chains";
import { appendFrontendBuilderAttribution } from "../lib/baseAttribution";
import {
  KVARA_PROFILE_REGISTRY_ABI,
  KVARA_PROFILE_REGISTRY_ADDRESS,
  profileRoleFromChain,
  profileRoleToChain,
  type KvaraProfileRole
} from "../lib/profileRegistry";
import { BASE_EXPLORER_URL, BASE_RPC_URL } from "../lib/groupStorage";

type ProfileState = {
  wallet?: string;
  checked?: boolean;
  loading: boolean;
  submitting: boolean;
  role: KvaraProfileRole | null;
  error?: string;
  txHash?: `0x${string}`;
};

export function useKvaraProfile(account: `0x${string}` | null) {
  const [state, setState] = useState<ProfileState>({ loading: false, submitting: false, role: null });
  const [reload, setReload] = useState(0);
  const pending = useRef(new Map<string, `0x${string}`>());
  const submitting = useRef(false);
  const accountRef = useRef(account);
  accountRef.current = account;
  const publicClient = useMemo(
    () => createPublicClient({ chain: base, transport: http(BASE_RPC_URL) }),
    []
  );

  const loadProfile = useCallback(async (walletAddress: `0x${string}`) => {
    const chainRole = await publicClient.readContract({
      address: KVARA_PROFILE_REGISTRY_ADDRESS,
      abi: KVARA_PROFILE_REGISTRY_ABI,
      functionName: "profileOf",
      args: [walletAddress]
    });
    return profileRoleFromChain(Number(chainRole));
  }, [publicClient]);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setState({ loading: false, submitting: false, role: null });
      return;
    }
    setState({ wallet: account, loading: true, submitting: false, role: null });
    loadProfile(account)
      .then((role) => {
        if (!cancelled) setState({ wallet: account, checked: true, loading: false, submitting: false, role, txHash: pending.current.get(account.toLowerCase()) });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            wallet: account,
            checked: false,
            loading: false,
            submitting: false,
            role: null,
            error: "Could not reach Base to check your profile. Please try again."
          });
        }
      });
    return () => { cancelled = true; };
  }, [account, loadProfile, reload]);

  const createProfile = useCallback(async (role: KvaraProfileRole) => {
    if (!account) throw new Error("Connect MetaMask first.");
    const ethereum = window.ethereum as EIP1193Provider | undefined;
    if (!ethereum) throw new Error("MetaMask is not available in this browser.");
    if (submitting.current) throw new Error("A profile transaction is already being checked.");
    submitting.current = true;
    setState((current) => ({ ...current, submitting: true, error: undefined }));

    try {
      const [selected] = await ethereum.request({ method: "eth_accounts" }) as string[];
      if (selected?.toLowerCase() !== account.toLowerCase()) throw new Error("Switch back to the selected wallet before creating your profile.");
      const existing = await loadProfile(account);
      if (existing) {
        if (accountRef.current === account) setState({ wallet: account, checked: true, loading: false, submitting: false, role: existing });
        return { role: existing, txHash: undefined, basescanUrl: `${BASE_EXPLORER_URL}/address/${account}` };
      }
      const callData = appendFrontendBuilderAttribution(encodeFunctionData({
        abi: KVARA_PROFILE_REGISTRY_ABI,
        functionName: "setProfile",
        args: [profileRoleToChain(role)]
      }));
      await publicClient.call({
        account,
        to: KVARA_PROFILE_REGISTRY_ADDRESS,
        data: callData
      });
      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: custom(ethereum)
      });
      const txHash = pending.current.get(account.toLowerCase()) ?? await walletClient.sendTransaction({
        account,
        to: KVARA_PROFILE_REGISTRY_ADDRESS,
        data: callData
      });
      pending.current.set(account.toLowerCase(), txHash);
      if (accountRef.current === account) setState((current) => ({ ...current, txHash }));
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
      pending.current.delete(account.toLowerCase());
      if (receipt.status !== "success") {
        if (accountRef.current === account) setState((current) => ({ ...current, txHash: undefined }));
        throw new Error("Base profile transaction reverted. Choose your role to try again.");
      }
      const savedRole = await loadProfile(account);
      if (!savedRole) throw new Error("Base confirmed the transaction, but the profile role did not update.");
      if (accountRef.current?.toLowerCase() === account.toLowerCase()) {
        setState({ wallet: account, checked: true, loading: false, submitting: false, role: savedRole, txHash });
      }
      return { role: savedRole, txHash, basescanUrl: `${BASE_EXPLORER_URL}/tx/${txHash}` };
    } catch (cause) {
      const error = profileErrorMessage(cause);
      if (accountRef.current?.toLowerCase() === account.toLowerCase()) {
        setState((current) => ({ ...current, submitting: false, error }));
      }
      throw cause;
    } finally {
      submitting.current = false;
    }
  }, [account, loadProfile, publicClient]);

  const current = state.wallet?.toLowerCase() === account?.toLowerCase();
  return {
    ...state,
    loading: Boolean(account) && (!current || state.loading),
    role: current ? state.role : null,
    checked: current && state.checked,
    createProfile,
    retry: () => setReload((value) => value + 1)
  };
}

function profileErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (/user rejected|rejected the request|denied transaction|code 4001/i.test(message)) {
    return "Profile creation was cancelled in MetaMask.";
  }
  if (/insufficient funds|exceeds the balance/i.test(message)) {
    return "This wallet needs a small amount of ETH on Base for the one-time profile transaction.";
  }
  if (/timed? out|timeout/i.test(message)) {
    return "Base confirmation is taking longer than expected. Check MetaMask before trying again.";
  }
  return message || "Could not create your Base profile.";
}
