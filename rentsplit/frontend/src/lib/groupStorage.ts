import { isAddress } from "viem";

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";
export const BASE_RPC_URL = "https://mainnet.base.org";
export const BASE_EXPLORER_URL = "https://basescan.org";
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const RENT_PERIOD_SECONDS = 2_592_000;
export const DEFAULT_PERMISSION_BUFFER_PERCENT = 30;

export type PermissionStatus = "pending" | "granted" | "expired" | "failed";
export type PaymentExecutionMode = "aa" | "one-shot";
export type PaymentStatus = "scheduled" | "preparing" | "submission_unknown" | "pending" | "submitted" | "confirmed" | "rejected" | "failed";

export type PermissionGrant = {
  status: PermissionStatus;
  walletAddress: `0x${string}`;
  permissionContext: unknown[];
  rawContext: string;
  allowanceAtoms: string;
  shareAtoms: string;
  adjustmentBufferAtoms: string;
  adjustmentBufferPercent: number;
  feeBufferAtoms: string;
  tokenAddress: `0x${string}`;
  tokenDecimals: number;
  executionMode?: PaymentExecutionMode;
  relayerTargetAddress?: `0x${string}`;
  feeCollector?: `0x${string}`;
  sessionAccountAddress?: `0x${string}`;
  delegationManager?: `0x${string}`;
  dependencies?: Array<{ factory: `0x${string}`; factoryData: `0x${string}` }>;
  grantedAt: number;
  expiresAt: number;
  landlordAddress?: `0x${string}`;
  periodSeconds?: number;
  purpose?: string;
  taskIds?: string[];
  error?: string;
};

export type Roommate = {
  id: string;
  name: string;
  walletAddress: `0x${string}`;
  share: string;
  permission?: PermissionGrant;
};

export type RentGroup = {
  id: string;
  adminWalletAddress?: `0x${string}`;
  propertyName: string;
  propertyAddress: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  dueDay: number;
  rentRunTime: string;
  nextRunAt: string;
  autopayEnabled: boolean;
  permissionBufferPercent: number;
  roommates: Roommate[];
  createdAt: number;
  updatedAt: number;
  scheduleTimeZone?: "UTC";
  closedAt?: string;
};

export type PaymentRecord = {
  id: string;
  groupId: string;
  roommateId: string;
  roommateName: string;
  walletAddress: `0x${string}`;
  amount: string;
  date: string;
  status: PaymentStatus;
  taskId?: string;
  executionMode?: PaymentExecutionMode;
  userOperationHash?: `0x${string}`;
  txHash?: string;
  basescanUrl?: string;
  error?: string;
  billingPeriod: string;
  idempotencyKey: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  failureStage?: "validation" | "estimate" | "submission" | "status";
};

export type RentCommand =
  | {
      type: "set_splits";
      splits: Array<{ roommateId: string; share: string }>;
      reason?: string;
    }
  | {
      type: "add_roommate";
      name: string;
      walletAddress: `0x${string}`;
      share: string;
    }
  | {
      type: "remove_roommate";
      roommateId: string;
    };

export type AgentEvent = {
  id: string;
  groupId: string;
  type: "scheduled" | "checked" | "submitted" | "confirmed" | "blocked" | "failed" | "paused";
  message: string;
  createdAt: string;
};

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeAddress(address: string): `0x${string}` {
  if (!isAddress(address)) {
    throw new Error(`Invalid wallet address: ${address}`);
  }
  return address as `0x${string}`;
}

export function createInviteUrl(group: RentGroup, roommateId: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("group", group.id);
  url.searchParams.set("roommate", roommateId);
  return url.toString();
}

export function getInviteParams(): { groupId: string; roommateId: string } | null {
  const params = new URLSearchParams(window.location.search);
  const groupId = params.get("group");
  const roommateId = params.get("roommate");
  if (!groupId || !roommateId) return null;

  return { groupId, roommateId };
}

export function splitEqual(totalRent: string, count: number): string[] {
  if (count <= 0) return [];
  const totalCents = Math.round(Number(totalRent || "0") * 100);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, index) => formatCents(base + (index < remainder ? 1 : 0)));
}

export function formatUsd(value: string | number): string {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function permissionStatus(roommate: Roommate): PermissionStatus {
  const grant = roommate.permission;
  if (!grant) return "pending";
  if (grant.status !== "granted") return grant.status;
  return grant.expiresAt <= Math.floor(Date.now() / 1000) ? "expired" : "granted";
}

export function nextMonthlyRun(dueDay: number, from = new Date()): Date {
  const day = clampDay(dueDay);
  const candidate = new Date(from);
  candidate.setHours(9, 0, 0, 0);
  candidate.setDate(Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
  if (candidate.getTime() <= from.getTime()) {
    candidate.setMonth(candidate.getMonth() + 1);
    candidate.setDate(Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
  }
  return candidate;
}

export function demoRunInMinutes(minutes = 1): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function clampDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.round(day)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
