import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  CalendarClock,
  Check,
  Copy,
  DoorOpen,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Wallet,
  X
} from "lucide-react";
import { isAddress } from "viem";
import { getAgentState, refreshStatuses, runAgentNow } from "../lib/api";
import { sendVeniceMessage } from "../lib/veniceClient";
import { useMetaMaskPermissions } from "../hooks/useMetaMaskPermissions";
import {
  createInviteUrl,
  formatUsd,
  normalizeAddress,
  permissionStatus,
  type AgentEvent,
  type PaymentRecord,
  type PermissionGrant,
  type RentCommand,
  type RentGroup,
  type Roommate
} from "../lib/groupStorage";

type CreateGroupInput = {
  adminWalletAddress?: `0x${string}`;
  propertyName: string;
  propertyAddress: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  dueDay: number;
  nextRunAt: string;
  rentRunTime: string;
  autopayEnabled: boolean;
  permissionBufferPercent: number;
  roommates: Array<{ name: string; walletAddress: `0x${string}`; share?: string }>;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type SetupDraft = {
  propertyAddress: string;
  landlordAddress: string;
  totalRent: string;
  dueDay: string;
  rentRunTime: string;
  residents: SetupResident[];
};

type SetupResident = {
  id: string;
  name: string;
  walletAddress: string;
  share: string;
};

type Props = {
  group: RentGroup | null;
  inviteRoommate: Roommate | null;
  isInvite: boolean;
  history: PaymentRecord[];
  stats: { granted: number; total: number; monthlyTotal: number };
  onCreate: (input: CreateGroupInput) => RentGroup;
  onPermissionGranted: (roommateId: string, permission: PermissionGrant) => void;
  onDeleteGroup: (groupId: string) => RentGroup | null;
  onWalletConnected: (walletAddress: `0x${string}`) => Promise<RentGroup[]>;
  onPaymentsUpdated: (records: PaymentRecord[]) => void;
  onCommands: (commands: RentCommand[]) => void;
};

const DEFAULT_BUFFER_PERCENT = 30;

type MetaMaskProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: "accountsChanged" | "chainChanged", handler: (value: unknown) => void) => void;
  removeListener?: (event: "accountsChanged" | "chainChanged", handler: (value: unknown) => void) => void;
};

