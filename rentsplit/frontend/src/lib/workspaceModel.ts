import { formatUnits, parseUnits } from "viem";
import type { Roommate } from "./groupStorage";

export function permissionCoversShare(roommate: Roommate): boolean {
  const permission = roommate.permission;
  if (!permission) return false;
  try {
    return parseUnits(roommate.share, permission.tokenDecimals) + BigInt(permission.feeBufferAtoms || "0") <= BigInt(permission.allowanceAtoms);
  } catch {
    return false;
  }
}

export function nextRentSchedule(day: number, time: string, now = new Date()) {
  if (!Number.isInteger(day) || day < 1 || day > 28 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Choose a rent day from 1 to 28 and a valid time in UTC.");
  }
  const [hour, minute] = time.split(":").map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, minute));
  if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
  return { dueDay: day, rentRunTime: time, nextRunAt: next.toISOString() };
}

export function allocateRent(totalRent: string, shares: Array<string | undefined>): string[] {
  const amount = (value: string) => {
    if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("Use USDC amounts with up to six decimal places.");
    return parseUnits(value, 6);
  };
  const total = amount(totalRent);
  if (total <= 0n || shares.length === 0) throw new Error("Add rent and at least one resident.");
  const fixed = shares.map((share) => share?.trim() ? amount(share.trim()) : null);
  const assigned = fixed.reduce<bigint>((sum, share) => sum + (share ?? 0n), 0n);
  const automatic = fixed.filter((share) => share === null).length;
  if (assigned > total || (!automatic && assigned !== total)) throw new Error("Resident shares must equal the monthly rent.");
  const remaining = total - assigned;
  let remainder = automatic ? remaining % BigInt(automatic) : 0n;
  return fixed.map((share) => {
    if (share !== null) return formatUnits(share, 6);
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder--;
    return formatUnits(remaining / BigInt(automatic) + extra, 6);
  });
}

export function paymentErrorText(error?: string): string {
  if (!error) return "needs attention";
  if (/permission is not active/i.test(error)) return "permission is not active";
  if (/permission is expired/i.test(error)) return "permission expired";
  // Preserve the actual failure: a revert can also mean an expired caveat or insufficient gas.
  return error;
}
