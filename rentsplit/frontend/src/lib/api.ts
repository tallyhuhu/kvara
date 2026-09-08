import type { AgentEvent, PaymentRecord, PermissionGrant, RentGroup } from "./groupStorage";

const API_URL = import.meta.env?.VITE_API_URL?.replace(/\/$/, "") ?? "";
const SESSION_PREFIX = "kvara.wallet.session.";
let activeWallet: `0x${string}` | null = null;
let sessionGeneration = 0;

type WalletProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type Session = { token: string; expiresAt: string; walletAddress: `0x${string}` };
export type GroupsResponse = { groups: RentGroup[] };
export type GroupResponse = { group: RentGroup };
export type StatusResponse = { payments: PaymentRecord[] };
export type ExecutionConfigResponse = {
  chainId: number;
  tokenAddress: `0x${string}`;
  mode: "aa" | "one-shot";
  configured: boolean;
  executorAddress?: `0x${string}`;
  paymasterEnabled: boolean;
  builderAttribution: "absent" | "configured" | "invalid";
};
export type AgentStateResponse = {
  groupId: string;
  events: AgentEvent[];
  payments: PaymentRecord[];
  nextRunAt?: string;
  autopayEnabled: boolean;
};

export async function authenticateWallet(walletAddress: `0x${string}`, provider: WalletProvider): Promise<void> {
  const generation = ++sessionGeneration;
  activeWallet = walletAddress;
  const assertCurrent = () => {
    if (generation !== sessionGeneration) throw new Error("Wallet changed. Sign in with the current wallet.");
  };
  const existing = readSession(walletAddress);
  if (existing && Date.parse(existing.expiresAt) > Date.now() + 15_000) return;
  const challengeResult = await publicRequest<{ challenge: { id: string; message: string } }>("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ walletAddress })
  });
  assertCurrent();
  const signature = await provider.request({ method: "personal_sign", params: [challengeResult.challenge.message, walletAddress] });
  assertCurrent();
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new Error("MetaMask did not return a valid sign-in signature.");
  }
  const session = await publicRequest<Session>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({
      challengeId: challengeResult.challenge.id,
      walletAddress,
      message: challengeResult.challenge.message,
      signature
    })
  });
  assertCurrent();
  sessionStorage.setItem(sessionKey(walletAddress), JSON.stringify(session));
}

export async function fetchExecutionConfig(): Promise<ExecutionConfigResponse> {
  return publicRequest("/api/execution-config", { method: "GET" });
}

export function clearWalletSession(walletAddress?: string): void {
  if (walletAddress) sessionStorage.removeItem(sessionKey(walletAddress));
  if (!walletAddress || activeWallet?.toLowerCase() === walletAddress.toLowerCase()) {
    activeWallet = null;
    sessionGeneration++;
  }
}

export async function fetchGroups(): Promise<GroupsResponse> {
  return authorizedRequest("/api/groups");
}
export async function fetchGroup(groupId: string): Promise<GroupResponse> {
  return authorizedRequest(`/api/groups/${encodeURIComponent(groupId)}`);
}
export async function createGroupRemote(group: RentGroup): Promise<GroupResponse> {
  return authorizedRequest("/api/groups", { method: "POST", body: JSON.stringify({ group }) });
}
export async function updateGroupRemote(group: RentGroup): Promise<GroupResponse> {
  return authorizedRequest(`/api/groups/${encodeURIComponent(group.id)}`, {
    method: "PUT",
    body: JSON.stringify({ group })
  });
}
export async function savePermissionRemote(groupId: string, roommateId: string, permission: PermissionGrant): Promise<GroupResponse> {
  return authorizedRequest(`/api/groups/${encodeURIComponent(groupId)}/roommates/${encodeURIComponent(roommateId)}/permission`, {
    method: "PUT",
    body: JSON.stringify({ permission })
  });
}
export async function deleteGroupRemote(groupId: string): Promise<{ ok: true; revokedOnchain: false }> {
  return authorizedRequest(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
}
export async function fetchPayments(groupId: string): Promise<{ payments: PaymentRecord[] }> {
  return authorizedRequest(`/api/groups/${encodeURIComponent(groupId)}/payments`);
}
export async function runAgentNow(groupId: string): Promise<AgentStateResponse> {
  return authorizedRequest("/api/agent/run", { method: "POST", body: JSON.stringify({ groupId }) });
}
export async function scheduleAgentGroup(groupId: string): Promise<AgentStateResponse> {
  return authorizedRequest("/api/agent/schedule", { method: "POST", body: JSON.stringify({ groupId }) });
}
export async function getAgentState(groupId: string): Promise<AgentStateResponse> {
  return authorizedRequest(`/api/agent/${encodeURIComponent(groupId)}`);
}
export async function refreshStatuses(groupId: string, taskIds: string[]): Promise<StatusResponse> {
  return authorizedRequest("/api/status", { method: "POST", body: JSON.stringify({ groupId, taskIds }) });
}

export async function authorizedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!activeWallet) throw new Error("Connect and sign in with MetaMask first.");
  const wallet = activeWallet;
  const generation = sessionGeneration;
  const session = readSession(wallet);
  if (!session) throw new Error("Wallet session expired. Reconnect MetaMask.");
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}`, ...init.headers }
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (generation !== sessionGeneration) throw new Error("Wallet changed. This response belongs to the previous session.");
  if (!response.ok) {
    if (response.status === 401) clearWalletSession(wallet);
    throw new Error(json.error ?? `Request failed with ${response.status}`);
  }
  return json;
}

async function publicRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers }
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed with ${response.status}`);
  return json;
}
function readSession(walletAddress: string): Session | null {
  try {
    const value = sessionStorage.getItem(sessionKey(walletAddress));
    return value ? JSON.parse(value) as Session : null;
  } catch {
    return null;
  }
}
function sessionKey(walletAddress: string): string {
  return `${SESSION_PREFIX}${walletAddress.toLowerCase()}`;
}
