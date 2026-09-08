import assert from "node:assert/strict";
import test from "node:test";
import { allocateRent, nextRentSchedule, paymentErrorText, permissionCoversShare } from "./lib/workspaceModel.js";
import type { Roommate } from "./lib/groupStorage.js";

test("a recalculated share above the cap needs a new permission", () => {
  const roommate = { share: "1", permission: { tokenDecimals: 6, feeBufferAtoms: "10000", allowanceAtoms: "1010000" } } as Roommate;
  assert.equal(permissionCoversShare(roommate), true);
  assert.equal(permissionCoversShare({ ...roommate, share: "1.01" }), false);
  assert.equal(permissionCoversShare({ ...roommate, permission: undefined }), false);
  assert.equal(permissionCoversShare({ ...roommate, share: "invalid" }), false);
});

test("first rent day uses the same UTC clock as recurring backend payments", () => {
  assert.equal(nextRentSchedule(1, "09:00", new Date("2026-09-01T09:00:00+07:00")).nextRunAt, "2026-09-01T09:00:00.000Z");
  assert.equal(nextRentSchedule(1, "09:00", new Date("2026-12-01T09:00:00Z")).nextRunAt, "2027-01-01T09:00:00.000Z");
  assert.throws(() => nextRentSchedule(29, "09:00"));
  assert.throws(() => nextRentSchedule(1, "25:00"));
});

test("automatic shares divide only the remainder after custom shares", () => {
  assert.deepEqual(allocateRent("1", ["0.4", "", undefined]), ["0.4", "0.3", "0.3"]);
  assert.deepEqual(allocateRent("0.000005", ["", ""]), ["0.000003", "0.000002"]);
  assert.deepEqual(allocateRent("1", ["0", ""]), ["0", "1"]);
  assert.throws(() => allocateRent("1", ["2", ""]));
  assert.throws(() => allocateRent("1", ["0.4", "0.4"]));
});

test("does not misdiagnose gas failures or reverted permissions as low USDC", () => {
  assert.equal(paymentErrorText("AA21 insufficient prefund"), "AA21 insufficient prefund");
  assert.equal(paymentErrorText("execution reverted: permission revoked"), "execution reverted: permission revoked");
});
