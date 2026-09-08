import { Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { erc7710BundlerActions } from "@metamask/smart-accounts-kit/actions";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient } from "viem/account-abstraction";
import { base } from "viem/chains";
import { getBuilderAttribution } from "./baseAttribution.js";
import { BASE_EXPLORER_URL, BASE_RPC_URL, USDC_BASE_ADDRESS, config } from "./config.js";
import { validatePermissionForPayment } from "./domain.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { reservePaymentAttempt, savePaymentRecord } from "./store.js";
import type { PaymentRecord, PermissionGrant, RentGroup, Roommate } from "./types.js";

type AaContext = Awaited<ReturnType<typeof createAaContext>>;
const FIRST_DEPLOYMENT_VERIFICATION_GAS_LIMIT = 600_000n;

export type AaOperationReceipt = {
  success: boolean;
  reason?: string;
  receipt: { transactionHash: `0x${string}` };
};

let aaContextPromise: Promise<AaContext> | undefined;

export async function getAaExecutorInfo(): Promise<{
  configured: boolean;
  address?: `0x${string}`;
  paymasterEnabled: boolean;
}> {
  if (!config.agentPrivateKey || !config.bundlerRpcUrl) {
    return { configured: false, paymasterEnabled: config.aaPaymasterEnabled };
  }
  const { sessionAccount } = await getAaContext();
  return { configured: true, address: sessionAccount.address, paymasterEnabled: config.aaPaymasterEnabled };
}

export async function submitAaPayment(input: {
  group: RentGroup;
  roommate: Roommate;
  billingPeriod: string;
  record: PaymentRecord;
}): Promise<PaymentRecord> {
  const { group, roommate, billingPeriod, record } = input;
  const reservation = await reservePaymentAttempt(record);
  if (!reservation.claimed) {
    logInfo("payment.idempotent_reuse", { groupId: group.id, paymentId: reservation.payment.id, billingPeriod });
    return reservation.payment;
  }

  let submissionStarted = false;
  try {
    const { publicClient, sessionAccount, bundlerClient } = await getAaContext();
    const permissionError = validatePermissionForPayment(group, roommate, roommate.permission, sessionAccount.address);
    if (permissionError) throw new AaPaymentError("validation", permissionError);

    const permission = roommate.permission as PermissionGrant;
    if (permission.executionMode !== "aa") {
      throw new AaPaymentError("validation", "Permission was not granted to the Kvara smart account.");
    }
    if (!permission.delegationManager || !permission.rawContext.startsWith("0x")) {
      throw new AaPaymentError("validation", "Permission is missing its delegation redemption data. Re-grant permission.");
    }

    const amount = parseUnits(roommate.share, permission.tokenDecimals);
    await savePaymentRecord({
      ...reservation.payment,
      status: "submission_unknown",
      executionMode: "aa",
      error: "Submission started. Kvara will not retry until the operation outcome is known.",
      failureStage: "submission"
    });
    submissionStarted = true;
    const verificationGasLimit = (await sessionAccount.isDeployed())
      ? undefined
      : FIRST_DEPLOYMENT_VERIFICATION_GAS_LIMIT;
    const userOperationHash = await bundlerClient.sendUserOperationWithDelegation({
      publicClient: publicClient as never,
      account: sessionAccount,
      calls: [{
        to: USDC_BASE_ADDRESS,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [group.landlordAddress, amount] }),
        permissionContext: permission.rawContext as Hex,
        delegationManager: permission.delegationManager
      }],
      dependencies: permission.dependencies,
      ...(verificationGasLimit ? { verificationGasLimit } : {})
    });

    const submitted = await savePaymentRecord({
      ...reservation.payment,
      status: "submitted",
      taskId: userOperationHash,
      userOperationHash,
      executionMode: "aa",
      error: undefined,
      failureStage: undefined
    });
    logInfo("aa.payment.submitted", {
      groupId: group.id,
      paymentId: submitted.id,
      userOperationHash,
      billingPeriod,
      paymasterEnabled: config.aaPaymasterEnabled,
      builderAttribution: getBuilderAttribution(config.baseBuilderCode).status
    });
    return submitted;
  } catch (cause) {
    const stage = cause instanceof AaPaymentError ? cause.stage : submissionStarted ? "submission" : "estimate";
    const submissionOutcomeUnknown = submissionStarted && isAmbiguousAaSubmissionError(cause);
    logError("aa.payment.failed", cause, { groupId: group.id, paymentId: reservation.payment.id, billingPeriod, stage });
    return savePaymentRecord({
      ...reservation.payment,
      executionMode: "aa",
      status: submissionOutcomeUnknown ? "submission_unknown" : "failed",
      error: submissionOutcomeUnknown
        ? "The smart-account submission outcome is unknown. Automatic retry is disabled to prevent a duplicate payment."
        : cause instanceof Error ? cause.message : "Smart-account execution failed.",
      failureStage: stage
    });
  }
}

