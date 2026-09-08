import assert from "node:assert/strict";
import test from "node:test";
import { isAmbiguousAaSubmissionError } from "./aaExecutor.js";

test("treats bundler simulation and RPC rejections as known failures", () => {
  assert.equal(isAmbiguousAaSubmissionError(new Error("validation reverted: AA13 initCode failed or OOG")), false);
  assert.equal(isAmbiguousAaSubmissionError(new Error("Execution reverted: ERC20 transfer amount exceeds balance")), false);
});

test("keeps transport failures in review to prevent duplicate payments", () => {
  const timeout = new Error("Request timed out after submission");
  timeout.name = "TimeoutError";
  assert.equal(isAmbiguousAaSubmissionError(timeout), true);

  const wrapped = new Error("Bundler request failed", { cause: new TypeError("fetch failed") });
  assert.equal(isAmbiguousAaSubmissionError(wrapped), true);
});