export function KvaraChatWorkspace({
  group,
  inviteRoommate,
  isInvite,
  history,
  stats,
  onCreate,
  onPermissionGranted,
  onDeleteGroup,
  onWalletConnected,
  onPaymentsUpdated,
  onCommands
}: Props) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({
    propertyAddress: "",
    landlordAddress: "",
    totalRent: "3000.00",
    dueDay: "1",
    rentRunTime: "09:00",
    residents: []
  });
  const [setupError, setSetupError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [pendingCommands, setPendingCommands] = useState<RentCommand[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const { loading: permissionLoading, error: permissionError, detail, requestRentPermission } = useMetaMaskPermissions();

  const connectedRoommate = useMemo(() => {
    if (!group || !account) return null;
    return group.roommates.find((roommate) => sameAddress(roommate.walletAddress, account)) ?? null;
  }, [account, group]);
  const greeting = connectedRoommate ? residentGreeting(connectedRoommate) : null;
  const visibleGroup = account || isInvite ? group : null;
  const canManageGroup = Boolean(
    account && group && !isInvite && (!group.adminWalletAddress || sameAddress(group.adminWalletAddress, account))
  );

  const inviteWalletMatches = Boolean(
    !inviteRoommate || !account || sameAddress(inviteRoommate.walletAddress, account)
  );
  const pendingTaskIds = useMemo(
    () =>
      history
        .filter((record) => record.taskId && (record.status === "pending" || record.status === "submitted"))
        .map((record) => record.taskId as string),
    [history]
  );

  const handleWalletAccount = useCallback(
    async (nextAccount: `0x${string}`) => {
      setConnectError(null);
      setAccount(nextAccount);
      if (!isInvite) {
        await onWalletConnected(nextAccount);
      }
    },
    [isInvite, onWalletConnected]
  );

  useEffect(() => {
    if (!account) return;
    setSetupDraft((current) => {
      if (current.residents.some((resident) => sameAddress(resident.walletAddress, account))) return current;
      return {
        ...current,
        residents: [
          {
            id: createMessageId("resident"),
            name: "You",
            walletAddress: account,
            share: ""
          },
          ...current.residents
        ]
      };
    });
  }, [account]);

  useEffect(() => {
    const ethereum = window.ethereum as MetaMaskProvider | undefined;
    if (!ethereum?.on) return;

    const handleAccountsChanged = (value: unknown) => {
      const accounts = Array.isArray(value) ? value : [];
      const nextAccount = typeof accounts[0] === "string" ? (accounts[0] as `0x${string}`) : null;
      if (!nextAccount) {
        setAccount(null);
        setConnectError(null);
        return;
      }
      handleWalletAccount(nextAccount).catch((cause) => {
        setConnectError(cause instanceof Error ? cause.message : "Could not load this wallet.");
      });
    };

    const handleChainChanged = () => {
      setConnectError(null);
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
      ethereum.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [handleWalletAccount]);

  useEffect(() => {
    if (!group) return;
    const groupId = group.id;
    let cancelled = false;

    async function loadAgentState() {
      const response = await getAgentState(groupId);
      if (cancelled) return;
      setAgentEvents(response.events);
      setAgentRunning(response.running);
      if (response.payments.length > 0) onPaymentsUpdated(response.payments);
    }

    loadAgentState().catch(() => undefined);
    const interval = window.setInterval(() => {
      loadAgentState().catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [group, onPaymentsUpdated]);

  useEffect(() => {
    if (pendingTaskIds.length === 0) return;
    const interval = window.setInterval(async () => {
      try {
        const response = await refreshStatuses(pendingTaskIds);
        onPaymentsUpdated(response.payments);
      } catch {
        window.clearInterval(interval);
      }
    }, 3000);
    return () => window.clearInterval(interval);
  }, [onPaymentsUpdated, pendingTaskIds]);

  async function connectWallet() {
    setConnectError(null);
    try {
      const ethereum = window.ethereum as MetaMaskProvider | undefined;
      if (!ethereum) throw new Error("MetaMask is not available in this browser.");
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
      if (!accounts[0]) throw new Error("No wallet account returned.");
      await handleWalletAccount(accounts[0]);
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : "Could not connect wallet.");
    }
  }

  async function switchWallet() {
    setConnectError(null);
    try {
      const ethereum = window.ethereum as MetaMaskProvider | undefined;
      if (!ethereum) throw new Error("MetaMask is not available in this browser.");
      try {
        await ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      } catch (cause) {
        const error = cause as { code?: number };
        if (error.code === 4001) throw cause;
      }
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
      if (!accounts[0]) throw new Error("No wallet account returned.");
      await handleWalletAccount(accounts[0]);
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : "Could not switch wallet.");
    }
  }

  async function disconnectWallet() {
    const ethereum = window.ethereum as MetaMaskProvider | undefined;
    try {
      await ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Some wallets do not expose revocation; local session reset is still useful.
    }
    setAccount(null);
    setConnectError(null);
  }

  function handleCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupError(null);

    try {
      if (!account) throw new Error("Connect MetaMask first.");
      const roommates = ensureCurrentResident(parseResidentRows(setupDraft.residents, account), account);
      if (roommates.length === 0) throw new Error("Add at least one resident wallet.");
      const propertyAddress = setupDraft.propertyAddress.trim();
      if (!propertyAddress) throw new Error("Add the apartment address.");
      const totalRent = setupDraft.totalRent.trim();
      if (!Number(totalRent) || Number(totalRent) <= 0) throw new Error("Add the monthly rent.");
      const schedule = buildRentSchedule(setupDraft.dueDay, setupDraft.rentRunTime);

      const created = onCreate({
        adminWalletAddress: account,
        propertyName: derivePropertyName(propertyAddress),
        propertyAddress,
        landlordAddress: normalizeAddress(setupDraft.landlordAddress),
        totalRent,
        dueDay: schedule.dueDay,
        nextRunAt: schedule.nextRunAt,
        rentRunTime: schedule.rentRunTime,
        autopayEnabled: true,
        permissionBufferPercent: DEFAULT_BUFFER_PERCENT,
        roommates
      });

      setMessages([
        {
          id: createMessageId("assistant"),
          role: "assistant",
          text: `${created.propertyName} is ready. I prepared invite links and will ask each resident for a bounded permission.`
        }
      ]);
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : "Could not create apartment.");
    }
  }

  async function grantPermission(roommate: Roommate) {
    if (!group) return;
    const permission = await requestRentPermission(group, roommate);
    onPermissionGranted(roommate.id, permission);
    pushAssistant("Permission is active. Kvara can now include this wallet in the rent run.");
  }

  async function runAgentDemo() {
    if (!group) return;
    setRunningNow(true);
    try {
      const response = await runAgentNow(group);
      onPaymentsUpdated(response.payments);
      setAgentEvents(response.events);
      setAgentRunning(response.running);
      pushAssistant("I ran the rent agent now for the demo. Payment status is updated below.");
    } catch (cause) {
      pushAssistant(cause instanceof Error ? cause.message : "Agent run failed.");
    } finally {
      setRunningNow(false);
    }
  }

  function endLease() {
    if (!group || !canManageGroup) return;
    const name = group.propertyName;
    const deleted = onDeleteGroup(group.id);
    if (!deleted) return;
    setMessages([
      {
        id: createMessageId("assistant"),
        role: "assistant",
        text: `${name} is closed. Kvara will not run this lease again.`
      }
    ]);
  }

  async function askKvara(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || asking) return;
    setInput("");
    pushUser(message);

    if (!group) {
      pushAssistant("Create an apartment first, then I can recalculate splits and answer rent history questions.");
      return;
    }

    setAsking(true);
    try {
      const response = await sendVeniceMessage({ message, group, history });
      setPendingCommands(response.commands);
      pushAssistant(response.message);
    } catch (cause) {
      pushAssistant(cause instanceof Error ? cause.message : "Kvara agent request failed.");
    } finally {
      setAsking(false);
    }
  }

  function applyPendingCommands() {
    onCommands(pendingCommands);
    setPendingCommands([]);
    pushAssistant("Applied. The rent split is updated.");
  }

  async function copyInvite(roommate: Roommate) {
    if (!group) return;
    await navigator.clipboard.writeText(createInviteUrl(group, roommate.id));
    setCopiedInviteId(roommate.id);
    window.setTimeout(() => setCopiedInviteId(null), 1400);
  }

  function pushUser(text: string) {
    setMessages((current) => [...current, { id: createMessageId("user"), role: "user", text }]);
  }

  function pushAssistant(text: string) {
    setMessages((current) => [...current, { id: createMessageId("assistant"), role: "assistant", text }]);
  }

  return (
    <main className="min-h-[100dvh] bg-[#e9e3d7] text-stone-950">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1180px] flex-col px-3 py-3 sm:px-5 sm:py-5">
        <header className="mb-3 flex items-center justify-between gap-3 border border-stone-300 bg-[#f8f2e8] px-4 py-3">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-xl font-semibold leading-none text-stone-950">Kvara</p>
              <p className="mt-1 text-xs text-stone-500">Autonomous rent desk</p>
            </div>
          </div>
          {account ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-600">
                {shortAddress(account)}
              </span>
              <button
                type="button"
                onClick={switchWallet}
                className="inline-flex h-9 items-center gap-2 border border-stone-300 bg-white px-3 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 active:translate-y-[1px]"
              >
                <RefreshCw size={14} />
                Switch
              </button>
              <button
                type="button"
                onClick={disconnectWallet}
                className="inline-flex h-9 items-center gap-2 border border-stone-300 bg-white px-3 text-xs font-semibold text-stone-500 transition hover:bg-stone-50 active:translate-y-[1px]"
              >
                <X size={14} />
                Disconnect
              </button>
            </div>
          ) : null}
        </header>

        <section className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-h-[620px] flex-col border border-stone-300 bg-[#f8f2e8]">
            <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-5">
              <AssistantBubble>
                {!account
                  ? "Connect your wallet first. I will understand whether you are creating a new apartment or accepting an invite."
                  : isInvite
                    ? `You were invited to ${group?.propertyName ?? "an apartment"}. I can request the bounded permission when you are ready.`
                    : group
                      ? canManageGroup
                        ? `${greeting ? `${greeting}. ` : ""}I found ${group.propertyName}. You can ask me to recalculate rent, copy invites, or run the demo rent day.`
                        : connectedRoommate
                          ? `${greeting ? `${greeting}. ` : ""}I found ${group.propertyName}. I can request your bounded permission for this home.`
                          : `I found ${group.propertyName}. You can ask me rent questions from this wallet.`
                      : "This wallet has no Kvara apartment yet. Tell me the basics and I will prepare the rent room."}
              </AssistantBubble>

              {!account ? (
                <ActionBubble>
                  <button
                    type="button"
                    onClick={connectWallet}
                    className="inline-flex h-11 items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 active:translate-y-[1px]"
                  >
                    <Wallet size={17} />
                    Connect MetaMask
                  </button>
                  {connectError ? <p className="mt-3 text-sm text-rose-700">{connectError}</p> : null}
                </ActionBubble>
              ) : null}

              {account && connectError ? (
                <ActionBubble>
                  <p className="text-sm text-rose-700">{connectError}</p>
                </ActionBubble>
              ) : null}

              {account && isInvite && group && inviteRoommate ? (
                <InvitePermissionBubble
                  group={group}
                  roommate={inviteRoommate}
                  walletMatches={inviteWalletMatches}
                  loading={permissionLoading}
                  detail={detail}
                  error={permissionError}
                  connectedWallet={account}
                  onSwitchWallet={switchWallet}
                  onGrant={() => grantPermission(inviteRoommate)}
                />
              ) : null}

              {account && !isInvite && !group ? (
                <SetupBubble
                  draft={setupDraft}
                  error={setupError}
                  onChange={setSetupDraft}
                  onSubmit={handleCreateGroup}
                />
              ) : null}

              {account && group && !isInvite ? (
                <ApartmentActionsBubble
                  group={group}
                  connectedRoommate={connectedRoommate}
                  canManageGroup={canManageGroup}
                  permissionLoading={permissionLoading}
                  permissionDetail={detail}
                  permissionError={permissionError}
                  running={runningNow || agentRunning}
                  copiedInviteId={copiedInviteId}
                  onGrant={grantPermission}
                  onCopyInvite={copyInvite}
                  onRunAgent={runAgentDemo}
                />
              ) : null}

              {messages.map((message) =>
                message.role === "assistant" ? (
                  <AssistantBubble key={message.id}>{message.text}</AssistantBubble>
                ) : (
                  <UserBubble key={message.id}>{message.text}</UserBubble>
                )
              )}

              {pendingCommands.length > 0 ? (
                <ActionBubble>
                  <p className="text-sm font-semibold text-stone-950">{commandSummary(pendingCommands)}</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={applyPendingCommands}
                      className="inline-flex h-9 items-center gap-2 bg-emerald-950 px-3 text-sm font-semibold text-white transition hover:bg-emerald-900"
                    >
                      <Check size={15} />
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingCommands([])}
                      className="inline-flex h-9 items-center gap-2 border border-stone-400 px-3 text-sm font-semibold text-stone-700 transition hover:bg-white"
                    >
                      <X size={15} />
                      Dismiss
                    </button>
                  </div>
                </ActionBubble>
              ) : null}
            </div>

            <form onSubmit={askKvara} className="flex gap-2 border-t border-stone-300 p-3">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={group ? "Maya is away for two weeks, update the split" : "Create an apartment first"}
                disabled={!account}
                className="min-w-0 flex-1 border border-stone-300 bg-white px-3 py-3 text-sm outline-none transition focus:border-emerald-800 disabled:bg-stone-100"
              />
              <button
                type="submit"
                disabled={!account || asking}
                className="grid h-12 w-12 place-items-center bg-emerald-950 text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
                aria-label="Send"
                title="Send"
              >
                {asking ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </form>
          </div>

          <ApartmentSnapshot
            group={visibleGroup}
            inviteRoommate={inviteRoommate}
            setupDraft={setupDraft}
            stats={stats}
            history={history}
            events={agentEvents}
            canManageGroup={canManageGroup}
            onEndLease={endLease}
          />
        </section>
      </div>
    </main>
  );
}