export async function refreshAaPayment(record: PaymentRecord): Promise<PaymentRecord> {
  const userOperationHash = record.userOperationHash ?? record.taskId;
  if (!userOperationHash?.startsWith("0x")) return record;

  try {
    const { bundlerClient } = await getAaContext();
    const operation = await bundlerClient.getUserOperationReceipt({ hash: userOperationHash as Hex });
    const updated = await savePaymentRecord(applyAaReceipt(record, operation));
    if (operation.success) {
      logInfo("aa.payment.confirmed", { groupId: record.groupId, paymentId: record.id, userOperationHash, txHash: updated.txHash });
    }
    return updated;
  } catch (cause) {
    if (isReceiptPending(cause)) {
      return savePaymentRecord({ ...record, status: "pending", error: undefined, failureStage: undefined });
    }
    logWarn("aa.status.unavailable", { groupId: record.groupId, paymentId: record.id, userOperationHash });
    return savePaymentRecord({
      ...record,
      status: record.status === "preparing" ? "pending" : record.status,
      error: cause instanceof Error ? cause.message : "User operation status check failed.",
      failureStage: "status"
    });
  }
}

export function applyAaReceipt(record: PaymentRecord, operation: AaOperationReceipt): PaymentRecord {
  const txHash = operation.receipt.transactionHash;
  return {
    ...record,
    status: operation.success ? "confirmed" : "failed",
    txHash,
    basescanUrl: `${BASE_EXPLORER_URL}/tx/${txHash}`,
    error: operation.success ? undefined : operation.reason ?? "User operation reverted.",
    failureStage: operation.success ? undefined : "status"
  };
}

async function getAaContext(): Promise<AaContext> {
  aaContextPromise ??= createAaContext();
  return aaContextPromise;
}

async function createAaContext() {
  if (!config.agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is required for AA execution.");
  if (!config.bundlerRpcUrl) throw new Error("BUNDLER_RPC_URL is required for AA execution.");

  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });
  const owner = privateKeyToAccount(config.agentPrivateKey);
  const sessionAccount = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: "0x",
    signer: { account: owner }
  });
  const attribution = getBuilderAttribution(config.baseBuilderCode);
  const bundlerClient = createBundlerClient({
    account: sessionAccount,
    chain: base,
    client: publicClient,
    transport: http(config.bundlerRpcUrl),
    ...(config.aaPaymasterEnabled ? { paymaster: true as const } : {}),
    ...(attribution.status === "configured" ? { dataSuffix: attribution.dataSuffix } : {})
  }).extend(erc7710BundlerActions());

  logInfo("aa.executor.ready", {
    address: sessionAccount.address,
    paymasterEnabled: config.aaPaymasterEnabled,
    builderAttribution: attribution.status
  });
  return { publicClient, sessionAccount, bundlerClient };
}

function isReceiptPending(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name.includes("UserOperationReceiptNotFound") || /not found|could not be found/i.test(cause.message);
}

export function isAmbiguousAaSubmissionError(cause: unknown): boolean {
  const errors: Error[] = [];
  let current = cause;
  while (current instanceof Error && !errors.includes(current)) {
    errors.push(current);
    current = current.cause;
  }

  return errors.some((error) =>
    /HttpRequestError|TimeoutError|AbortError/i.test(error.name) ||
    /fetch failed|timed? out|timeout|ECONNRESET|ECONNABORTED|socket hang up|connection (?:was )?closed|network request failed/i.test(error.message)
  );
}

class AaPaymentError extends Error {
  constructor(readonly stage: NonNullable<PaymentRecord["failureStage"]>, message: string) {
    super(message);
  }
}
