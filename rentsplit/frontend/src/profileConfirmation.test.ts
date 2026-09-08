import assert from "node:assert/strict";
import test from "node:test";
import { readConfirmedProfile } from "./lib/profileConfirmation.js";

test("retries lagging RPC reads at the confirmed block instead of the latest head", async () => {
  const blocks: bigint[] = [];
  let attempts = 0;
  const role = await readConfirmedProfile(async (block) => {
    blocks.push(block);
    attempts++;
    if (attempts === 1) throw new Error("Block not found yet");
    if (attempts === 2) return null;
    return "resident";
  }, 123n, async () => {});
  assert.equal(role, "resident");
  assert.deepEqual(blocks, [123n, 123n, 123n]);
});

test("never treats a successful receipt alone as a saved profile", async () => {
  let reads = 0;
  await assert.rejects(readConfirmedProfile(async () => { reads++; return null; }, 123n, async () => {}), /Check confirmation/);
  assert.equal(reads, 6);
});
