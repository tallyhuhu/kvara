import assert from "node:assert/strict";
import test from "node:test";
import { appendBuilderAttribution, getBuilderAttribution, ONE_SHOT_ATTRIBUTION_SUPPORT } from "./baseAttribution.js";

test("omits attribution when no Builder Code is configured", () => {
  assert.deepEqual(getBuilderAttribution(""), { status: "absent" });
  assert.equal(appendBuilderAttribution("0x1234", ""), "0x1234");
});

test("encodes a configured Builder Code as an ERC-8021 suffix", () => {
  const result = getBuilderAttribution("kvara");
  assert.equal(result.status, "configured");
  if (result.status === "configured") {
    assert.ok(result.dataSuffix.startsWith("0x"));
    assert.notEqual(appendBuilderAttribution("0x1234", "kvara"), "0x1234");
  }
});

test("rejects malformed Builder Codes without producing bytes", () => {
  assert.equal(getBuilderAttribution("bad,code").status, "invalid");
  assert.equal(getBuilderAttribution("x".repeat(65)).status, "invalid");
  assert.equal(appendBuilderAttribution("0x1234", "bad,code"), "0x1234");
});

test("does not claim unsupported 1Shot outer transaction attribution", () => {
  assert.equal(ONE_SHOT_ATTRIBUTION_SUPPORT.supported, false);
  assert.match(ONE_SHOT_ATTRIBUTION_SUPPORT.reason, /does not accept a dataSuffix/);
});
