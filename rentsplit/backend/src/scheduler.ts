import { collectGroupRent } from "./agent.js";
import {
  appendAgentEvent,
  getGroup,
  listAgentEvents,
  listPayments,
  saveGroup,
  savePaymentRecords
} from "./store.js";
import type { AgentEvent, PaymentRecord, RentGroup } from "./types.js";

type AgentState = {
  events: AgentEvent[];
  payments: PaymentRecord[];
  nextRunAt?: string;
  running: boolean;
};

const timers = new Map<string, NodeJS.Timeout>();
const runningGroups = new Set<string>();

export async function scheduleGroup(group: RentGroup): Promise<AgentState> {
  const saved = await saveGroup(normalizeSchedule(group));
  clearTimer(saved.id);

  if (saved.autopayEnabled && saved.nextRunAt) {
    const delay = Math.max(0, Date.parse(saved.nextRunAt) - Date.now());
    const cappedDelay = Math.min(delay, 2_147_483_647);
    timers.set(
      saved.id,
      setTimeout(() => {
        runScheduledGroup(saved.id).catch(async (cause) => {
          await appendAgentEvent({
            groupId: saved.id,
            type: "failed",
            message: cause instanceof Error ? cause.message : "Agent run failed"
          });
        });
      }, cappedDelay)
    );
    const message = `Next rent run ${formatDate(saved.nextRunAt)}`;
    const recentEvents = await listAgentEvents(saved.id);
    if (recentEvents[0]?.type !== "scheduled" || recentEvents[0].message !== message) {
      await appendAgentEvent({
        groupId: saved.id,
        type: "scheduled",
        message
      });
    }
  }

  return getAgentState(saved.id);
}

export async function runAgentNow(group: RentGroup): Promise<AgentState> {
  const saved = await saveGroup(normalizeSchedule(group));
  await runAgent(saved.id);
  return getAgentState(saved.id);
}

export async function getAgentState(groupId: string): Promise<AgentState> {
  return {
    events: await listAgentEvents(groupId),
    payments: await listPayments(groupId),
    nextRunAt: (await getGroup(groupId))?.nextRunAt,
    running: runningGroups.has(groupId)
  };
}

async function runScheduledGroup(groupId: string): Promise<void> {
  await runAgent(groupId);
}

async function runAgent(groupId: string): Promise<void> {
  if (runningGroups.has(groupId)) return;
  runningGroups.add(groupId);
  clearTimer(groupId);

  try {
    const group = await getGroup(groupId);
    if (!group) throw new Error("Group not found");

    await appendAgentEvent({
      groupId,
      type: "checked",
      message: "Agent checked rent schedule and permissions"
    });

    const payments = await collectGroupRent(group);
    await savePaymentRecords(payments);

    const submitted = payments.filter((payment) => payment.status === "submitted").length;
    const blocked = payments.filter((payment) => payment.status === "failed" || payment.status === "rejected").length;

    if (submitted > 0) {
      await appendAgentEvent({
        groupId,
        type: "submitted",
        message: `${submitted} delegated payment${submitted === 1 ? "" : "s"} submitted`
      });
    }
    if (blocked > 0) {
      await appendAgentEvent({
        groupId,
        type: "blocked",
        message: `${blocked} payment${blocked === 1 ? "" : "s"} blocked by missing permission or relay error`
      });
    }

    const nextRunAt = nextMonthlyRun(group.dueDay ?? new Date().getDate()).toISOString();
    await saveGroup({ ...group, nextRunAt, updatedAt: Date.now() });
    await scheduleGroup({ ...group, nextRunAt, updatedAt: Date.now() });
  } finally {
    runningGroups.delete(groupId);
  }
}

function clearTimer(groupId: string): void {
  const timer = timers.get(groupId);
  if (timer) windowlessClearTimeout(timer);
  timers.delete(groupId);
}

function normalizeSchedule(group: RentGroup): RentGroup {
  const dueDay = clampDay(group.dueDay ?? new Date().getDate());
  return {
    ...group,
    dueDay,
    nextRunAt: group.nextRunAt || nextMonthlyRun(dueDay).toISOString(),
    autopayEnabled: group.autopayEnabled ?? true,
    permissionBufferPercent: group.permissionBufferPercent ?? 30,
    updatedAt: Date.now()
  };
}

function nextMonthlyRun(dueDay: number, from = new Date()): Date {
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

function clampDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.round(day)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function windowlessClearTimeout(timer: NodeJS.Timeout): void {
  clearTimeout(timer);
}
