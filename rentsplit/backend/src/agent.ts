import { encodeFunctionData, erc20Abi, keccak256, parseUnits, stringToHex } from "viem";
import { refreshAaPayment, submitAaPayment } from "./aaExecutor.js";
import { ONE_SHOT_ATTRIBUTION_SUPPORT, getBuilderAttribution } from "./baseAttribution.js";
import { BASE_CHAIN_ID_STRING, BASE_EXPLORER_URL, USDC_BASE_ADDRESS, config } from "./config.js";
import { paymentIdempotencyKey, validatePermissionForPayment } from "./domain.js";
import { logError, logInfo, logWarn } from "./logger.js";
import {
  getPaymentByTaskId,
  listPaymentsForReconciliation,
  reservePaymentAttempt,
  savePaymentRecord
} from "./store.js";
import type { PaymentRecord, PermissionGrant, RentGroup, Roommate } from "./types.js";

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

export type RelayerStatus = {
  id: string;
  chainId: string;
  status: 100 | 110 | 200 | 400 | 500;
  hash?: `0x${string}`;
  receipt?: { transactionHash?: `0x${string}` };
  message?: string;
  data?: unknown;
};

type Execution = { target: `0x${string}`; value: string; data: `0x${string}` };

export async function getRelayerCapabilities(): Promise<Capabilities> {
  return relayerRpc<Capabilities>("relayer_getCapabilities", [BASE_CHAIN_ID_STRING]);
}

export async function collectGroupRent(group: RentGroup, billingPeriod: string): Promise<PaymentRecord[]> {
  const attribution = getBuilderAttribution(config.baseBuilderCode);
  const needsOneShot = group.roommates.some((roommate) => paymentExecutionMode(roommate) === "one-shot");
  let oneShotContext: { chainCaps: Capabilities[string]; feeData: FeeData; decimals: number } | undefined;
  if (needsOneShot) {
    const capabilities = await getRelayerCapabilities();
    const chainCaps = capabilities[BASE_CHAIN_ID_STRING];
    if (!chainCaps) throw new Error("1Shot relayer does not support Base Mainnet.");
    const token =
      chainCaps.tokens.find((item) => item.address.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase()) ??
      chainCaps.tokens.find((item) => item.symbol?.toUpperCase() === "USDC");
    if (!token) throw new Error("Base USDC is not accepted by the configured relayer.");
    const feeData = await relayerRpc<FeeData>("relayer_getFeeData", {
      chainId: BASE_CHAIN_ID_STRING,
      token: token.address
    });
    oneShotContext = { chainCaps, feeData, decimals: Number(token.decimals) };
  }

  logInfo("rent.collection.started", {
    groupId: group.id,
    billingPeriod,
    residents: group.roommates.length,
    builderCode: attribution.status,
    autonomousAttribution: group.roommates.some((roommate) => roommate.permission?.executionMode === "aa")
      ? attribution.status === "configured"
      : ONE_SHOT_ATTRIBUTION_SUPPORT.supported
  });

  return Promise.all(
    group.roommates.map((roommate) => {
      const executionMode = paymentExecutionMode(roommate);
      const record = createPaymentRecord(group, roommate, billingPeriod, executionMode);
      if (executionMode === "aa") return submitAaPayment({ group, roommate, billingPeriod, record });
      if (!oneShotContext) throw new Error("1Shot execution context was not initialized.");
      return submitRoommatePayment({ group, roommate, billingPeriod, record, ...oneShotContext });
    })
  );
}

export function paymentExecutionMode(roommate: Roommate): "aa" | "one-shot" {
  if (roommate.permission?.executionMode) return roommate.permission.executionMode;
  return roommate.permission ? "one-shot" : config.paymentExecutionMode;
}

export async function refreshTaskStatuses(taskIds: string[]): Promise<PaymentRecord[]> {
  const uniqueTaskIds = [...new Set(taskIds)].slice(0, 100);
  const updates = await Promise.all(
    uniqueTaskIds.map(async (taskId) => {
      const existing = await getPaymentByTaskId(taskId);
      if (!existing) return undefined;
      try {
        if (existing.executionMode === "aa") return refreshAaPayment(existing);
        const status = await getRelayerStatus(taskId);
        const updated = applyStatus(existing, status);
        await savePaymentRecord(updated);
        if (updated.status === "confirmed") {
          logInfo("relayer.payment.confirmed", { groupId: updated.groupId, paymentId: updated.id, taskId });
        }
        return updated;
      } catch (cause) {
        logWarn("relayer.status.unavailable", { groupId: existing.groupId, paymentId: existing.id, taskId });
        return savePaymentRecord({
          ...existing,
          status: existing.status === "preparing" ? "submission_unknown" : existing.status,
          error: cause instanceof Error ? cause.message : "Status check failed",
          failureStage: "status"
        });
      }
    })
  );
  return updates.filter(Boolean) as PaymentRecord[];
}

