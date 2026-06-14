import pg from "pg";
import type { AgentEvent, PaymentRecord, RentGroup } from "./types.js";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    })
  : null;

const memory = {
  groups: new Map<string, RentGroup>(),
  payments: new Map<string, PaymentRecord>(),
  events: new Map<string, AgentEvent>()
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

    create index if not exists payment_records_group_id_idx on payment_records(group_id);

    create table if not exists agent_events (
      id text primary key,
      group_id text not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    );

    create index if not exists agent_events_group_id_idx on agent_events(group_id);
  `).then(() => undefined);
  return initPromise;
}

export function storeMode(): "postgres" | "memory" {
  return pool ? "postgres" : "memory";
}

export async function listGroups(): Promise<RentGroup[]> {
  if (!pool) return Array.from(memory.groups.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>(
    "select payload from rent_groups order by updated_at desc"
  );
  return result.rows.map((row) => row.payload);
}

export async function getGroup(groupId: string): Promise<RentGroup | null> {
  if (!pool) return memory.groups.get(groupId) ?? null;
  await initStore();
  const result = await pool.query<{ payload: RentGroup }>(
    "select payload from rent_groups where id = $1",
    [groupId]
  );
  return result.rows[0]?.payload ?? null;
}

export async function saveGroup(group: RentGroup): Promise<RentGroup> {
  const next = { ...group, updatedAt: Date.now() };
  if (!pool) {
    memory.groups.set(next.id, next);
    return next;
  }
  await initStore();
  await pool.query(
    `insert into rent_groups (id, payload, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
    [next.id, JSON.stringify(next)]
  );
  return next;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  if (!pool) return memory.groups.delete(groupId);
  await initStore();
  const result = await pool.query("delete from rent_groups where id = $1", [groupId]);
  return Number(result.rowCount ?? 0) > 0;
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
  return result.rows.map((row) => row.payload);
}

export async function savePaymentRecords(records: PaymentRecord[]): Promise<PaymentRecord[]> {
  for (const record of records) {
    await savePaymentRecord(record);
  }
  return records;
}

export async function savePaymentRecord(record: PaymentRecord): Promise<PaymentRecord> {
  if (!pool) {
    memory.payments.set(record.id, record);
    return record;
  }
  await initStore();
  await pool.query(
    `insert into payment_records (id, group_id, payload, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
    [record.id, record.groupId, JSON.stringify(record)]
  );
  return record;
}

export async function listAgentEvents(groupId: string): Promise<AgentEvent[]> {
  if (!pool) {
    return Array.from(memory.events.values())
      .filter((event) => event.groupId === groupId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  await initStore();
  const result = await pool.query<{ payload: AgentEvent }>(
    "select payload from agent_events where group_id = $1 order by created_at desc limit 50",
    [groupId]
  );
  return result.rows.map((row) => row.payload);
}

export async function appendAgentEvent(event: Omit<AgentEvent, "id" | "createdAt">): Promise<AgentEvent> {
  const next: AgentEvent = {
    ...event,
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString()
  };

  if (!pool) {
    memory.events.set(next.id, next);
    return next;
  }
  await initStore();
  await pool.query(
    "insert into agent_events (id, group_id, payload, created_at) values ($1, $2, $3::jsonb, now())",
    [next.id, next.groupId, JSON.stringify(next)]
  );
  return next;
}
