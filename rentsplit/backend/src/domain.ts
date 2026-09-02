import { randomUUID } from "node:crypto";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { BASE_CHAIN_ID, RENT_PERIOD_SECONDS, USDC_BASE_ADDRESS } from "./config.js";
import type { PermissionGrant, RentGroup, Roommate } from "./types.js";

export type RentCommand =
  | { type: "set_splits"; splits: Array<{ roommateId: string; share: string }>; reason?: string }
  | { type: "add_roommate"; name: string; walletAddress: `0x${string}`; share: string }
  | { type: "remove_roommate"; roommateId: string };

export function normalizeWalletAddress(value: string): `0x${string}` {
  if (!isAddress(value)) throw new Error("A valid EVM wallet address is required.");
  return getAddress(value);
}

export function isGroupMember(group: RentGroup, walletAddress: string): boolean {
  const wallet = walletAddress.toLowerCase();
  return isGroupAdmin(group, wallet) || group.roommates.some((roommate) => roommate.walletAddress.toLowerCase() === wallet);
}

export function isGroupAdmin(group: RentGroup, walletAddress: string): boolean {
  return Boolean(group.adminWalletAddress && group.adminWalletAddress.toLowerCase() === walletAddress.toLowerCase());
}

export function billingPeriodFor(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function paymentIdempotencyKey(groupId: string, roommateId: string, billingPeriod: string): string {
  return `${groupId}:${roommateId}:${billingPeriod}`;
}

export function normalizeSchedule(group: RentGroup, from = new Date()): RentGroup {
  const dueDay = clampDay(group.dueDay ?? 1);
  const rentRunTime = normalizeRentRunTime(group.rentRunTime);
  const nextRunAt = group.nextRunAt && Date.parse(group.nextRunAt) > from.getTime()
    ? new Date(group.nextRunAt).toISOString()
    : nextMonthlyRun(dueDay, from, rentRunTime).toISOString();
  return {
    ...group,
    dueDay,
    rentRunTime,
    nextRunAt,
    scheduleTimeZone: "UTC",
    autopayEnabled: group.autopayEnabled ?? true,
    permissionBufferPercent: group.permissionBufferPercent ?? 30,
    updatedAt: Date.now()
  };
}

export function nextMonthlyRun(dueDay: number, from = new Date(), rentRunTime = "09:00"): Date {
  const day = clampDay(dueDay);
  const [hour, minute] = parseRentRunTime(rentRunTime);
  const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, hour, minute, 0, 0));
  if (candidate.getTime() <= from.getTime()) {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, day, hour, minute, 0, 0));
  }
  return candidate;
}

export function validateGroupForSave(group: RentGroup): RentGroup {
  const totalAtoms = parseUsdc(group.totalRent, "Total rent");
  if (totalAtoms <= 0n) throw new Error("Total rent must be greater than zero.");
  if (group.roommates.length === 0 || group.roommates.length > 20) {
    throw new Error("A household must have between 1 and 20 residents.");
  }

  const wallets = new Set<string>();
  const roommateIds = new Set<string>();
  let shareAtoms = 0n;
  const roommates = group.roommates.map((roommate) => {
    if (!roommate.id || roommateIds.has(roommate.id)) throw new Error("Resident identifiers must be unique.");
    roommateIds.add(roommate.id);
    const walletAddress = normalizeWalletAddress(roommate.walletAddress);
    const wallet = walletAddress.toLowerCase();
    if (wallets.has(wallet)) throw new Error("Resident wallet addresses must be unique.");
    wallets.add(wallet);
    const share = normalizeUsdc(roommate.share, `${roommate.name || "Resident"} share`);
    shareAtoms += parseUnits(share, 6);
    return { ...roommate, name: roommate.name.trim().slice(0, 80) || "Resident", walletAddress, share };
  });

  if (shareAtoms !== totalAtoms) throw new Error("Resident shares must equal the total monthly rent.");
  return normalizeSchedule({
    ...group,
    adminWalletAddress: group.adminWalletAddress ? normalizeWalletAddress(group.adminWalletAddress) : undefined,
    landlordAddress: normalizeWalletAddress(group.landlordAddress),
    propertyName: (group.propertyName || "Apartment").trim().slice(0, 120),
    propertyAddress: (group.propertyAddress || "").trim().slice(0, 240),
    totalRent: normalizeUsdc(group.totalRent, "Total rent"),
    roommates
  });
}

export function applyRentCommands(group: RentGroup, commands: RentCommand[]): RentGroup {
  let next: RentGroup = { ...group, roommates: group.roommates.map((roommate) => ({ ...roommate })) };

  for (const command of commands) {
    if (command.type === "set_splits") next = applySplitCommand(next, command);
    if (command.type === "add_roommate") next = applyAddRoommate(next, command);
    if (command.type === "remove_roommate") next = applyRemoveRoommate(next, command);
  }

  return validateGroupForSave({ ...next, updatedAt: Date.now() });
}

