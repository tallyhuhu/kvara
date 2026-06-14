import type { AgentEvent, PaymentRecord, RentGroup } from "./groupStorage";

const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export type CollectResponse = {
  payments: PaymentRecord[];
};

export type GroupsResponse = {
  groups: RentGroup[];
};

export type GroupResponse = {
  group: RentGroup;
};

export type StatusResponse = {
  payments: PaymentRecord[];
};

export type AgentRunResponse = {
  payments: PaymentRecord[];
  events: AgentEvent[];
  nextRunAt?: string;
  running: boolean;
};

export type AgentStateResponse = {
  events: AgentEvent[];
  payments: PaymentRecord[];
  nextRunAt?: string;
  running: boolean;
};

export async function collectAndPay(group: RentGroup): Promise<CollectResponse> {
  return postJson<CollectResponse>("/api/collect", { group });
}

export async function fetchGroups(): Promise<GroupsResponse> {
  const response = await fetch(`${API_URL}/api/groups`);
  const json = (await response.json().catch(() => ({}))) as GroupsResponse & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed with ${response.status}`);
  return json;
}

export async function fetchGroup(groupId: string): Promise<GroupResponse> {
  const response = await fetch(`${API_URL}/api/groups/${groupId}`);
  const json = (await response.json().catch(() => ({}))) as GroupResponse & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed with ${response.status}`);
  return json;
}

export async function saveGroupRemote(group: RentGroup): Promise<GroupResponse> {
  return postJson<GroupResponse>("/api/groups", { group });
}

export async function deleteGroupRemote(groupId: string): Promise<{ ok: true }> {
  const response = await fetch(`${API_URL}/api/groups/${groupId}`, { method: "DELETE" });
  const json = (await response.json().catch(() => ({}))) as { ok?: true; error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed with ${response.status}`);
  return { ok: true };
}

export async function fetchPayments(groupId: string): Promise<CollectResponse> {
  const response = await fetch(`${API_URL}/api/groups/${groupId}/payments`);
  const json = (await response.json().catch(() => ({}))) as CollectResponse & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed with ${response.status}`);
  return json;
}

export async function runAgentNow(group: RentGroup): Promise<AgentRunResponse> {
  return postJson<AgentRunResponse>("/api/agent/run", { group });
}

export async function scheduleAgentGroup(group: RentGroup): Promise<AgentStateResponse> {
  return postJson<AgentStateResponse>("/api/agent/schedule", { group });
}

export async function getAgentState(groupId: string): Promise<AgentStateResponse> {
  const response = await fetch(`${API_URL}/api/agent/${groupId}`);
  const json = (await response.json().catch(() => ({}))) as AgentStateResponse & { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? `Request failed with ${response.status}`);
  }
  return json;
}

export async function refreshStatuses(taskIds: string[]): Promise<StatusResponse> {
  return postJson<StatusResponse>("/api/status", { taskIds });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? `Request failed with ${response.status}`);
  }
  return json;
}
