import { Attribution } from "ox/erc8021";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { compileProfileRegistry } from "./compile-profile.mjs";

if (!process.env.AGENT_PRIVATE_KEY || !process.env.BUNDLER_RPC_URL) {
  throw new Error("AGENT_PRIVATE_KEY and BUNDLER_RPC_URL are required.");
}
const builderCode = process.env.BASE_BUILDER_CODE?.trim();
if (!builderCode) throw new Error("BASE_BUILDER_CODE is required.");

const artifact = compileProfileRegistry();
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const transport = http(process.env.BUNDLER_RPC_URL);
const publicClient = createPublicClient({ chain: base, transport });
const walletClient = createWalletClient({ account, chain: base, transport });
const suffix = Attribution.toDataSuffix({ codes: [builderCode] });
const deploymentData = concatHex([artifact.bytecode, suffix]);
const [chainId, balance, nonce, gas] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: account.address }),
  publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
  publicClient.estimateGas({ account: account.address, data: deploymentData }),
]);
if (chainId !== base.id) throw new Error(`Expected Base Mainnet, received chain ${chainId}.`);

console.log(JSON.stringify({
  mode: process.argv.includes("--send") ? "send" : "simulation-only",
  deployer: account.address,
  chainId,
  nonce,
  balanceEth: formatEther(balance),
  estimatedGas: gas.toString(),
  builderCode,
  builderSuffixPresent: deploymentData.toLowerCase().endsWith(suffix.slice(2).toLowerCase()),
}, null, 2));

if (!process.argv.includes("--send")) process.exit(0);

const hash = await walletClient.sendTransaction({ data: deploymentData, gas });
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`Profile registry deployment failed: ${hash}`);
}
const [code, transaction] = await Promise.all([
  publicClient.getCode({ address: receipt.contractAddress }),
  publicClient.getTransaction({ hash }),
]);
console.log(JSON.stringify({
  transactionHash: hash,
  contractAddress: receipt.contractAddress,
  blockNumber: receipt.blockNumber.toString(),
  gasUsed: receipt.gasUsed.toString(),
  deployed: Boolean(code && code !== "0x"),
  builderSuffixOnTransaction: transaction.input.toLowerCase().endsWith(suffix.slice(2).toLowerCase()),
  baseScanUrl: `https://basescan.org/tx/${hash}`,
}, null, 2));