function AssistantBubble({ children }: { children: string }) {
  return (
    <div className="flex gap-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center bg-emerald-950 text-stone-50">
        <Bot size={16} />
      </div>
      <div className="max-w-[760px] border border-stone-300 bg-white px-4 py-3 text-sm leading-relaxed text-stone-800">
        {children}
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[720px] bg-emerald-950 px-4 py-3 text-sm leading-relaxed text-white">{children}</div>
    </div>
  );
}

function ActionBubble({ children }: { children: ReactNode }) {
  return <div className="ml-11 max-w-[760px] border border-stone-300 bg-[#efe7d8] p-4">{children}</div>;
}

function SetupBubble({
  draft,
  error,
  onChange,
  onSubmit
}: {
  draft: SetupDraft;
  error: string | null;
  onChange: (draft: SetupDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  function updateResident(id: string, patch: Partial<SetupResident>) {
    onChange({
      ...draft,
      residents: draft.residents.map((resident) => (resident.id === id ? { ...resident, ...patch } : resident))
    });
  }

  function addResident() {
    onChange({
      ...draft,
      residents: [
        ...draft.residents,
        {
          id: createMessageId("resident"),
          name: "",
          walletAddress: "",
          share: ""
        }
      ]
    });
  }

  function removeResident(id: string) {
    if (draft.residents.length <= 1) return;
    onChange({ ...draft, residents: draft.residents.filter((resident) => resident.id !== id) });
  }

  return (
    <ActionBubble>
      <form onSubmit={onSubmit} className="grid gap-3">
        <Field label="Apartment address">
          <input
            value={draft.propertyAddress}
            onChange={(event) => onChange({ ...draft, propertyAddress: event.target.value })}
            placeholder="24 Maple St, Apt 6B"
            className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Monthly rent, USDC">
            <input
              value={draft.totalRent}
              onChange={(event) => onChange({ ...draft, totalRent: event.target.value })}
              type="number"
              min="0"
              step="0.01"
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
            />
          </Field>
          <Field label="Landlord wallet">
            <input
              value={draft.landlordAddress}
              onChange={(event) => onChange({ ...draft, landlordAddress: event.target.value })}
              placeholder="0x..."
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
          <Field label="Rent day">
            <input
              value={draft.dueDay}
              onChange={(event) => onChange({ ...draft, dueDay: event.target.value })}
              type="number"
              min="1"
              max="28"
              step="1"
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
            />
          </Field>
          <Field label="Run time">
            <input
              value={draft.rentRunTime}
              onChange={(event) => onChange({ ...draft, rentRunTime: event.target.value })}
              type="time"
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
            />
          </Field>
        </div>
        <Field label="Residents">
          <div className="border border-stone-300 bg-white">
            <div className="hidden grid-cols-[1fr_1.5fr_104px_42px] border-b border-stone-300 bg-stone-50 px-3 py-2 text-[11px] font-semibold uppercase text-stone-500 md:grid">
              <span>Name</span>
              <span>Wallet</span>
              <span>Share</span>
              <span />
            </div>
            <div className="divide-y divide-stone-200">
              {draft.residents.map((resident, index) => (
                <div key={resident.id} className="grid gap-2 px-3 py-3 md:grid-cols-[1fr_1.5fr_104px_42px] md:items-center">
                  <input
                    value={resident.name}
                    onChange={(event) => updateResident(resident.id, { name: event.target.value })}
                    placeholder={index === 0 ? "Your name" : "Maya"}
                    className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
                    aria-label="Resident name"
                  />
                  <input
                    value={resident.walletAddress}
                    onChange={(event) => updateResident(resident.id, { walletAddress: event.target.value })}
                    placeholder="0x..."
                    className="w-full border border-stone-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-emerald-800"
                    aria-label="Resident wallet"
                  />
                  <input
                    value={resident.share}
                    onChange={(event) => updateResident(resident.id, { share: event.target.value })}
                    placeholder="Auto"
                    type="number"
                    min="0"
                    step="0.01"
                    className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
                    aria-label="Resident rent share"
                  />
                  <button
                    type="button"
                    onClick={() => removeResident(resident.id)}
                    disabled={draft.residents.length <= 1}
                    className="grid h-10 w-10 place-items-center border border-stone-300 text-stone-500 transition hover:bg-stone-50 disabled:opacity-30"
                    aria-label="Remove resident"
                    title="Remove resident"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addResident}
              className="flex h-10 w-full items-center justify-center gap-2 border-t border-stone-300 text-sm font-semibold text-emerald-900 transition hover:bg-stone-50"
            >
              <Plus size={15} />
              Add resident
            </button>
          </div>
        </Field>
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
        <button
          type="submit"
          className="inline-flex h-11 w-fit items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 active:translate-y-[1px]"
        >
          Prepare apartment
          <ArrowUpRight size={16} />
        </button>
      </form>
    </ActionBubble>
  );
}

function InvitePermissionBubble({
  group,
  roommate,
  walletMatches,
  loading,
  detail,
  error,
  connectedWallet,
  onSwitchWallet,
  onGrant
}: {
  group: RentGroup;
  roommate: Roommate;
  walletMatches: boolean;
  loading: boolean;
  detail?: string;
  error?: string;
  connectedWallet: `0x${string}` | null;
  onSwitchWallet: () => void;
  onGrant: () => void;
}) {
  const status = permissionStatus(roommate);
  return (
    <ActionBubble>
      <p className="text-sm font-semibold text-stone-950">{group.propertyName}</p>
      <p className="mt-1 text-sm text-stone-600">
        Your monthly share is {formatUsd(roommate.share)} USDC with a +{group.permissionBufferPercent}% buffer.
      </p>
      {!walletMatches ? (
        <div className="mt-3 border border-rose-200 bg-white px-3 py-3">
          <p className="text-sm text-rose-700">
            MetaMask is using {connectedWallet ? shortAddress(connectedWallet) : "another wallet"}. This invite belongs
            to {` ${shortAddress(roommate.walletAddress)}`}.
          </p>
          <button
            type="button"
            onClick={onSwitchWallet}
            className="mt-3 inline-flex h-9 items-center gap-2 border border-stone-400 bg-white px-3 text-xs font-semibold text-stone-800 transition hover:bg-stone-50 active:translate-y-[1px]"
          >
            <RefreshCw size={14} />
            Switch wallet
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
      <button
        type="button"
        onClick={onGrant}
        disabled={!walletMatches || loading || status === "granted"}
        className="mt-4 inline-flex h-11 items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
      >
        <ShieldCheck size={17} />
        {status === "granted" ? "Permission active" : loading ? detail ?? "Opening MetaMask" : "Grant permission"}
      </button>
    </ActionBubble>
  );
}

function ApartmentActionsBubble({
  group,
  connectedRoommate,
  permissionLoading,
  permissionDetail,
  permissionError,
  canManageGroup,
  running,
  copiedInviteId,
  onGrant,
  onCopyInvite,
  onRunAgent
}: {
  group: RentGroup;
  connectedRoommate: Roommate | null;
  canManageGroup: boolean;
  permissionLoading: boolean;
  permissionDetail?: string;
  permissionError?: string;
  running: boolean;
  copiedInviteId: string | null;
  onGrant: (roommate: Roommate) => void;
  onCopyInvite: (roommate: Roommate) => void;
  onRunAgent: () => void;
}) {
  const needsPermission = connectedRoommate && permissionStatus(connectedRoommate) !== "granted";
  if (!needsPermission && !canManageGroup) return null;

  return (
    <ActionBubble>
      <div className="flex flex-wrap gap-2">
        {needsPermission ? (
          <button
            type="button"
            onClick={() => onGrant(connectedRoommate)}
            disabled={permissionLoading}
            className="inline-flex h-10 items-center gap-2 bg-emerald-950 px-3 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
          >
            <ShieldCheck size={16} />
            {permissionLoading ? permissionDetail ?? "Opening MetaMask" : "Grant my permission"}
          </button>
        ) : null}
        {canManageGroup ? (
          <button
            type="button"
            onClick={onRunAgent}
            disabled={running}
            className="inline-flex h-10 items-center gap-2 border border-stone-400 bg-white px-3 text-sm font-semibold text-stone-800 transition hover:bg-stone-50 disabled:text-stone-400"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Demo rent day
          </button>
        ) : null}
      </div>
      {permissionError ? <p className="mt-3 text-sm text-rose-700">{permissionError}</p> : null}
      {canManageGroup ? (
        <div className="mt-4 divide-y divide-stone-300 border border-stone-300 bg-white">
          {group.roommates.map((roommate) => (
            <button
              key={roommate.id}
              type="button"
              onClick={() => onCopyInvite(roommate)}
              className="grid w-full gap-3 px-3 py-3 text-left text-sm transition hover:bg-stone-50 sm:grid-cols-[1fr_auto_auto] sm:items-center"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold text-stone-900">{residentDisplayName(roommate)}</span>
                <span className="mt-1 block truncate font-mono text-xs text-stone-500">
                  {shortAddress(roommate.walletAddress)}
                </span>
              </span>
              <span className="text-xs font-semibold uppercase text-stone-500">
                {formatUsd(roommate.share)} USDC - {residentPermissionLabel(roommate)}
              </span>
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-800">
                {copiedInviteId === roommate.id ? "Copied" : "Invite"}
                <Copy size={14} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </ActionBubble>
  );
}

function ApartmentSnapshot({
  group,
  inviteRoommate,
  setupDraft,
  stats,
  history,
  events,
  canManageGroup,
  onEndLease
}: {
  group: RentGroup | null;
  inviteRoommate: Roommate | null;
  setupDraft: SetupDraft;
  stats: { granted: number; total: number; monthlyTotal: number };
  history: PaymentRecord[];
  events: AgentEvent[];
  canManageGroup: boolean;
  onEndLease: () => void;
}) {
  const hasDraft = Boolean(
    setupDraft.propertyAddress.trim() ||
      setupDraft.landlordAddress.trim() ||
      setupDraft.residents.some((resident) => resident.name.trim() || resident.walletAddress.trim())
  );

  return (
    <aside className="border border-stone-300 bg-[#f8f2e8]">
      <div className="border-b border-stone-300 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-stone-500">Home brief</p>
            <h2 className="mt-2 text-3xl font-semibold leading-none text-stone-950">
              {group?.propertyName ??
                (setupDraft.propertyAddress ? derivePropertyName(setupDraft.propertyAddress) : "Not connected")}
            </h2>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-stone-600">
          {group
            ? "Kvara is ready to coordinate rent for this home."
            : hasDraft
              ? "This home is being prepared in the chat."
              : "Connect a wallet to open or create a home."}
        </p>
      </div>

      <div className="grid grid-cols-2 border-b border-stone-300">
        <BriefMetric label="Monthly rent" value={group ? `${formatUsd(group.totalRent)} USDC` : hasDraft ? `${formatUsd(setupDraft.totalRent)} USDC` : "Waiting"} />
        <BriefMetric
          label="Residents ready"
          value={group ? `${stats.granted}/${stats.total}` : hasDraft ? `${parseResidentRowsSafe(setupDraft.residents).length}` : "Waiting"}
        />
      </div>

      <div className="space-y-4 p-4 text-sm">
        <SnapshotRow label="Place" value={group?.propertyAddress || setupDraft.propertyAddress || "Waiting for address"} />
        <SnapshotRow
          label="Rent day"
          value={
            group?.autopayEnabled
              ? formatRentRun(group.nextRunAt, group.dueDay, group.rentRunTime)
              : group
                ? "Paused"
                : formatDraftRentRun(setupDraft.dueDay, setupDraft.rentRunTime)
          }
        />
        {inviteRoommate ? <SnapshotRow label="Your part" value={`${formatUsd(inviteRoommate.share)} USDC`} /> : null}
        {group ? <SnapshotRow label="Collected this month" value={`${formatUsd(stats.monthlyTotal)} USDC`} /> : null}
      </div>

      <div className="border-t border-stone-300 p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-stone-500">
          <CalendarClock size={14} />
          Latest note
        </div>
        {events[0] ? (
          <p className="text-sm leading-relaxed text-stone-700">{events[0].message}</p>
        ) : history[0] ? (
          <p className="text-sm leading-relaxed text-stone-700">
            {history[0].roommateName}: {humanPaymentStatus(history[0].status)}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-stone-500">Nothing has happened yet.</p>
        )}
      </div>

      {group && canManageGroup ? (
        <div className="border-t border-stone-300 p-4">
          <button
            type="button"
            onClick={onEndLease}
            className="inline-flex h-10 w-full items-center justify-center gap-2 border border-stone-400 bg-white px-3 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 active:translate-y-[1px]"
          >
            <DoorOpen size={16} />
            End lease
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function BriefMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-stone-300 p-4 last:border-r-0">
      <p className="text-xs font-semibold uppercase text-stone-500">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold leading-tight text-stone-950">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase text-stone-500">{label}</span>
      {children}
    </label>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-stone-300 pt-3 first:border-t-0 first:pt-0">
      <dt className="text-xs font-semibold uppercase text-stone-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-stone-950">{value}</dd>
    </div>
  );
}

function humanPaymentStatus(status: PaymentRecord["status"]): string {
  if (status === "confirmed") return "paid";
  if (status === "submitted" || status === "pending") return "in progress";
  return "needs attention";
}

function parseResidentRows(
  residents: SetupResident[],
  account?: `0x${string}`
): Array<{ name: string; walletAddress: `0x${string}`; share?: string }> {
  const seen = new Set<string>();
  const parsed: Array<{ name: string; walletAddress: `0x${string}`; share?: string }> = [];

  residents.forEach((resident, index) => {
    const walletAddress = resident.walletAddress.trim();
    const hasAnyValue = resident.name.trim() || walletAddress || resident.share.trim();
    if (!hasAnyValue) return;
    if (!isAddress(walletAddress)) throw new Error(`Resident ${index + 1} needs a valid wallet address.`);

    const normalizedWallet = walletAddress.toLowerCase();
    if (seen.has(normalizedWallet)) throw new Error("Resident wallets must be unique.");
    seen.add(normalizedWallet);

    const share = resident.share.trim();
    if (share && (!Number(share) || Number(share) <= 0)) {
      throw new Error(`Resident ${index + 1} needs a valid rent share or an empty auto split.`);
    }

    parsed.push({
      name:
        resident.name.trim() ||
        (account && sameAddress(walletAddress, account) ? "You" : `Resident ${parsed.length + 1}`),
      walletAddress: walletAddress as `0x${string}`,
      share: share || undefined
    });
  });

  return parsed;
}

function parseResidentRowsSafe(
  residents: SetupResident[]
): Array<{ name: string; walletAddress: `0x${string}`; share?: string }> {
  try {
    return parseResidentRows(residents);
  } catch {
    return [];
  }
}

function ensureCurrentResident(
  roommates: Array<{ name: string; walletAddress: `0x${string}`; share?: string }>,
  account: `0x${string}`
): Array<{ name: string; walletAddress: `0x${string}`; share?: string }> {
  if (roommates.some((roommate) => sameAddress(roommate.walletAddress, account))) return roommates;
  return [{ name: "You", walletAddress: account }, ...roommates];
}

function buildRentSchedule(dueDayValue: string, rentRunTimeValue: string): {
  dueDay: number;
  rentRunTime: string;
  nextRunAt: string;
} {
  const dueDay = clampDay(Number(dueDayValue));
  const rentRunTime = normalizeRentRunTime(rentRunTimeValue);
  const [hour, minute] = rentRunTime.split(":").map(Number);
  const nextRun = new Date();
  nextRun.setHours(hour, minute, 0, 0);
  nextRun.setDate(Math.min(dueDay, daysInMonth(nextRun.getFullYear(), nextRun.getMonth())));
  if (nextRun.getTime() <= Date.now()) {
    nextRun.setMonth(nextRun.getMonth() + 1);
    nextRun.setDate(Math.min(dueDay, daysInMonth(nextRun.getFullYear(), nextRun.getMonth())));
  }

  return { dueDay, rentRunTime, nextRunAt: nextRun.toISOString() };
}

function formatDraftRentRun(dueDay: string, rentRunTime: string): string {
  const schedule = buildRentSchedule(dueDay, rentRunTime);
  return `Day ${schedule.dueDay} at ${schedule.rentRunTime}`;
}

function formatRentRun(nextRunAt: string | undefined, dueDay: number, rentRunTime: string): string {
  if (!nextRunAt) return `Day ${dueDay} at ${rentRunTime}`;
  return `Next ${new Date(nextRunAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function residentDisplayName(roommate: Roommate): string {
  return roommate.name.trim() || shortAddress(roommate.walletAddress);
}

function residentGreeting(roommate: Roommate): string {
  const name = residentDisplayName(roommate);
  if (name.toLowerCase() === "you" || name.toLowerCase() === "me") return "Welcome back";
  return `Welcome, ${name}`;
}

function residentPermissionLabel(roommate: Roommate): string {
  const status = permissionStatus(roommate);
  if (status === "granted") return "ready";
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  return "pending";
}

function normalizeRentRunTime(value: string): string {
  if (!/^\d{2}:\d{2}$/.test(value)) return "09:00";
  const [rawHour, rawMinute] = value.split(":");
  const hour = Math.min(23, Math.max(0, Number(rawHour)));
  const minute = Math.min(59, Math.max(0, Number(rawMinute)));
  return `${(Number.isFinite(hour) ? hour : 9).toString().padStart(2, "0")}:${(Number.isFinite(minute) ? minute : 0)
    .toString()
    .padStart(2, "0")}`;
}

function clampDay(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(28, Math.max(1, Math.round(value)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function derivePropertyName(address: string): string {
  const firstPart = address.trim().split(",")[0]?.trim();
  return firstPart || "New apartment";
}

function commandSummary(commands: RentCommand[]): string {
  const splitCommands = commands.filter((command) => command.type === "set_splits").length;
  const addCommands = commands.filter((command) => command.type === "add_roommate").length;
  const removeCommands = commands.filter((command) => command.type === "remove_roommate").length;
  const parts = [
    splitCommands ? `${splitCommands} split update` : "",
    addCommands ? `${addCommands} add` : "",
    removeCommands ? `${removeCommands} remove` : ""
  ].filter(Boolean);
  return parts.length > 0 ? `Pending: ${parts.join(", ")}` : "Pending update";
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function createMessageId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
