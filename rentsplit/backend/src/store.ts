import { randomUUID } from "node:crypto";
import pg from "pg";
import { config } from "./config.js";
import type { AgentEvent, AuthChallenge, PaymentRecord, RentCycle, RentCycleStatus, RentGroup } from "./types.js";

const { Pool } = pg;
const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl ? { rejectUnauthorized: false } : false })
  : null;

const memory = {
  groups: new Map<string, RentGroup>(),
  payments: new Map<string, PaymentRecord>(),
  events: new Map<string, AgentEvent>(),
  challenges: new Map<string, AuthChallenge>(),
  cycles: new Map<string, RentCycle>()
};

let initPromise: Promise<void> | null = null;

export async function initStore(): Promise<void> {
  if (!pool) return;
  initPromise ??= pool.query(`
    create table if not exists rent_groups (
      id text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists payment_records (
      id text primary key,
      group_id text not null,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );
    alter table payment_records add column if not exists roommate_id text;
    alter table payment_records add column if not exists billing_period text;
    alter table payment_records add column if not exists task_id text;
    update payment_records
      set roommate_id = coalesce(roommate_id, payload->>'roommateId'),
          task_id = coalesce(task_id, payload->>'taskId')
      where roommate_id is null or task_id is null;
    create index if not exists payment_records_group_id_idx on payment_records(group_id);
    create unique index if not exists payment_records_cycle_unique_idx
      on payment_records(group_id, roommate_id, billing_period)
      where roommate_id is not null and billing_period is not null;
    create unique index if not exists payment_records_task_id_unique_idx
      on payment_records(task_id) where task_id is not null;
    create table if not exists agent_events (
      id text primary key,
      group_id text not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    );
    create index if not exists agent_events_group_id_idx on agent_events(group_id);
    create table if not exists auth_challenges (
      id text primary key,
      wallet_address text not null,
      message text not null,
      expires_at timestamptz not null,
      consumed_at timestamptz
    );
    create index if not exists auth_challenges_wallet_idx on auth_challenges(wallet_address);
    create table if not exists rent_cycles (
      group_id text not null,
      billing_period text not null,
      status text not null,
      lease_until timestamptz not null,
      attempt_count integer not null default 1,
      started_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (group_id, billing_period)
    );
  `).then(() => undefined);
  return initPromise;
}

export function storeMode(): "postgres" | "memory" {
  return pool ? "postgres" : "memory";
}

export async function listGroups(walletAddress?: string): Promise<RentGroup[]> {
  if (!pool) {
    return filterGroupsByWallet(
      Array.from(memory.groups.values()).filter((group) => !group.closedAt).sort((a, b) => b.updatedAt - a.updatedAt),
      walletAddress
    );
  }
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>(
    "select payload from rent_groups where payload->>'closedAt' is null order by updated_at desc"
  );
  return filterGroupsByWallet(result.rows.map((row) => row.payload), walletAddress);
}

export async function listDueGroups(now = new Date(), limit = 25): Promise<RentGroup[]> {
  if (!pool) {
    return Array.from(memory.groups.values())
      .filter((group) => group.autopayEnabled && !group.closedAt && Date.parse(group.nextRunAt ?? "") <= now.getTime())
      .sort((a, b) => Date.parse(a.nextRunAt ?? "") - Date.parse(b.nextRunAt ?? ""))
      .slice(0, limit);
  }
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>(
    `select payload from rent_groups
     where coalesce((payload->>'autopayEnabled')::boolean, false) = true
       and payload->>'closedAt' is null
       and nullif(payload->>'nextRunAt', '')::timestamptz <= $1
     order by nullif(payload->>'nextRunAt', '')::timestamptz asc limit $2`,
    [now.toISOString(), limit]
  );
  return result.rows.map((row) => row.payload);
}

export async function getGroup(groupId: string): Promise<RentGroup | null> {
  if (!pool) return memory.groups.get(groupId) ?? null;
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>("select payload from rent_groups where id = $1", [groupId]);
  return result.rows[0]?.payload ?? null;
}

