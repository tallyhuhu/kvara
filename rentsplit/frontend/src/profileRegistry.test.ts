import assert from "node:assert/strict";
import test from "node:test";
import { appendFrontendBuilderAttribution, getFrontendBuilderDataSuffix } from "./lib/baseAttribution.js";
import { profileRoleFromChain, profileRoleToChain } from "./lib/profileRegistry.js";

test("maps every Kvara profile role to its onchain value", () => {
  assert.equal(profileRoleToChain("resident"), 1);
  assert.equal(profileRoleToChain("landlord"), 2);
  assert.equal(profileRoleToChain("both"), 3);
  assert.equal(profileRoleFromChain(0), null);
  assert.equal(profileRoleFromChain(1), "resident");
  assert.equal(profileRoleFromChain(2), "landlord");
  assert.equal(profileRoleFromChain(3), "both");
  assert.equal(profileRoleFromChain(4), null);
});

test("appends the registered Builder Code suffix to profile calldata", () => {
  const suffix = getFrontendBuilderDataSuffix("bc_p5fkvcvx");
  assert.ok(suffix);
  const attributed = appendFrontendBuilderAttribution("0x1234", "bc_p5fkvcvx");
  assert.equal(attributed, `0x1234${suffix.slice(2)}`);
});
