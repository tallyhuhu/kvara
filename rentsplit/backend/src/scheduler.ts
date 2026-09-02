import { collectGroupRent, reconcileRelayerTasks } from "./agent.js";
import { config } from "./config.js";
import { billingPeriodFor, nextMonthlyRun, normalizeSchedule } from "./domain.js";
import { logError, logInfo, logWarn } from "./logger.js";
import {
  appendAgentEvent,
  claimRentCycle,
  getGroup,
  listAgentEvents,
  listDueGroups,
  listPayments,
  saveGroup,
  updateRentCycleStatus
} from "./store.js";
import type { AgentEvent, PaymentRecord, RentCycleStatus, RentGroup } from "./types.js";

export type AgentState = {
  groupId: string;
  events: AgentEvent[];
  payments: PaymentRecord[];
  nextRunAt?: string;
  autopayEnabled: boolean;
};

let timer: NodeJS.Timeout | undefined;
let tickRunning = false;

export async function scheduleGroup(groupOrId: RentGroup | string): Promise<AgentState> {
  const group = await requireGroup(groupOrId);
  const scheduled = normalizeSchedule(group);
  const saved = await saveGroup(scheduled);
  await appendAgentEvent({
    groupId: saved.id,
    type: saved.autopayEnabled ? "scheduled" : "paused",
    message: saved.autopayEnabled
      ? `Autopay is scheduled for ${formatUtc(saved.nextRunAt)}.`
      : "Autopay is paused."
  });
  return getAgentState(saved.id);
}

export async function runAgentNow(groupOrId: RentGroup | string): Promise<AgentState> {
  const group = await requireGroup(groupOrId);
  await executeCycle(group, new Date(), true);
  return getAgentState(group.id);
}

export async function getAgentState(groupId: string): Promise<AgentState> {
  const group = await getGroup(groupId);
  if (!group || group.closedAt) throw new Error("Household not found.");
  return {
    groupId,
    events: await listAgentEvents(groupId),
    payments: await listPayments(groupId),
    nextRunAt: group.nextRunAt,
    autopayEnabled: Boolean(group.autopayEnabled)
  };
}

export function startScheduler(): void {
  if (!config.schedulerEnabled || timer) return;
  timer = setInterval(() => void schedulerTick(), config.schedulerPollMs);
  timer.unref();
  logInfo("scheduler.started", { pollMs: config.schedulerPollMs, leaseMs: config.schedulerLeaseMs });
  void schedulerTick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function schedulerTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await reconcilePaymentCycles(await reconcileRelayerTasks());
    const now = new Date();
    for (const group of await listDueGroups(now)) {
      await executeCycle(group, now, false);
    }
  } catch (cause) {
    logError("scheduler.tick.failed", cause);
  } finally {
    tickRunning = false;
  }
}

async function executeCycle(group: RentGroup, now: Date, manual: boolean): Promise<void> {
  if (group.closedAt) return;
  if (!manual && !group.autopayEnabled) return;

  const billingPeriod = billingPeriodFor(now);
  const cycle = await claimRentCycle(group.id, billingPeriod, config.schedulerLeaseMs);
  if (!cycle) {
    logInfo("rent.cycle.skipped", { groupId: group.id, billingPeriod, reason: "already claimed" });
    return;
  }

  await appendAgentEvent({
    groupId: group.id,
    type: "checked",
    message: `${manual ? "Manual" : "Scheduled"} rent run started for ${billingPeriod}.`
  });

  try {
    const payments = await collectGroupRent(group, billingPeriod);
    const status = paymentCycleStatus(payments);
    await updateRentCycleStatus(group.id, billingPeriod, status.cycleStatus);
    await appendAgentEvent({ groupId: group.id, type: status.eventType, message: status.message });

    if (!manual || Date.parse(group.nextRunAt ?? "") <= now.getTime()) {
      const nextRunAt = nextMonthlyRun(group.dueDay ?? 1, now, group.rentRunTime ?? "09:00").toISOString();
      await saveGroup({ ...group, nextRunAt, updatedAt: Date.now() });
      await appendAgentEvent({
        groupId: group.id,
        type: "scheduled",
        message: `Next automatic rent run is ${formatUtc(nextRunAt)}.`
      });
    }
  } catch (cause) {
    await updateRentCycleStatus(group.id, billingPeriod, "failed");
    await appendAgentEvent({
      groupId: group.id,
      type: "failed",
      message: cause instanceof Error ? cause.message : "Rent run failed before payment submission."
    });
    logError("rent.cycle.failed", cause, { groupId: group.id, billingPeriod });
  }
}

