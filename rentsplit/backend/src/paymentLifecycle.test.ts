import assert from "node:assert/strict";
import test from "node:test";
import { applyAaReceipt } from "./aaExecutor.js";
import { applyStatus, paymentExecutionMode } from "./agent.js";
import { paymentCycleStatus } from "./scheduler.js";
import { claimRentCycle, listPaymentsForReconciliation, reservePaymentAttempt, savePaymentRecord, updateRentCycleStatus } from "./store.js";
import type { PaymentRecord } from "./types.js";

function payment(id: string): PaymentRecord {
  const date = "2026-09-02T00:00:00.000Z";
  return {
    id, groupId: "group-test", roommateId: "roommate-test", roommateName: "Alex",
    walletAddress: "0x0000000000000000000000000000000000000001", amount: "10.00", date,
    status: "preparing", taskId: `task-${id}`, billingPeriod: "2026-09", idempotencyKey: `group-test:roommate-test:${id}`,
    attemptCount: 1, createdAt: date, updatedAt: date
  };
}

test("reserves one logical payment and safely reuses duplicate requests", async () => {
  const record = payment(`idempotency-${Date.now()}`);
  assert.equal((await reservePaymentAttempt(record)).claimed, true);
  const duplicate = await reservePaymentAttempt(record);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.payment.id, record.id);
});

test("never retries a payment whose submission outcome is unknown", async () => {
  const record = { ...payment(`unknown-${Date.now()}`), status: "submission_unknown" as const };
  assert.equal((await reservePaymentAttempt(record)).claimed, true);
  const duplicate = await reservePaymentAttempt(record);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.payment.status, "submission_unknown");
});

test("allows only one worker to hold a rent-cycle lease", async () => {
  const groupId = `lease-${Date.now()}`;
  assert.ok(await claimRentCycle(groupId, "2026-09", 60_000));
  assert.equal(await claimRentCycle(groupId, "2026-09", 60_000), null);
  await updateRentCycleStatus(groupId, "2026-09", "completed");
  assert.equal(await claimRentCycle(groupId, "2026-09", 60_000), null);
});

test("allows a blocked cycle to retry while idempotency preserves successful payments", async () => {
  const groupId = `blocked-${Date.now()}`;
  assert.ok(await claimRentCycle(groupId, "2026-09", 60_000));
  await updateRentCycleStatus(groupId, "2026-09", "blocked");
  assert.ok(await claimRentCycle(groupId, "2026-09", 60_000));
});

test("maps relayer statuses into deterministic payment states and Basescan proof", () => {
  const record = payment("status");
  const submitted = applyStatus(record, { id: "task", chainId: "8453", status: 110, hash: "0x1234" });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.basescanUrl, "https://basescan.org/tx/0x1234");
  const confirmed = applyStatus(submitted, { id: "task", chainId: "8453", status: 200, receipt: { transactionHash: "0xabcd" } });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.txHash, "0xabcd");
});

test("persists submitted tasks for restart reconciliation", async () => {
  const record = { ...payment(`reconcile-${Date.now()}`), status: "submitted" as const };
  await savePaymentRecord(record);
  const pending = await listPaymentsForReconciliation();
  assert.ok(pending.some((item) => item.id === record.id && item.taskId === record.taskId));
});

test("preserves legacy 1Shot permissions while selecting AA for new grants", () => {
  const baseRoommate = {
    id: "roommate-mode", name: "Alex", walletAddress: "0x0000000000000000000000000000000000000001" as const, share: "10.00"
  };
  assert.equal(paymentExecutionMode({ ...baseRoommate, permission: {
    status: "granted", walletAddress: baseRoommate.walletAddress, permissionContext: [{}], rawContext: "0x01",
    allowanceAtoms: "10000000", shareAtoms: "10000000", feeBufferAtoms: "0",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenDecimals: 6,
    relayerTargetAddress: "0x0000000000000000000000000000000000000002", feeCollector: "0x0000000000000000000000000000000000000003",
    grantedAt: 1, expiresAt: 4_000_000_000
  } }), "one-shot");
  assert.equal(paymentExecutionMode({ ...baseRoommate, permission: {
    status: "granted", executionMode: "aa", walletAddress: baseRoommate.walletAddress,
    permissionContext: [{}], rawContext: "0x01", allowanceAtoms: "10000000", shareAtoms: "10000000",
    feeBufferAtoms: "0", tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenDecimals: 6,
    sessionAccountAddress: "0x0000000000000000000000000000000000000004",
    delegationManager: "0x0000000000000000000000000000000000000005", grantedAt: 1, expiresAt: 4_000_000_000
  } }), "aa");
});

test("maps an AA receipt to confirmed Base proof", () => {
  const record = { ...payment("aa-receipt"), executionMode: "aa" as const, userOperationHash: "0x1234" as const };
  const confirmed = applyAaReceipt(record, {
    success: true,
    receipt: { transactionHash: "0xabcdef" }
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.txHash, "0xabcdef");
  assert.equal(confirmed.basescanUrl, "https://basescan.org/tx/0xabcdef");
});

test("keeps a rent cycle processing until every Base payment is confirmed", () => {
  const submitted = { ...payment("cycle-submitted"), status: "submitted" as const };
  assert.equal(paymentCycleStatus([submitted]).cycleStatus, "processing");
  assert.equal(paymentCycleStatus([{ ...submitted, status: "confirmed" }]).cycleStatus, "completed");
  assert.equal(paymentCycleStatus([{ ...submitted, status: "failed" }]).cycleStatus, "blocked");
  assert.equal(paymentCycleStatus([{ ...submitted, status: "submission_unknown" }]).cycleStatus, "processing");
});
