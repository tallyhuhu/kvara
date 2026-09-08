import assert from "node:assert/strict";
import test from "node:test";
import { advanceGroupSchedule, closeGroup, createGroup, getGroup, GroupChangedError, reservePaymentAttempt, saveGroup, saveGroupIfUnchanged } from "./store.js";
import { isGroupAdmin, validateGroupForSave } from "./domain.js";
import type { PaymentRecord, RentGroup } from "./types.js";
import { runVeniceAgent } from "./veniceAgent.js";

function group(id: string): RentGroup {
  return validateGroupForSave({ id, propertyName: "Maple House", propertyAddress: "24 Maple St", totalRent: "1",
    adminWalletAddress: "0x0000000000000000000000000000000000000001",
    landlordAddress: "0x0000000000000000000000000000000000000001",
    roommates: [{ id: "resident", name: "Maya", walletAddress: "0x0000000000000000000000000000000000000002", share: "1" }],
    dueDay: 1, rentRunTime: "09:00", nextRunAt: "2099-01-01T09:00:00Z", autopayEnabled: true,
    permissionBufferPercent: 30, createdAt: 1, updatedAt: 1 });
}

test("a landlord may manage a household without being charged as a resident", () => {
  const home = group("landlord");
  assert.equal(home.roommates.length, 1);
  assert.ok(isGroupAdmin(home, home.landlordAddress));
  assert.notEqual(home.roommates[0].walletAddress, home.landlordAddress);
});

test("late chat or permission updates cannot overwrite a changed or closed lease", async () => {
  const home = await createGroup(group("late-chat"));
  const edited = await saveGroupIfUnchanged(home, { ...home, propertyName: "New name" });
  await assert.rejects(saveGroupIfUnchanged(home, { ...home, propertyName: "Stale name" }), GroupChangedError);
  await closeGroup(home.id);
  await assert.rejects(saveGroupIfUnchanged(edited, { ...edited, autopayEnabled: true }), GroupChangedError);
  const closed = await getGroup(home.id);
  assert.equal(closed?.propertyName, "New name");
  assert.equal(closed?.autopayEnabled, false);
  assert.ok(closed?.closedAt);
});

test("schedule advancement preserves concurrent household edits and never reopens a closed lease", async () => {
  const home = await createGroup(group("schedule-isolation"));
  await saveGroup({ ...home, propertyName: "Updated home" });
  assert.equal(await advanceGroupSchedule(home.id, home.nextRunAt, "2099-02-01T09:00:00Z"), true);
  assert.equal((await getGroup(home.id))?.propertyName, "Updated home");
  assert.equal(await advanceGroupSchedule(home.id, home.nextRunAt, "2099-03-01T09:00:00Z"), false);
  await closeGroup(home.id);
  assert.equal(await advanceGroupSchedule(home.id, "2099-02-01T09:00:00Z", "2099-03-01T09:00:00Z"), false);
  assert.ok((await getGroup(home.id))?.closedAt);
});

test("retrying a known failure records the revised amount and clears old AA transaction proof", async () => {
  const record: PaymentRecord = {
    id: "retry-updated-share", groupId: "home", roommateId: "resident", roommateName: "Maya",
    walletAddress: "0x0000000000000000000000000000000000000002", amount: "1", date: new Date().toISOString(),
    status: "failed", executionMode: "aa", taskId: "old-operation", txHash: "0x01", basescanUrl: "https://basescan.org/tx/0x01",
    billingPeriod: "2026-09", idempotencyKey: "home:resident:2026-09", attemptCount: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await reservePaymentAttempt(record);
  const retry = await reservePaymentAttempt({ ...record, amount: "0.75", status: "preparing" });
  assert.ok(retry.claimed);
  assert.equal(retry.payment.amount, "0.75");
  assert.equal(retry.payment.attemptCount, 2);
  assert.equal(retry.payment.taskId, undefined);
  assert.equal(retry.payment.txHash, undefined);
  assert.equal(retry.payment.basescanUrl, undefined);
});

test("Venice receives follow-up context and the authoritative current household", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = "test-only";
  let request: { messages: Array<{ role: string; content: string }> } | undefined;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: "Please confirm which resident.", commands: [] }) } }] }), { status: 200 });
  };
  try {
    const home = group("venice-context");
    const conversation = [{ role: "user" as const, content: "Maya is away" }, { role: "assistant" as const, content: "For how long?" }];
    await runVeniceAgent({ message: "Two weeks", group: home, history: [], conversation });
    assert.deepEqual(request?.messages.slice(1, 3), conversation);
    const current = JSON.parse(request!.messages.at(-1)!.content);
    assert.equal(current.request, "Two weeks");
    assert.equal(current.household.id, home.id);
    assert.equal(current.household.roommates[0].share, home.roommates[0].share);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
  }
});