export async function createGroup(group: RentGroup): Promise<RentGroup> {
  const next = { ...group, updatedAt: Date.now() };
  if (!pool) {
    if (memory.groups.has(next.id)) throw new Error("Group already exists.");
    memory.groups.set(next.id, next);
    return next;
  }
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>(
    `insert into rent_groups (id, payload, updated_at) values ($1, $2::jsonb, now())
     on conflict (id) do nothing returning payload`,
    [next.id, JSON.stringify(next)]
  );
  if (!result.rows[0]) throw new Error("Group already exists.");
  return result.rows[0].payload;
}

export async function saveGroup(group: RentGroup): Promise<RentGroup> {
  const next = { ...group, updatedAt: Date.now() };
  if (!pool) {
    memory.groups.set(next.id, next);
    return next;
  }
  await initStore();
  await pool.query(
    `insert into rent_groups (id, payload, updated_at) values ($1, $2::jsonb, now())
     on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
    [next.id, JSON.stringify(next)]
  );
  return next;
}

export async function closeGroup(groupId: string): Promise<boolean> {
  const group = await getGroup(groupId);
  if (!group) return false;
  await saveGroup({ ...group, autopayEnabled: false, closedAt: new Date().toISOString(), updatedAt: Date.now() });
  return true;
}

export async function listPayments(groupId: string): Promise<PaymentRecord[]> {
  if (!pool) {
    return Array.from(memory.payments.values())
      .filter((payment) => payment.groupId === groupId)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  }
  await initStore();
  const result = await pool.query<{ payload: PaymentRecord }>(
    "select payload from payment_records where group_id = $1 order by updated_at desc",
    [groupId]
  );
  return result.rows.map((row) => normalizePayment(row.payload));
}

export async function getPaymentByTaskId(taskId: string): Promise<PaymentRecord | null> {
  if (!pool) return Array.from(memory.payments.values()).find((payment) => payment.taskId === taskId) ?? null;
  await initStore();
  const result = await pool.query<{ payload: PaymentRecord }>(
    "select payload from payment_records where task_id = $1 limit 1",
    [taskId]
  );
  return result.rows[0] ? normalizePayment(result.rows[0].payload) : null;
}

export async function listPaymentsForReconciliation(limit = 100): Promise<PaymentRecord[]> {
  const activeStatuses = new Set(["preparing", "submission_unknown", "pending", "submitted"]);
  if (!pool) {
    return Array.from(memory.payments.values()).filter((payment) => payment.taskId && activeStatuses.has(payment.status)).slice(0, limit);
  }
  await initStore();
  const result = await pool.query<{ payload: PaymentRecord }>(
    `select payload from payment_records
     where task_id is not null and payload->>'status' in ('preparing', 'submission_unknown', 'pending', 'submitted')
     order by updated_at asc limit $1`,
    [limit]
  );
  return result.rows.map((row) => normalizePayment(row.payload));
}

export async function reservePaymentAttempt(record: PaymentRecord): Promise<{ claimed: boolean; payment: PaymentRecord }> {
  if (!pool) {
    const existing = memory.payments.get(record.id);
    if (!existing) {
      memory.payments.set(record.id, record);
      return { claimed: true, payment: record };
    }
    if (existing.status === "failed" || existing.status === "rejected") {
      const retry = retryRecord(existing);
      memory.payments.set(retry.id, retry);
      return { claimed: true, payment: retry };
    }
    return { claimed: false, payment: existing };
  }
  await initStore();
  const inserted = await pool.query<{ payload: PaymentRecord }>(
    `insert into payment_records (id, group_id, roommate_id, billing_period, task_id, payload, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now()) on conflict (id) do nothing returning payload`,
    [record.id, record.groupId, record.roommateId, record.billingPeriod, record.taskId ?? null, JSON.stringify(record)]
  );
  if (inserted.rows[0]) return { claimed: true, payment: normalizePayment(inserted.rows[0].payload) };
  const existing = await getPaymentById(record.id);
  if (!existing) throw new Error("Payment reservation could not be read after conflict.");
  if (existing.status !== "failed" && existing.status !== "rejected") return { claimed: false, payment: existing };
  const retry = retryRecord(existing);
  const updated = await pool.query<{ payload: PaymentRecord }>(
    `update payment_records set payload = $2::jsonb, updated_at = now()
     where id = $1 and payload->>'status' in ('failed', 'rejected') returning payload`,
    [record.id, JSON.stringify(retry)]
  );
  return updated.rows[0]
    ? { claimed: true, payment: normalizePayment(updated.rows[0].payload) }
    : { claimed: false, payment: (await getPaymentById(record.id)) ?? existing };
}

export async function savePaymentRecords(records: PaymentRecord[]): Promise<PaymentRecord[]> {
  for (const record of records) await savePaymentRecord(record);
  return records;
}

export async function savePaymentRecord(record: PaymentRecord): Promise<PaymentRecord> {
  const next = normalizePayment({ ...record, updatedAt: new Date().toISOString() });
  if (!pool) {
    memory.payments.set(next.id, next);
    return next;
  }
  await initStore();
  await pool.query(
    `insert into payment_records (id, group_id, roommate_id, billing_period, task_id, payload, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now())
     on conflict (id) do update set group_id = excluded.group_id, roommate_id = excluded.roommate_id,
       billing_period = excluded.billing_period, task_id = excluded.task_id, payload = excluded.payload, updated_at = now()`,
    [next.id, next.groupId, next.roommateId, next.billingPeriod, next.taskId ?? null, JSON.stringify(next)]
  );
  return next;
}

export async function claimRentCycle(groupId: string, billingPeriod: string, leaseMs: number): Promise<RentCycle | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const key = `${groupId}:${billingPeriod}`;
  if (!pool) {
    const existing = memory.cycles.get(key);
    if (existing?.status === "completed") return null;
    if (existing && Date.parse(existing.leaseUntil) > now.getTime() && existing.status !== "blocked" && existing.status !== "failed") return null;
    const cycle: RentCycle = {
      groupId,
      billingPeriod,
      status: "running",
      leaseUntil,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      startedAt: existing?.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    memory.cycles.set(key, cycle);
    return cycle;
  }
  await initStore();
  const result = await pool.query<RentCycleRow>(
    `insert into rent_cycles (group_id, billing_period, status, lease_until, attempt_count, started_at, updated_at)
     values ($1, $2, 'running', $3, 1, now(), now())
     on conflict (group_id, billing_period) do update set status = 'running', lease_until = excluded.lease_until,
       attempt_count = rent_cycles.attempt_count + 1, updated_at = now()
     where rent_cycles.status in ('blocked', 'failed')
        or (rent_cycles.status in ('running', 'processing') and rent_cycles.lease_until < now())
     returning group_id, billing_period, status, lease_until, attempt_count, started_at, updated_at`,
    [groupId, billingPeriod, leaseUntil]
  );
  return result.rows[0] ? mapCycle(result.rows[0]) : null;
}

export async function updateRentCycleStatus(groupId: string, billingPeriod: string, status: RentCycleStatus): Promise<void> {
  const key = `${groupId}:${billingPeriod}`;
  if (!pool) {
    const existing = memory.cycles.get(key);
    if (existing) memory.cycles.set(key, { ...existing, status, updatedAt: new Date().toISOString() });
    return;
  }
  await initStore();
  await pool.query("update rent_cycles set status = $3, updated_at = now() where group_id = $1 and billing_period = $2", [groupId, billingPeriod, status]);
}

export async function listAgentEvents(groupId: string): Promise<AgentEvent[]> {
  if (!pool) {
    return Array.from(memory.events.values()).filter((event) => event.groupId === groupId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  await initStore();
  const result = await pool.query<{ payload: AgentEvent }>(
    "select payload from agent_events where group_id = $1 order by created_at desc limit 50",
    [groupId]
  );
  return result.rows.map((row) => row.payload);
}

export async function appendAgentEvent(event: Omit<AgentEvent, "id" | "createdAt">): Promise<AgentEvent> {
  const next: AgentEvent = { ...event, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) {
    memory.events.set(next.id, next);
    return next;
  }
  await initStore();
  await pool.query("insert into agent_events (id, group_id, payload, created_at) values ($1, $2, $3::jsonb, now())", [next.id, next.groupId, JSON.stringify(next)]);
  return next;
}

export async function saveAuthChallenge(challenge: AuthChallenge): Promise<void> {
  if (!pool) {
    memory.challenges.set(challenge.id, challenge);
    return;
  }
  await initStore();
  await pool.query(
    "insert into auth_challenges (id, wallet_address, message, expires_at) values ($1, $2, $3, $4)",
    [challenge.id, challenge.walletAddress.toLowerCase(), challenge.message, challenge.expiresAt]
  );
  await pool.query("delete from auth_challenges where expires_at < now() - interval '1 hour'");
}

export async function getAuthChallenge(id: string): Promise<AuthChallenge | null> {
  if (!pool) return memory.challenges.get(id) ?? null;
  await initStore();
  const result = await pool.query<AuthChallengeRow>(
    "select id, wallet_address, message, expires_at, consumed_at from auth_challenges where id = $1",
    [id]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    walletAddress: row.wallet_address as `0x${string}`,
    message: row.message,
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at?.toISOString()
  } : null;
}

export async function consumeAuthChallenge(id: string): Promise<boolean> {
  if (!pool) {
    const challenge = memory.challenges.get(id);
    if (!challenge || challenge.consumedAt || Date.parse(challenge.expiresAt) <= Date.now()) return false;
    memory.challenges.set(id, { ...challenge, consumedAt: new Date().toISOString() });
    return true;
  }
  await initStore();
  const result = await pool.query(
    "update auth_challenges set consumed_at = now() where id = $1 and consumed_at is null and expires_at > now()",
    [id]
  );
  return Number(result.rowCount ?? 0) === 1;
}

async function getPaymentById(id: string): Promise<PaymentRecord | null> {
  if (!pool) return memory.payments.get(id) ?? null;
  const result = await pool.query<{ payload: PaymentRecord }>("select payload from payment_records where id = $1", [id]);
  return result.rows[0] ? normalizePayment(result.rows[0].payload) : null;
}

function retryRecord(existing: PaymentRecord): PaymentRecord {
  return {
    ...existing,
    status: "preparing",
    attemptCount: existing.attemptCount + 1,
    updatedAt: new Date().toISOString(),
    error: undefined,
    failureStage: undefined
  };
}

function normalizePayment(record: PaymentRecord): PaymentRecord {
  const date = record.date || new Date().toISOString();
  return {
    ...record,
    billingPeriod: record.billingPeriod || date.slice(0, 7),
    idempotencyKey: record.idempotencyKey || `${record.groupId}:${record.roommateId}:${date.slice(0, 7)}`,
    attemptCount: record.attemptCount || 1,
    createdAt: record.createdAt || date,
    updatedAt: record.updatedAt || date
  };
}

function filterGroupsByWallet(groups: RentGroup[], walletAddress?: string): RentGroup[] {
  if (!walletAddress) return groups;
  const wallet = walletAddress.toLowerCase();
  return groups.filter((group) => group.adminWalletAddress?.toLowerCase() === wallet || group.roommates.some((roommate) => roommate.walletAddress.toLowerCase() === wallet));
}

type RentCycleRow = {
  group_id: string;
  billing_period: string;
  status: RentCycleStatus;
  lease_until: Date;
  attempt_count: number;
  started_at: Date;
  updated_at: Date;
};

type AuthChallengeRow = {
  id: string;
  wallet_address: string;
  message: string;
  expires_at: Date;
  consumed_at: Date | null;
};

function mapCycle(row: RentCycleRow): RentCycle {
  return {
    groupId: row.group_id,
    billingPeriod: row.billing_period,
    status: row.status,
    leaseUntil: row.lease_until.toISOString(),
    attemptCount: row.attempt_count,
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