export function paymentCycleStatus(payments: PaymentRecord[]): {
  cycleStatus: RentCycleStatus;
  eventType: AgentEvent["type"];
  message: string;
} {
  const submitted = payments.filter((payment) => ["pending", "submitted", "confirmed"].includes(payment.status));
  const active = submitted.filter((payment) => payment.status === "pending" || payment.status === "submitted");
  const uncertain = payments.filter((payment) => payment.status === "submission_unknown");
  const failed = payments.filter((payment) => ["failed", "rejected"].includes(payment.status));
  if (uncertain.length > 0) {
    return {
      cycleStatus: "processing",
      eventType: "blocked",
      message: `${uncertain.length} payment submission outcome${uncertain.length === 1 ? " is" : "s are"} unknown. Automatic retry is disabled.`
    };
  }
  if (submitted.length === 0) {
    const reasons = failed.map((payment) => `${payment.roommateName}: ${payment.error ?? payment.status}`).join("; ");
    return { cycleStatus: "blocked", eventType: "blocked", message: `No payments were submitted. ${reasons}`.trim() };
  }
  if (failed.length > 0) {
    logWarn("rent.cycle.partially_blocked", { submitted: submitted.length, blocked: failed.length });
    return {
      cycleStatus: active.length > 0 ? "processing" : "blocked",
      eventType: active.length > 0 ? "submitted" : "blocked",
      message: `${submitted.length} payment${submitted.length === 1 ? "" : "s"} submitted; ${failed.length} blocked.`
    };
  }
  if (submitted.every((payment) => payment.status === "confirmed")) {
    return {
      cycleStatus: "completed",
      eventType: "confirmed",
      message: `${submitted.length} payment${submitted.length === 1 ? "" : "s"} confirmed on Base.`
    };
  }
  return {
    cycleStatus: "processing",
    eventType: "submitted",
    message: `${submitted.length} payment${submitted.length === 1 ? "" : "s"} submitted on Base.`
  };
}

async function reconcilePaymentCycles(updates: PaymentRecord[]): Promise<void> {
  const cycles = new Map<string, { groupId: string; billingPeriod: string }>();
  for (const payment of updates) {
    cycles.set(`${payment.groupId}:${payment.billingPeriod}`, {
      groupId: payment.groupId,
      billingPeriod: payment.billingPeriod
    });
  }

  for (const cycle of cycles.values()) {
    const payments = (await listPayments(cycle.groupId)).filter(
      (payment) => payment.billingPeriod === cycle.billingPeriod
    );
    const status = paymentCycleStatus(payments);
    await updateRentCycleStatus(cycle.groupId, cycle.billingPeriod, status.cycleStatus);
    if (status.cycleStatus === "completed" || status.cycleStatus === "blocked") {
      await appendAgentEvent({ groupId: cycle.groupId, type: status.eventType, message: status.message });
    }
  }
}

async function requireGroup(groupOrId: RentGroup | string): Promise<RentGroup> {
  const group = typeof groupOrId === "string" ? await getGroup(groupOrId) : groupOrId;
  if (!group || group.closedAt) throw new Error("Household not found.");
  return group;
}

function formatUtc(value: string | undefined): string {
  if (!value) return "not scheduled";
  return `${new Date(value).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