export async function reconcileRelayerTasks(): Promise<PaymentRecord[]> {
  const payments = await listPaymentsForReconciliation();
  if (payments.length === 0) return [];
  logInfo("payment.reconciliation.started", { payments: payments.length });
  return refreshTaskStatuses(payments.map((payment) => payment.taskId!).filter(Boolean));
}

async function submitRoommatePayment(input: {
  group: RentGroup;
  roommate: Roommate;
  billingPeriod: string;
  record: PaymentRecord;
  chainCaps: Capabilities[string];
  feeData: FeeData;
  decimals: number;
}): Promise<PaymentRecord> {
  const { group, roommate, billingPeriod, chainCaps, feeData, decimals, record } = input;
  const taskId = record.taskId!;
  const reservation = await reservePaymentAttempt(record);
  if (!reservation.claimed) {
    logInfo("payment.idempotent_reuse", { groupId: group.id, paymentId: reservation.payment.id, billingPeriod });
    return reservation.payment;
  }

  let submissionAttempted = false;
  try {
    const permissionError = validatePermissionForPayment(group, roommate, roommate.permission, chainCaps.targetAddress);
    if (permissionError) throw new PaymentStageError("validation", permissionError);
    const permission = roommate.permission as PermissionGrant;
    const shareAtoms = parseUnits(roommate.share, decimals);
    const mockFee = maxBigInt(parseRelayerTokenAmount(feeData.minFee, decimals), parseUnits(config.relayerFeeBufferUsdc, decimals));
    let params = buildSendParams({
      permission,
      landlordAddress: group.landlordAddress,
      tokenAddress: USDC_BASE_ADDRESS,
      feeCollector: feeData.feeCollector ?? chainCaps.feeCollector,
      feeAmount: mockFee,
      rentAmount: shareAtoms
    });

    let estimate = await relayerRpc<EstimateResult>("relayer_estimate7710Transaction", params);
    if (!estimate.success) throw new PaymentStageError("estimate", estimate.error ?? "Relayer estimate failed.");
    const requiredFee = parseRelayerTokenAmount(estimate.requiredPaymentAmount ?? mockFee.toString(), decimals);
    assertPermissionCoversFee(permission, shareAtoms, requiredFee);

    if (requiredFee !== mockFee) {
      params = buildSendParams({
        permission,
        landlordAddress: group.landlordAddress,
        tokenAddress: USDC_BASE_ADDRESS,
        feeCollector: feeData.feeCollector ?? chainCaps.feeCollector,
        feeAmount: requiredFee,
        rentAmount: shareAtoms
      });
      estimate = await relayerRpc<EstimateResult>("relayer_estimate7710Transaction", params);
      if (!estimate.success) throw new PaymentStageError("estimate", estimate.error ?? "Relayer re-estimate failed.");
    }

    const context = estimate.context ?? feeData.context;
    if (!context) throw new PaymentStageError("estimate", "Relayer did not return a signed fee quote context.");
    await savePaymentRecord({
      ...reservation.payment,
      status: "submission_unknown",
      error: "Submission started. Kvara will not retry until the relayer outcome is known.",
      failureStage: "submission"
    });
    submissionAttempted = true;
    const submittedTaskId = await relayerRpc<string>("relayer_send7710Transaction", {
      ...params,
      context,
      taskId,
      memo: record.idempotencyKey,
      ...(config.relayerDelegationSecret ? { delegationSecret: config.relayerDelegationSecret } : {})
    });
    const submitted = await savePaymentRecord({
      ...reservation.payment,
      status: "submitted",
      taskId: submittedTaskId,
      error: undefined,
      failureStage: undefined
    });
    logInfo("relayer.payment.submitted", { groupId: group.id, paymentId: submitted.id, taskId: submittedTaskId, billingPeriod });
    return submitted;
  } catch (cause) {
    if (submissionAttempted) {
      const recovered = await recoverSubmittedPayment(reservation.payment, taskId);
      if (recovered) return recovered;
      return savePaymentRecord({
        ...reservation.payment,
        status: "submission_unknown",
        error: "The relayer submission outcome is unknown. Automatic retry is disabled to prevent a duplicate payment.",
        failureStage: "submission"
      });
    }
    const stage = cause instanceof PaymentStageError ? cause.stage : submissionAttempted ? "submission" : "estimate";
    logError("payment.attempt.failed", cause, { groupId: group.id, paymentId: reservation.payment.id, billingPeriod, stage });
    return savePaymentRecord({
      ...reservation.payment,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Collection failed",
      failureStage: stage
    });
  }
}

