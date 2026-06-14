import { isAddress } from "viem";

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";
export const BASE_RPC_URL = "https://mainnet.base.org";
export const BASE_EXPLORER_URL = "https://basescan.org";
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const RENT_PERIOD_SECONDS = 2_592_000;
export const DEFAULT_PERMISSION_BUFFER_PERCENT = 30;

const GROUPS_KEY = "rentsplit.groups.v1";
const ACTIVE_GROUP_KEY = "rentsplit.activeGroupId.v1";
const HISTORY_KEY = "rentsplit.paymentHistory.v1";

export type PermissionStatus = "pending" | "granted" | "expired" | "failed";
export type PaymentStatus = "pending" | "submitted" | "confirmed" | "rejected" | "failed";

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
  relayerTargetAddress: `0x${string}`;
  feeCollector: `0x${string}`;
  grantedAt: number;
  expiresAt: number;
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
  nextRunAt: string;
  autopayEnabled: boolean;
  permissionBufferPercent: number;
  roommates: Roommate[];
  createdAt: number;
  updatedAt: number;
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
  txHash?: string;
  basescanUrl?: string;
  error?: string;
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
  type: "scheduled" | "checked" | "submitted" | "confirmed" | "blocked" | "failed";
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

export function readGroups(): RentGroup[] {
  return readJson<RentGroup[]>(GROUPS_KEY, []).map(normalizeGroup);
}

export function saveGroups(groups: RentGroup[]): void {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
}

export function deleteGroupLocal(groupId: string): RentGroup | null {
  const groups = readGroups();
  const deleted = groups.find((group) => group.id === groupId) ?? null;
  const nextGroups = groups.filter((group) => group.id !== groupId);
  saveGroups(nextGroups);

  if (getActiveGroupId() === groupId) {
    if (nextGroups[0]) setActiveGroupId(nextGroups[0].id);
    else localStorage.removeItem(ACTIVE_GROUP_KEY);
  }

  return deleted;
}

export function upsertGroup(group: RentGroup): RentGroup {
  const groups = readGroups();
  const nextGroup = normalizeGroup({ ...group, updatedAt: Date.now() });
  const index = groups.findIndex((item) => item.id === group.id);
  if (index >= 0) {
    groups[index] = nextGroup;
  } else {
    groups.unshift(nextGroup);
  }
  saveGroups(groups);
  setActiveGroupId(nextGroup.id);
  return nextGroup;
}

export function getActiveGroupId(): string | null {
  return localStorage.getItem(ACTIVE_GROUP_KEY);
}

export function setActiveGroupId(groupId: string): void {
  localStorage.setItem(ACTIVE_GROUP_KEY, groupId);
}

export function readPaymentHistory(): PaymentRecord[] {
  return readJson<PaymentRecord[]>(HISTORY_KEY, []);
}

export function savePaymentHistory(records: PaymentRecord[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records));
}

export function createInviteUrl(group: RentGroup, roommateId: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("group", group.id);
  url.searchParams.set("roommate", roommateId);
  return url.toString();
}

export function getInviteParams(): { groupId: string; roommateId: string; payloadGroup?: RentGroup } | null {
  const params = new URLSearchParams(window.location.search);
  const groupId = params.get("group");
  const roommateId = params.get("roommate");
  if (!groupId || !roommateId) return null;

  const payload = params.get("payload");
  return {
    groupId,
    roommateId,
    payloadGroup: payload ? decodePayload(payload) : undefined
  };
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

export function normalizeGroup(group: RentGroup): RentGroup {
  const dueDay = clampDay(group.dueDay ?? new Date().getDate());
  return {
    ...group,
    propertyName: group.propertyName || "Apartment",
    propertyAddress: group.propertyAddress || "",
    dueDay,
    nextRunAt: group.nextRunAt || nextMonthlyRun(dueDay).toISOString(),
    autopayEnabled: group.autopayEnabled ?? true,
    permissionBufferPercent: group.permissionBufferPercent ?? DEFAULT_PERMISSION_BUFFER_PERCENT
  };
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

export function applyRentCommands(group: RentGroup, commands: RentCommand[]): RentGroup {
  let next: RentGroup = { ...group, roommates: group.roommates.map((roommate) => ({ ...roommate })) };

  for (const command of commands) {
    if (command.type === "set_splits") {
      const splitMap = new Map(command.splits.map((split) => [split.roommateId, split.share]));
      next = {
        ...next,
        roommates: next.roommates.map((roommate) => ({
          ...roommate,
          share: splitMap.get(roommate.id) ?? roommate.share
        }))
      };
    }

    if (command.type === "add_roommate") {
      next = {
        ...next,
        roommates: [
          ...next.roommates,
          {
            id: createId("roommate"),
            name: command.name,
            walletAddress: normalizeAddress(command.walletAddress),
            share: command.share
          }
        ]
      };
    }

    if (command.type === "remove_roommate") {
      next = {
        ...next,
        roommates: next.roommates.filter((roommate) => roommate.id !== command.roommateId)
      };
    }
  }

  return { ...next, updatedAt: Date.now() };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
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

function encodePayload(group: RentGroup): string {
  const bytes = new TextEncoder().encode(JSON.stringify(group));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePayload(payload: string): RentGroup | undefined {
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as RentGroup;
  } catch {
    return undefined;
  }
}
