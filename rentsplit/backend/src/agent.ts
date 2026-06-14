import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import type { PaymentRecord, RentGroup } from "./types.js";

const BASE_CHAIN_ID = "8453";
const BASESCAN_URL = "https://basescan.org";
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const RELAYER_URL = process.env.RELAYER_URL ?? "https://relayer.1shotapi.com/relayers";
const FEE_BUFFER_USDC = process.env.RELAYER_FEE_BUFFER_USDC ?? "0.05";

type PermissionGrant = {
  status: "pending" | "granted" | "expired" | "failed";
  permissionContext?: unknown[];
  allowanceAtoms?: string;
  shareAtoms?: string;
  tokenDecimals?: number;
  tokenAddress?: `0x${string}`;
  relayerTargetAddress?: `0x${string}`;
  expiresAt?: number;
};

type Roommate = {
  id: string;
  name: string;
  walletAddress: `0x${string}`;
  share: string;
  permission?: PermissionGrant;
};

type RoommateWithPermission = Roommate & { permission?: PermissionGrant };

type Capabilities = Record<
  string,
  {
    feeCollector: `0x${string}`;
    targetAddress: `0x${string}`;
    tokens: Array<{ address: `0x${string}`; symbol?: string; decimals: number | string }>;
  }
>;

type FeeData = {
  minFee: string;
  context?: string;
  feeCollector: `0x${string}`;
  targetAddress?: `0x${string}`;
  token: { address: `0x${string}`; decimals: number; symbol?: string };
};

type EstimateResult = {
  success: boolean;
  gasUsed: Record<string, string>;
  requiredPaymentAmount?: string;
  context?: string;
  error?: string;
};

type StatusResult = {
  id: string;
  chainId: string;
  status: 100 | 110 | 200 | 400 | 500;
  hash?: `0x${string}`;
  receipt?: { transactionHash?: `0x${string}` };
  message?: string;
  data?: unknown;
};

type Execution = {
  target: `0x${string}`;
  value: string;
  data: `0x${string}`;
};

const taskStore = new Map<string, PaymentRecord>();

export async function getRelayerCapabilities(): Promise<Capabilities> {
  return relayerRpc<Capabilities>("relayer_getCapabilities", [BASE_CHAIN_ID]);
}

export async function collectGroupRent(group: RentGroup): Promise<PaymentRecord[]> {
  const capabilities = await getRelayerCapabilities();
  const chainCaps = capabilities[BASE_CHAIN_ID];
  if (!chainCaps) throw new Error("1Shot relayer does not support Base mainnet.");

  const token =
    chainCaps.tokens.find((item) => item.address.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase()) ??
    chainCaps.tokens.find((item) => item.symbol?.toUpperCase() === "USDC");
  if (!token) throw new Error("Base USDC is not accepted by the configured relayer.");

  const feeData = await relayerRpc<FeeData>("relayer_getFeeData", {
    chainId: BASE_CHAIN_ID,
    token: token.address
  });

  const records = await Promise.all(
    group.roommates.map((roommate) =>
      submitRoommatePayment({
        group,
        roommate: roommate as RoommateWithPermission,
        chainCaps,
        feeData,
        decimals: Number(token.decimals)
      })
    )
  );
  return records;
}

export async function refreshTaskStatuses(taskIds: string[]): Promise<PaymentRecord[]> {
  const updates = await Promise.all(
    taskIds.map(async (taskId) => {
      const existing = taskStore.get(taskId);
      if (!existing) return undefined;

      try {
        const status = await relayerRpc<StatusResult>("relayer_getStatus", { id: taskId, logs: true });
        const updated = applyStatus(existing, status);
        taskStore.set(taskId, updated);
        return updated;
      } catch (cause) {
        const updated: PaymentRecord = {
          ...existing,
          status: "failed",
          error: cause instanceof Error ? cause.message : "Status polling failed"
        };
        taskStore.set(taskId, updated);
        return updated;
      }
    })
  );

  return updates.filter(Boolean) as PaymentRecord[];
}