function createPaymentRecord(
  group: RentGroup,
  roommate: Roommate,
  billingPeriod: string,
  executionMode: "aa" | "one-shot"
): PaymentRecord {
  const idempotencyKey = paymentIdempotencyKey(group.id, roommate.id, billingPeriod);
  const digest = keccak256(stringToHex(`kvara:${idempotencyKey}`));
  const now = new Date().toISOString();
  return {
    id: `pay_${digest.slice(2)}`,
    groupId: group.id,
    roommateId: roommate.id,
    roommateName: roommate.name,
    walletAddress: roommate.walletAddress,
    amount: roommate.share,
    date: now,
    status: "preparing",
    taskId: executionMode === "one-shot" ? digest : undefined,
    executionMode,
    billingPeriod,
    idempotencyKey,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now
  };
}

async function recoverSubmittedPayment(record: PaymentRecord, taskId: string): Promise<PaymentRecord | null> {
  try {
    const status = await getRelayerStatus(taskId);
    const recovered = applyStatus(record, status);
    await savePaymentRecord(recovered);
    logInfo("relayer.payment.recovered", { groupId: record.groupId, paymentId: record.id, taskId, status: recovered.status });
    return recovered;
  } catch {
    return null;
  }
}

function buildSendParams(input: {
  permission: PermissionGrant;
  landlordAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  feeCollector: `0x${string}`;
  feeAmount: bigint;
  rentAmount: bigint;
}) {
  return {
    chainId: BASE_CHAIN_ID_STRING,
    transactions: [
      {
        permissionContext: input.permission.permissionContext,
        executions: [
          erc20Transfer(input.tokenAddress, input.feeCollector, input.feeAmount),
          erc20Transfer(input.tokenAddress, input.landlordAddress, input.rentAmount)
        ]
      }
    ]
  };
}

function erc20Transfer(tokenAddress: `0x${string}`, recipient: `0x${string}`, amount: bigint): Execution {
  return {
    target: tokenAddress,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] })
  };
}

function assertPermissionCoversFee(permission: PermissionGrant, shareAtoms: bigint, feeAmount: bigint): void {
  const allowance = BigInt(permission.allowanceAtoms);
  const maxFee = allowance > shareAtoms ? allowance - shareAtoms : 0n;
  if (feeAmount > maxFee) {
    throw new PaymentStageError("validation", "Relayer fee exceeds the granted permission buffer. Re-grant permission.");
  }
}

export function applyStatus(record: PaymentRecord, status: RelayerStatus): PaymentRecord {
  if (status.status === 100) return { ...record, status: "pending", error: undefined, failureStage: undefined };
  if (status.status === 110) {
    return {
      ...record,
      status: "submitted",
      txHash: status.hash,
      basescanUrl: status.hash ? `${BASE_EXPLORER_URL}/tx/${status.hash}` : record.basescanUrl,
      error: undefined,
      failureStage: undefined
    };
  }
  if (status.status === 200) {
    const txHash = status.receipt?.transactionHash ?? status.hash ?? record.txHash;
    return {
      ...record,
      status: "confirmed",
      txHash,
      basescanUrl: txHash ? `${BASE_EXPLORER_URL}/tx/${txHash}` : record.basescanUrl,
      error: undefined,
      failureStage: undefined
    };
  }
  if (status.status === 400) {
    return { ...record, status: "rejected", error: status.message ?? "Relayer rejected the task.", failureStage: "submission" };
  }
  return { ...record, status: "failed", error: status.message ?? formatRelayerData(status.data), failureStage: "status" };
}

async function getRelayerStatus(taskId: string): Promise<RelayerStatus> {
  return relayerRpc<RelayerStatus>("relayer_getStatus", { id: taskId, logs: true });
}

async function relayerRpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(config.relayerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000)
  });
  const json = (await response.json().catch(() => ({}))) as { result: T } | { error: { code: number; message: string; data?: unknown } };
  if (!response.ok) throw new Error(`Relayer HTTP ${response.status}`);
  if ("error" in json) throw new Error(`[${json.error.code}] ${json.error.message} ${formatRelayerData(json.error.data)}`.trim());
  return json.result;
}

class PaymentStageError extends Error {
  constructor(readonly stage: NonNullable<PaymentRecord["failureStage"]>, message: string) {
    super(message);
  }
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function parseRelayerTokenAmount(value: string | number | bigint | undefined, decimals: number): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (!text) return 0n;
  if (text.startsWith("0x")) return BigInt(text);
  if (text.includes(".")) return parseUnits(text, decimals);
  return BigInt(text);
}

function formatRelayerData(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Execution reverted.";
  try {
    return JSON.stringify(value);
  } catch {
    return "Execution reverted.";
  }
}
