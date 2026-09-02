import { randomBytes } from "node:crypto";

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_STRING = String(BASE_CHAIN_ID);
export const BASE_EXPLORER_URL = "https://basescan.org";
export const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_DECIMALS = 6;
export const RENT_PERIOD_SECONDS = 2_592_000;

export type PaymentExecutionMode = "aa" | "one-shot";

const production = process.env.NODE_ENV === "production";
const developmentSessionSecret = randomBytes(32).toString("hex");

export const config = {
  production,
  port: numberFromEnv("PORT", 3001, 1, 65_535),
  databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  databaseSsl: process.env.DATABASE_SSL !== "false",
  corsOrigins: csvFromEnv("CORS_ORIGINS", ["http://localhost:3000"]),
  authDomain: process.env.AUTH_DOMAIN?.trim() || "localhost",
  authUri: process.env.AUTH_URI?.trim() || "http://localhost:3000",
  authSessionSecret: process.env.AUTH_SESSION_SECRET?.trim() || developmentSessionSecret,
  authSessionTtlSeconds: numberFromEnv("AUTH_SESSION_TTL_SECONDS", 3_600, 300, 86_400),
  authChallengeTtlSeconds: numberFromEnv("AUTH_CHALLENGE_TTL_SECONDS", 300, 60, 900),
  schedulerEnabled: process.env.SCHEDULER_ENABLED === "true",
  schedulerPollMs: numberFromEnv("SCHEDULER_POLL_MS", 30_000, 5_000, 300_000),
  schedulerLeaseMs: numberFromEnv("SCHEDULER_LEASE_MS", 120_000, 30_000, 900_000),
  paymentExecutionMode: executionModeFromEnv(),
  agentPrivateKey: privateKeyFromEnv("AGENT_PRIVATE_KEY"),
  bundlerRpcUrl: process.env.BUNDLER_RPC_URL?.trim() || undefined,
  aaPaymasterEnabled: process.env.AA_PAYMASTER_ENABLED === "true",
  relayerUrl: process.env.RELAYER_URL?.trim() || "https://relayer.1shotapi.com/relayers",
  relayerFeeBufferUsdc: process.env.RELAYER_FEE_BUFFER_USDC?.trim() || "0.05",
  relayerDelegationSecret: optionalBoundedSecret("RELAYER_DELEGATION_SECRET", 10, 1_024),
  baseBuilderCode: process.env.BASE_BUILDER_CODE?.trim() || undefined,
  veniceBaseUrl: process.env.VENICE_BASE_URL?.trim() || "https://api.venice.ai/api/v1",
  veniceModel: process.env.VENICE_MODEL?.trim() || "llama-3.3-70b"
} as const;

export function assertProductionConfig(): void {
  if (!production) return;
  const missing: string[] = [];
  if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
  if (!process.env.AUTH_SESSION_SECRET?.trim()) missing.push("AUTH_SESSION_SECRET");
  if (!process.env.CORS_ORIGINS?.trim()) missing.push("CORS_ORIGINS");
  if (!process.env.AUTH_DOMAIN?.trim()) missing.push("AUTH_DOMAIN");
  if (!process.env.AUTH_URI?.trim()) missing.push("AUTH_URI");
  if (config.paymentExecutionMode === "aa") {
    if (!config.agentPrivateKey) missing.push("AGENT_PRIVATE_KEY");
    if (!config.bundlerRpcUrl) missing.push("BUNDLER_RPC_URL");
  }
  if (config.authSessionSecret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must be at least 32 characters in production.");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
}

function executionModeFromEnv(): PaymentExecutionMode {
  const value = process.env.PAYMENT_EXECUTION_MODE?.trim() || "one-shot";
  if (value !== "aa" && value !== "one-shot") {
    throw new Error("PAYMENT_EXECUTION_MODE must be either aa or one-shot.");
  }
  return value;
}

function privateKeyFromEnv(name: string): `0x${string}` | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key.`);
  }
  return value as `0x${string}`;
}

function csvFromEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value?.trim()) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return Math.round(parsed);
}

function optionalBoundedSecret(name: string, min: number, max: number): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.length < min || value.length > max) {
    throw new Error(`${name} must be between ${min} and ${max} characters.`);
  }
  return value;
}
