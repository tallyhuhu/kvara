import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from "viem";
import { buildProof, type ProofCandidate, type ProofReader } from "./proof.js";
import { USDC_BASE_ADDRESS } from "./config.js";
import { closeGroup, createGroup, loadProofSnapshot, savePaymentRecord } from "./store.js";
import type { PaymentRecord } from "./types.js";

const from = "0x0000000000000000000000000000000000000001";
const to = "0x0000000000000000000000000000000000000002";
const hash = `0x${"ab".repeat(32)}` as const;
const blockHash = `0x${"cd".repeat(32)}`;
const candidate: ProofCandidate = { txHash: hash, wallet: from, recipient: to, amount: "0.061667" };
const log = { address: USDC_BASE_ADDRESS, logIndex: 1,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as `0x${string}`[],
  data: encodeAbiParameters([{ type: "uint256" }], [61667n]) };
const receipt = { status: "success", blockNumber: 10n, blockHash, logs: [log] };
const rpc: ProofReader = { chainId: async () => 8453, finalized: async () => 12n,
  receipt: async () => receipt, block: async () => ({ hash: blockHash, timestamp: 1700000000n }) };

test("proof counts unique physical transfers and exact USDC atoms", async () => {
  const result = await buildProof({ households: 2, candidates: 2, payments: [candidate, candidate] }, rpc);
  assert.deepEqual(result.metrics, { households: 2, payingWallets: 1, payments: 1, settledUsdc: "0.061667", transactions: 1 });
  assert.equal(result.recent[0].basescanUrl, `https://basescan.org/tx/${hash}`);
  const publicJson = JSON.stringify(result);
  assert.ok(!publicJson.includes(from));
  assert.ok(!publicJson.includes(to));
  assert.ok(!publicJson.includes("permission"));
});

test("proof excludes wrong token, amount, recipient, failed and unfinalized receipts", async () => {
  const variations = [
    { ...receipt, status: "reverted" }, { ...receipt, blockNumber: 13n },
    { ...receipt, logs: [{ ...log, address: from }] },
    { ...receipt, logs: [{ ...log, data: encodeAbiParameters([{ type: "uint256" }], [1n]) }] },
    { ...receipt, logs: [{ ...log, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: to, to: from } }) as `0x${string}`[] }] },
    { ...receipt, blockHash: "0x00" }
  ];
  for (const value of variations) {
    const result = await buildProof({ households: 0, candidates: 1, payments: [candidate] }, { ...rpc, receipt: async () => value });
    assert.equal(result.metrics.settledUsdc, "0"); assert.equal(result.recent.length, 0);
  }
});

test("proof distinguishes two transfers in one Base transaction", async () => {
  const other = { ...candidate, wallet: to, recipient: from, amount: "0.038333" };
  const result = await buildProof({ households: 1, candidates: 2, payments: [candidate, other] }, {
    ...rpc, receipt: async () => ({ ...receipt, logs: [log, { ...log, logIndex: 2,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: to, to: from } }) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint256" }], [38333n]) }] })
  });
  assert.equal(result.metrics.settledUsdc, "0.1");
  assert.equal(result.metrics.payments, 2); assert.equal(result.metrics.transactions, 1);
});

test("zero activity is zero; RPC failure is not zero", async () => {
  const empty = { households: 0, candidates: 0, payments: [] };
  assert.equal((await buildProof(empty, rpc)).metrics.payments, 0);
  await assert.rejects(buildProof(empty, { ...rpc, chainId: async () => 1 }), /Base Mainnet/);
  await assert.rejects(buildProof({ ...empty, payments: [candidate] }, { ...rpc, receipt: async () => { throw new Error("RPC offline"); } }), /RPC offline/);
});

test("canonical store projection includes closed households and only confirmed candidates", async () => {
  const home = await createGroup({ id: "proof-private-home", propertyName: "PRIVATE NAME", propertyAddress: "PRIVATE ADDRESS",
    landlordAddress: to, totalRent: "0.061667", roommates: [{ id: "resident", name: "PRIVATE RESIDENT", walletAddress: from, share: "0.061667" }], createdAt: 1, updatedAt: 1 });
  const record: PaymentRecord = { id: "proof-confirmed", groupId: home.id, roommateId: "resident", roommateName: "PRIVATE RESIDENT",
    walletAddress: from, amount: candidate.amount, date: "2026-09-09", status: "confirmed", txHash: hash,
    billingPeriod: "2026-09", idempotencyKey: "proof-confirmed", attemptCount: 1, createdAt: "2026-09-09", updatedAt: "2026-09-09" };
  await savePaymentRecord(record);
  await savePaymentRecord({ ...record, id: "proof-failed", status: "failed", taskId: undefined });
  await closeGroup(home.id);
  const snapshot = await loadProofSnapshot();
  assert.equal(snapshot.households, 1); assert.equal(snapshot.candidates, 1);
  assert.deepEqual(snapshot.payments, [candidate]);
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
});
