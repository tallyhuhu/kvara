import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http, isAddress, parseUnits } from "viem";
import { base } from "viem/chains";
import { BASE_RPC_URL, USDC_BASE_ADDRESS, config } from "./config.js";
import { getBuilderAttribution } from "./baseAttribution.js";
import { loadProofSnapshot } from "./store.js";

export type ProofCandidate = { txHash: string; wallet: string; recipient: string; amount: string };
export type ProofSnapshot = { households: number; candidates: number; payments: ProofCandidate[] };
type EvidenceReceipt = {
  status: string; blockNumber: bigint; blockHash: string;
  logs: Array<{ address: string; data: `0x${string}`; topics: readonly `0x${string}`[]; logIndex: number | null }>;
};
export type ProofReader = {
  chainId(): Promise<number>;
  finalized(): Promise<bigint>;
  receipt(hash: `0x${string}`): Promise<EvidenceReceipt>;
  block(number: bigint): Promise<{ hash: string | null; timestamp: bigint }>;
};

const client = createPublicClient({ chain: base, transport: http(BASE_RPC_URL, { timeout: 8000, retryCount: 1 }) });
const reader: ProofReader = {
  chainId: () => client.getChainId(),
  finalized: async () => (await client.getBlock({ blockTag: "finalized" })).number,
  receipt: (hash) => client.getTransactionReceipt({ hash }),
  block: (blockNumber) => client.getBlock({ blockNumber })
};

export async function buildProof(snapshot: ProofSnapshot, rpc: ProofReader, now = new Date()) {
  if (await rpc.chainId() !== 8453) throw new Error("Proof RPC must use Base Mainnet.");
  const finalized = await rpc.finalized();
  const receipts = new Map<string, Promise<EvidenceReceipt>>();
  const blocks = new Map<bigint, Promise<{ hash: string | null; timestamp: bigint }>>();
  const seen = new Set<string>();
  const payers = new Set<string>();
  const transactions = new Set<string>();
  const evidence: Array<{ txHash: string; logIndex: number; amount: string; timestamp: string; basescanUrl: string; status: "confirmed" }> = [];
  let atoms = 0n;
  let cursor = 0;
  const deadline = Date.now() + 20_000;
  let stopped = false;
  async function worker() {
    try {
    while (!stopped && cursor < snapshot.payments.length) {
      if (Date.now() > deadline) throw new Error("Proof verification timed out.");
      const payment = snapshot.payments[cursor++];
      if (typeof payment.txHash !== "string" || typeof payment.wallet !== "string" || typeof payment.recipient !== "string" || typeof payment.amount !== "string"
        || !/^0x[0-9a-fA-F]{64}$/.test(payment.txHash) || !isAddress(payment.wallet) || !isAddress(payment.recipient)
        || !/^\d+(?:\.\d{1,6})?$/.test(payment.amount)) continue;
      const amount = parseUnits(payment.amount, 6);
      if (amount <= 0n) continue;
      const hash = payment.txHash.toLowerCase() as `0x${string}`;
      let receiptPromise = receipts.get(hash);
      if (!receiptPromise) { receiptPromise = rpc.receipt(hash); receipts.set(hash, receiptPromise); }
      // RPC failure invalidates this refresh, rather than silently reporting a smaller total.
      const receipt = await receiptPromise;
      if (receipt.status !== "success" || receipt.blockNumber > finalized) continue;
      let blockPromise = blocks.get(receipt.blockNumber);
      if (!blockPromise) { blockPromise = rpc.block(receipt.blockNumber); blocks.set(receipt.blockNumber, blockPromise); }
      const block = await blockPromise;
      if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) continue;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase() || log.logIndex === null) continue;
        let transfer;
        try { transfer = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] }); }
        catch { continue; }
        if (transfer.args.from.toLowerCase() !== payment.wallet.toLowerCase()
          || transfer.args.to.toLowerCase() !== payment.recipient.toLowerCase() || transfer.args.value !== amount) continue;
        const key = `${hash}:${log.logIndex}`;
        // One physical transfer is counted once, even if the database contains duplicate records.
        if (!seen.has(key)) {
          seen.add(key); payers.add(payment.wallet.toLowerCase()); transactions.add(hash); atoms += amount;
          evidence.push({ txHash: hash, logIndex: log.logIndex, amount: formatUnits(amount, 6),
            timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
            basescanUrl: `https://basescan.org/tx/${hash}`, status: "confirmed" });
        }
        break;
      }
    }
    } catch (cause) { stopped = true; throw cause; }
  }
  const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const attribution = getBuilderAttribution(config.baseBuilderCode);
  return {
    chainId: 8453, updatedAt: now.toISOString(),
    metrics: { households: snapshot.households, payingWallets: payers.size, payments: evidence.length,
      settledUsdc: formatUnits(atoms, 6), transactions: transactions.size },
    coverage: { candidateRecords: snapshot.candidates, checkedRecords: snapshot.payments.length,
      limited: snapshot.candidates > snapshot.payments.length, finality: "finalized" },
    recent: evidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.txHash.localeCompare(b.txHash) || a.logIndex - b.logIndex).slice(0, 12),
    attribution: { status: attribution.status, code: attribution.code ?? null },
    addresses: { usdc: USDC_BASE_ADDRESS }
  };
}

type Proof = Awaited<ReturnType<typeof buildProof>>;
let cached: { value: Proof; expires: number } | undefined;
let inFlight: Promise<Proof> | undefined;
let retryAfter = 0;
export async function getPublicProof(): Promise<Proof> {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (Date.now() < retryAfter) throw new Error("Proof refresh is cooling down.");
  if (!inFlight) {
    inFlight = loadProofSnapshot().then((snapshot) => buildProof(snapshot, reader)).then((value) => {
      cached = { value, expires: Date.now() + 60_000 };
      return value;
    }).catch((cause) => { retryAfter = Date.now() + 15_000; throw cause; }).finally(() => { inFlight = undefined; });
  }
  return inFlight;
}