export function validatePermissionForPayment(
  group: RentGroup,
  roommate: Roommate,
  permission: PermissionGrant | undefined,
  executionTargetAddress: string
): string | undefined {
  if (!permission || permission.status !== "granted" || !permission.permissionContext?.length) {
    return "Permission is not active.";
  }
  if (permission.walletAddress.toLowerCase() !== roommate.walletAddress.toLowerCase()) {
    return "Permission wallet does not match this resident.";
  }
  if (permission.expiresAt <= Math.floor(Date.now() / 1000)) return "Permission is expired.";
  if (permission.tokenAddress.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) return "Permission is not for Base USDC.";
  const permissionTarget = permission.executionMode === "aa"
    ? permission.sessionAccountAddress ?? permission.relayerTargetAddress
    : permission.relayerTargetAddress;
  if (!permissionTarget || permissionTarget.toLowerCase() !== executionTargetAddress.toLowerCase()) {
    return "Permission targets a different execution account.";
  }
  if (permission.landlordAddress && permission.landlordAddress.toLowerCase() !== group.landlordAddress.toLowerCase()) {
    return "Landlord changed after this permission was granted. Re-grant permission.";
  }
  if (permission.periodSeconds && permission.periodSeconds !== RENT_PERIOD_SECONDS) {
    return "Permission period does not match the monthly rent policy.";
  }
  const shareAtoms = parseUnits(roommate.share, permission.tokenDecimals);
  const feeBufferAtoms = permission.executionMode === "aa" ? 0n : BigInt(permission.feeBufferAtoms || "0");
  if (shareAtoms + feeBufferAtoms > BigInt(permission.allowanceAtoms)) {
    return "Current share exceeds the granted spending cap. Re-grant permission.";
  }
  return undefined;
}

export function permissionSummary(permission: PermissionGrant | undefined): {
  chainId: number;
  token: `0x${string}`;
  periodSeconds: number;
  expiresAt?: number;
  allowanceAtoms?: string;
} {
  return {
    chainId: BASE_CHAIN_ID,
    token: USDC_BASE_ADDRESS,
    periodSeconds: permission?.periodSeconds ?? RENT_PERIOD_SECONDS,
    expiresAt: permission?.expiresAt,
    allowanceAtoms: permission?.allowanceAtoms
  };
}

function applySplitCommand(group: RentGroup, command: Extract<RentCommand, { type: "set_splits" }>): RentGroup {
  if (command.splits.length !== group.roommates.length) {
    throw new Error("A split update must include every current resident.");
  }
  const splitMap = new Map<string, string>();
  for (const split of command.splits) {
    if (!group.roommates.some((roommate) => roommate.id === split.roommateId)) {
      throw new Error("A split update referenced an unknown resident.");
    }
    if (splitMap.has(split.roommateId)) throw new Error("A split update repeated a resident.");
    splitMap.set(split.roommateId, normalizeUsdc(split.share, "Resident share"));
  }
  return {
    ...group,
    roommates: group.roommates.map((roommate) => ({ ...roommate, share: splitMap.get(roommate.id)! }))
  };
}

function applyAddRoommate(group: RentGroup, command: Extract<RentCommand, { type: "add_roommate" }>): RentGroup {
  const walletAddress = normalizeWalletAddress(command.walletAddress);
  if (group.roommates.some((roommate) => roommate.walletAddress.toLowerCase() === walletAddress.toLowerCase())) {
    throw new Error("That wallet is already a resident.");
  }
  return {
    ...group,
    roommates: [
      ...group.roommates,
      {
        id: randomUUID(),
        name: command.name.trim().slice(0, 80) || "Resident",
        walletAddress,
        share: normalizeUsdc(command.share, "Resident share")
      }
    ]
  };
}

function applyRemoveRoommate(group: RentGroup, command: Extract<RentCommand, { type: "remove_roommate" }>): RentGroup {
  if (!group.roommates.some((roommate) => roommate.id === command.roommateId)) {
    throw new Error("The resident to remove was not found.");
  }
  return { ...group, roommates: group.roommates.filter((roommate) => roommate.id !== command.roommateId) };
}

function normalizeUsdc(value: string, label: string): string {
  const atoms = parseUsdc(value, label);
  const formatted = formatUnits(atoms, 6);
  const [whole, fraction = ""] = formatted.split(".");
  return `${whole}.${fraction.padEnd(2, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}

function parseUsdc(value: string, label: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(String(value).trim())) throw new Error(`${label} must be a valid USDC amount.`);
  return parseUnits(String(value).trim(), 6);
}

function clampDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.round(day)));
}

function normalizeRentRunTime(value: string | undefined): string {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return "09:00";
  const [hour, minute] = parseRentRunTime(value);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseRentRunTime(value: string): [number, number] {
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return [9, 0];
  }
  return [hour, minute];
}