async function submitRoommatePayment(input: {
  group: RentGroup;
  roommate: RoommateWithPermission;
  chainCaps: Capabilities[string];
  feeData: FeeData;
  decimals: number;
}): Promise<PaymentRecord> {
  const { group, roommate, chainCaps, feeData, decimals } = input;
  const id = `pay_${Date.now().toString(36)}_${roommate.id}`;
  const baseRecord: PaymentRecord = {
    id,
    groupId: group.id,
    roommateId: roommate.id,
    roommateName: roommate.name,
    walletAddress: roommate.walletAddress,
    amount: roommate.share,
    date: new Date().toISOString(),
    status: "pending"
  };

  try {
    const permission = roommate.permission;
    if (!permission || permission.status !== "granted" || !permission.permissionContext?.length) {
      throw new Error("Permission is not active.");
    }
    if (permission.expiresAt && permission.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error("Permission is expired.");
    }

    const shareAtoms = parseUnits(roommate.share, decimals);
    const mockFee = maxBigInt(BigInt(feeData.minFee), parseUnits(FEE_BUFFER_USDC, decimals));
    let params = buildSendParams({
      permission,
      landlordAddress: group.landlordAddress,
      tokenAddress: USDC_BASE_ADDRESS,
      feeCollector: feeData.feeCollector ?? chainCaps.feeCollector,
      feeAmount: mockFee,
      rentAmount: shareAtoms,
      memo: `${group.id}:${roommate.id}:${Date.now()}`
    });

    let estimate = await relayerRpc<EstimateResult>("relayer_estimate7710Transaction", params);
    if (!estimate.success) throw new Error(estimate.error ?? "Relayer estimate failed.");

    const requiredFee = BigInt(estimate.requiredPaymentAmount ?? mockFee.toString());
    assertPermissionCoversFee(permission, shareAtoms, requiredFee);

    if (requiredFee !== mockFee) {
      params = buildSendParams({
        permission,
        landlordAddress: group.landlordAddress,
        tokenAddress: USDC_BASE_ADDRESS,
        feeCollector: feeData.feeCollector ?? chainCaps.feeCollector,
        feeAmount: requiredFee,
        rentAmount: shareAtoms,
        memo: params.memo
      });
      estimate = await relayerRpc<EstimateResult>("relayer_estimate7710Transaction", params);
      if (!estimate.success) throw new Error(estimate.error ?? "Relayer re-estimate failed.");
    }

    const taskId = await relayerRpc<string>("relayer_send7710Transaction", {
      ...params,
      context: estimate.context ?? feeData.context
    });

    const submitted: PaymentRecord = { ...baseRecord, status: "submitted", taskId };
    taskStore.set(taskId, submitted);
    return submitted;
  } catch (cause) {
    return {
      ...baseRecord,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Collection failed"
    };
  }
}

function buildSendParams(input: {
  permission: PermissionGrant;
  landlordAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  feeCollector: `0x${string}`;
  feeAmount: bigint;
  rentAmount: bigint;
  memo: string;
}) {
  const feeExecution = erc20Transfer(input.tokenAddress, input.feeCollector, input.feeAmount);
  const rentExecution = erc20Transfer(input.tokenAddress, input.landlordAddress, input.rentAmount);

  return {
    chainId: BASE_CHAIN_ID,
    memo: input.memo,
    transactions: [
      {
        permissionContext: input.permission.permissionContext ?? [],
        executions: [feeExecution, rentExecution]
      }
    ]
  };
}

function erc20Transfer(tokenAddress: `0x${string}`, recipient: `0x${string}`, amount: bigint): Execution {
  return {
    target: tokenAddress,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amount]
    })
  };
}

function assertPermissionCoversFee(permission: PermissionGrant, shareAtoms: bigint, feeAmount: bigint): void {
  if (!permission.allowanceAtoms) return;
  const allowance = BigInt(permission.allowanceAtoms);
  const maxFee = allowance > shareAtoms ? allowance - shareAtoms : 0n;
  if (feeAmount > maxFee) {
    throw new Error(
      `Relayer fee ${feeAmount.toString()} exceeds the permission fee buffer ${maxFee.toString()}. Re-grant with a larger buffer.`
    );
  }
}

function applyStatus(record: PaymentRecord, status: StatusResult): PaymentRecord {
  if (status.status === 100) return { ...record, status: "pending" };
  if (status.status === 110) {
    return {
      ...record,
      status: "submitted",
      txHash: status.hash,
      basescanUrl: status.hash ? `${BASESCAN_URL}/tx/${status.hash}` : record.basescanUrl
    };
  }
  if (status.status === 200) {
    const txHash = status.receipt?.transactionHash ?? status.hash ?? record.txHash;
    return {
      ...record,
      status: "confirmed",
      txHash,
      basescanUrl: txHash ? `${BASESCAN_URL}/tx/${txHash}` : record.basescanUrl
    };
  }
  if (status.status === 400) {
    return { ...record, status: "rejected", error: status.message ?? "Relayer rejected the task." };
  }
  return { ...record, status: "failed", error: status.message ?? JSON.stringify(status.data ?? "Execution reverted") };
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
  if ("error" in json) {
    throw new Error(`[${json.error.code}] ${json.error.message} ${JSON.stringify(json.error.data ?? "")}`);
  }
  return json.result;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
