import assert from "node:assert/strict";
import test from "node:test";
import { applyRentCommands, billingPeriodFor, isGroupAdmin, isGroupMember, nextMonthlyRun, validateGroupForSave, validatePermissionForPayment } from "./domain.js";
import { RENT_PERIOD_SECONDS, USDC_BASE_ADDRESS } from "./config.js";
import type { PermissionGrant, RentGroup } from "./types.js";

const admin = "0x0000000000000000000000000000000000000001" as const;
const roommate = "0x0000000000000000000000000000000000000002" as const;
const landlord = "0x0000000000000000000000000000000000000003" as const;
const relayer = "0x0000000000000000000000000000000000000004" as const;

function group(): RentGroup {
  return {
    id: "group-1", adminWalletAddress: admin, propertyName: "No. 45", propertyAddress: "45 Main St",
    landlordAddress: landlord, totalRent: "100.00", dueDay: 1, rentRunTime: "09:00",
    autopayEnabled: true, permissionBufferPercent: 30,
    roommates: [
      { id: "a", name: "Alex", walletAddress: admin, share: "50.00" },
      { id: "b", name: "Maya", walletAddress: roommate, share: "50.00" }
    ],
    createdAt: 1, updatedAt: 1
  };
}

test("validates exact USDC shares and rejects an unbalanced household", () => {
  assert.equal(validateGroupForSave(group()).totalRent, "100.00");
  assert.throws(() => validateGroupForSave({ ...group(), roommates: [
    { id: "a", name: "Alex", walletAddress: admin, share: "50.00" },
    { id: "b", name: "Maya", walletAddress: roommate, share: "49.99" }
  ] }), /must equal/);
});

test("rejects duplicate resident identifiers used by payment idempotency", () => {
  assert.throws(() => validateGroupForSave({
    ...group(),
    roommates: group().roommates.map((item) => ({ ...item, id: "same-id" }))
  }), /identifiers must be unique/);
});

test("applies only a complete split that preserves total rent", () => {
  const updated = applyRentCommands(group(), [{ type: "set_splits", splits: [
    { roommateId: "a", share: "60.00" }, { roommateId: "b", share: "40.00" }
  ] }]);
  assert.deepEqual(updated.roommates.map((item) => item.share), ["60.00", "40.00"]);
  assert.throws(() => applyRentCommands(group(), [{ type: "set_splits", splits: [{ roommateId: "a", share: "100.00" }] }]), /every current resident/);
});

test("authorizes only household members and the configured admin", () => {
  assert.equal(isGroupAdmin(group(), admin), true);
  assert.equal(isGroupAdmin(group(), roommate), false);
  assert.equal(isGroupMember(group(), roommate), true);
  assert.equal(isGroupMember(group(), landlord), false);
});

test("calculates the next UTC monthly run deterministically", () => {
  assert.equal(nextMonthlyRun(15, new Date("2026-09-02T10:00:00Z"), "09:30").toISOString(), "2026-09-15T09:30:00.000Z");
  assert.equal(nextMonthlyRun(1, new Date("2026-09-02T10:00:00Z"), "09:30").toISOString(), "2026-10-01T09:30:00.000Z");
  assert.equal(billingPeriodFor(new Date("2026-09-30T23:59:00Z")), "2026-09");
});

test("rejects permissions whose policy snapshot no longer matches", () => {
  const permission: PermissionGrant = {
    status: "granted", walletAddress: admin, permissionContext: [{}], rawContext: "0x01",
    allowanceAtoms: "80000000", shareAtoms: "50000000", adjustmentBufferAtoms: "25000000",
    adjustmentBufferPercent: 50, feeBufferAtoms: "5000000", tokenAddress: USDC_BASE_ADDRESS,
    tokenDecimals: 6, relayerTargetAddress: relayer, feeCollector: relayer,
    grantedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 1000,
    landlordAddress: landlord, periodSeconds: RENT_PERIOD_SECONDS
  };
  assert.equal(validatePermissionForPayment(group(), group().roommates[0], permission, relayer), undefined);
  assert.match(validatePermissionForPayment({ ...group(), landlordAddress: roommate }, group().roommates[0], permission, relayer) ?? "", /Landlord changed/);
  assert.match(validatePermissionForPayment(group(), { ...group().roommates[0], share: "90.00" }, permission, relayer) ?? "", /exceeds/);
});

test("rejects expired, wrong-wallet, wrong-token, wrong-target, and wrong-period permissions", () => {
  const permission: PermissionGrant = {
    status: "granted", walletAddress: admin, permissionContext: [{}], rawContext: "0x01",
    allowanceAtoms: "80000000", shareAtoms: "50000000", feeBufferAtoms: "5000000",
    tokenAddress: USDC_BASE_ADDRESS, tokenDecimals: 6, relayerTargetAddress: relayer,
    feeCollector: relayer, grantedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 1000,
    landlordAddress: landlord, periodSeconds: RENT_PERIOD_SECONDS
  };
  const resident = group().roommates[0];

  assert.match(validatePermissionForPayment(group(), resident, { ...permission, expiresAt: 1 }, relayer) ?? "", /expired/);
  assert.match(validatePermissionForPayment(group(), resident, { ...permission, walletAddress: roommate }, relayer) ?? "", /wallet/);
  assert.match(validatePermissionForPayment(group(), resident, { ...permission, tokenAddress: roommate }, relayer) ?? "", /Base USDC/);
  assert.match(validatePermissionForPayment(group(), resident, permission, roommate) ?? "", /different execution account/);
  assert.match(validatePermissionForPayment(group(), resident, { ...permission, periodSeconds: RENT_PERIOD_SECONDS - 1 }, relayer) ?? "", /period/);
});
