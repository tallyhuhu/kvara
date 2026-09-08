import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowDown,
  Check,
  Building2,
  CalendarClock,
  Copy,
  DoorOpen,
  House,
  KeyRound,
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
import { formatUnits, isAddress } from "viem";
import { getAgentState, refreshStatuses, runAgentNow } from "../lib/api";
import { sendVeniceMessage } from "../lib/veniceClient";
import { useKvaraProfile } from "../hooks/useKvaraProfile";
import { useMetaMaskPermissions } from "../hooks/useMetaMaskPermissions";
import { profileRoleLabel, type KvaraProfileRole } from "../lib/profileRegistry";
import { nextRentSchedule, paymentErrorText, permissionCoversShare } from "../lib/workspaceModel";
import propertyHero from "../assets/property-hero.png";
import "./workspace.css";
import {
  BASE_CHAIN_HEX,
  BASE_EXPLORER_URL,
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
  onCreate: (input: CreateGroupInput) => Promise<RentGroup>;
  onPermissionGranted: (roommateId: string, permission: PermissionGrant) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<boolean>;
  onWalletConnected: (walletAddress: `0x${string}`) => Promise<RentGroup[]>;
  onWalletDisconnected: () => void;
  onPaymentsUpdated: (records: PaymentRecord[]) => void;
  onCommands: (commands: RentCommand[], serverGroup: RentGroup) => Promise<RentGroup | null>;
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
  onWalletDisconnected,
  onPaymentsUpdated,
  onCommands
}: Props) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [creating, setCreating] = useState(false);
  const [endingLease, setEndingLease] = useState(false);
  const [confirmEndLease, setConfirmEndLease] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "home">("chat");
  const walletAttempt = useRef(0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({
    propertyAddress: "",
    landlordAddress: "",
    totalRent: "",
    dueDay: "1",
    rentRunTime: "09:00",
    residents: []
  });
  const [setupError, setSetupError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const { loading: permissionLoading, error: permissionError, detail, requestRentPermission } = useMetaMaskPermissions();
  const {
    loading: profileLoading,
    submitting: profileSubmitting,
    role: profileRole,
    error: profileError,
    createProfile,
    checked: profileChecked,
    txHash: profileTxHash,
    retry: retryProfile
  } = useKvaraProfile(account);

  const connectedRoommate = useMemo(() => {
    if (!group || !account) return null;
    return group.roommates.find((roommate) => sameAddress(roommate.walletAddress, account)) ?? null;
  }, [account, group]);
  const greeting = connectedRoommate ? residentGreeting(connectedRoommate) : null;
  const profileReady = profileRole !== null;
  const visibleGroup = signedIn ? group : null;
  const canManageGroup = Boolean(
    signedIn && account && group && sameAddress(group.adminWalletAddress ?? "", account)
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
      const attempt = ++walletAttempt.current;
      onWalletDisconnected();
      setSignedIn(false);
      setConnecting(true);
      setMessages([]);
      setInput("");
      setAgentEvents([]);
      setAsking(false);
      setRunningNow(false);
      setCreating(false);
      setEndingLease(false);
      setSetupError(null);
      setConfirmEndLease(false);
      setSetupDraft({ propertyAddress: "", landlordAddress: "", totalRent: "", dueDay: "1", rentRunTime: "09:00", residents: [] });
      setConnectError(null);
      setAccount(nextAccount);
      try {
        const ethereum = window.ethereum as MetaMaskProvider | undefined;
        const chainId = await ethereum?.request({ method: "eth_chainId" });
        if (attempt !== walletAttempt.current) return;
        setWalletChainId(typeof chainId === "string" ? chainId.toLowerCase() : null);
        await onWalletConnected(nextAccount);
        if (attempt === walletAttempt.current) setSignedIn(true);
      } catch (cause) {
        if (attempt === walletAttempt.current) setConnectError(cause instanceof Error ? cause.message : "Could not sign in. Try connecting again.");
      } finally {
        if (attempt === walletAttempt.current) setConnecting(false);
      }
    },
    [onWalletConnected, onWalletDisconnected]
  );

  useEffect(() => {
    if (!account || !profileRole || !signedIn) return;
    setSetupDraft((current) => {
      if (current.residents.length > 0) return current;
      if (profileRole === "landlord") return {
        ...current, landlordAddress: account,
        residents: [{ id: createMessageId("resident"), name: "", walletAddress: "", share: "" }]
      };
      return {
        ...current,
        residents: [
          {
            id: createMessageId("resident"),
            name: "",
            walletAddress: account,
            share: ""
          },
          ...current.residents
        ]
      };
    });
  }, [account, profileRole, signedIn]);

  useEffect(() => {
    const area = chatScroll.current;
    if (!area) return;
    if (area.scrollHeight - area.scrollTop - area.clientHeight < 220) {
      chatEnd.current?.scrollIntoView({ block: "end", behavior: "auto" });
      setNewMessages(false);
    } else if (messages.length) setNewMessages(true);
  }, [messages, asking, runningNow]);

  useEffect(() => {
    const ethereum = window.ethereum as MetaMaskProvider | undefined;
    if (!ethereum?.on) return;

    const handleAccountsChanged = (value: unknown) => {
      const accounts = Array.isArray(value) ? value : [];
      const nextAccount = typeof accounts[0] === "string" ? (accounts[0] as `0x${string}`) : null;
      if (!nextAccount) {
        walletAttempt.current++;
        onWalletDisconnected();
        setSignedIn(false);
        setConnecting(false);
        setMessages([]);
        setAgentEvents([]);
        setInput("");
        setSetupDraft({ propertyAddress: "", landlordAddress: "", totalRent: "", dueDay: "1", rentRunTime: "09:00", residents: [] });
        setAccount(null);
        setConnectError(null);
        return;
      }
      handleWalletAccount(nextAccount).catch((cause) => {
        setConnectError(cause instanceof Error ? cause.message : "Could not load this wallet.");
      });
    };

    const handleChainChanged = (value: unknown) => {
      setConnectError(null);
      setWalletChainId(typeof value === "string" ? value.toLowerCase() : null);
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
      ethereum.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [handleWalletAccount, onWalletDisconnected]);

  useEffect(() => {
    if (!group || !signedIn) return;
    const groupId = group.id;
    let cancelled = false;

    async function loadAgentState() {
      const response = await getAgentState(groupId);
      if (cancelled) return;
      setAgentEvents(response.events);
      setAgentRunning(false);
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
  }, [group, signedIn, onPaymentsUpdated]);

  useEffect(() => {
    if (pendingTaskIds.length === 0) return;
    const interval = window.setInterval(async () => {
      try {
        if (!group) return;
        const response = await refreshStatuses(group.id, pendingTaskIds);
        onPaymentsUpdated(response.payments);
      } catch {
        window.clearInterval(interval);
      }
    }, 3000);
    return () => window.clearInterval(interval);
  }, [group, onPaymentsUpdated, pendingTaskIds]);

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
    walletAttempt.current++;
    onWalletDisconnected();
    setSignedIn(false);
    setConnecting(false);
    setMessages([]);
    setAgentEvents([]);
    setInput("");
    setSetupDraft({ propertyAddress: "", landlordAddress: "", totalRent: "", dueDay: "1", rentRunTime: "09:00", residents: [] });
    setAccount(null);
    setWalletChainId(null);
    setConnectError(null);
    const ethereum = window.ethereum as MetaMaskProvider | undefined;
    try {
      await ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Some wallets do not expose revocation; local session reset is still useful.
    }
  }

  async function switchToBase() {
    const ethereum = window.ethereum as MetaMaskProvider | undefined;
    if (!ethereum) return;
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] });
      setWalletChainId(BASE_CHAIN_HEX);
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : "Could not switch to Base Mainnet.");
    }
  }

  async function handleCreateProfile(role: KvaraProfileRole) {
    const attempt = walletAttempt.current;
    try {
      const profile = await createProfile(role);
      if (attempt !== walletAttempt.current) return;
      pushAssistant(
        `${profileRoleLabel(profile.role)} profile is active on Base.\n${profile.basescanUrl}`
      );
    } catch {
      // The profile bubble owns the actionable error state.
    }
  }

  async function handleCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const attempt = walletAttempt.current;
    setCreating(true);
    setSetupError(null);

    try {
      if (!account) throw new Error("Connect MetaMask first.");
      const roommates = parseResidentRows(setupDraft.residents, account);
      if (roommates.length === 0) throw new Error("Add at least one resident wallet.");
      const propertyAddress = setupDraft.propertyAddress.trim();
      if (!propertyAddress) throw new Error("Add the apartment address.");
      const totalRent = setupDraft.totalRent.trim();
      if (!Number(totalRent) || Number(totalRent) <= 0) throw new Error("Add the monthly rent.");
      const schedule = buildRentSchedule(setupDraft.dueDay, setupDraft.rentRunTime);

      const created = await onCreate({
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

      if (attempt !== walletAttempt.current) return;
      setMessages([
        {
          id: createMessageId("assistant"),
          role: "assistant",
          text: `${created.propertyName} is ready. I prepared invite links and will ask each resident for a bounded permission.`
        }
      ]);
    } catch (cause) {
      if (attempt === walletAttempt.current) setSetupError(cause instanceof Error ? cause.message : "Could not create apartment.");
    } finally {
      if (attempt === walletAttempt.current) setCreating(false);
    }
  }

  async function grantPermission(roommate: Roommate) {
    if (!group) return;
    const attempt = walletAttempt.current;
    try {
      const permission = await requestRentPermission(group, roommate);
      if (attempt !== walletAttempt.current) return;
      await onPermissionGranted(roommate.id, permission);
      pushAssistant("Permission is active. Your share will be paid on rent day.");
    } catch (cause) {
      if (attempt === walletAttempt.current) pushAssistant(cause instanceof Error ? cause.message : "Could not save your permission. Please try again.");
    }
  }

  async function runAgentDemo() {
    if (!group) return;
    const attempt = walletAttempt.current;
    setRunningNow(true);
    const startedAt = Date.now();
    const existingPaymentIds = new Set(history.map((record) => record.id));
    try {
      const response = await runAgentNow(group.id);
      if (attempt !== walletAttempt.current) return;
      onPaymentsUpdated(response.payments);
      setAgentEvents(response.events);
      setAgentRunning(false);
      pushAssistant(summarizeAgentRun(group, response.payments, response.events, existingPaymentIds, startedAt));
      const taskIds = response.payments
        .filter((payment) => payment.status === "pending" || payment.status === "submitted" || payment.status === "submission_unknown")
        .map((payment) => payment.taskId)
        .filter((taskId): taskId is string => Boolean(taskId));
      if (taskIds.length > 0) {
        try {
          const payments = await pollPaymentStatuses(group.id, taskIds, onPaymentsUpdated);
          if (attempt !== walletAttempt.current) return;
          if (payments.length > 0) {
            pushAssistant(summarizePaymentStatus(payments));
          }
        } catch {
          if (attempt === walletAttempt.current) pushAssistant("Confirmation is still pending. Check the payment history for updates.");
        }
      }
    } catch (cause) {
      if (attempt === walletAttempt.current) pushAssistant(cause instanceof Error ? cause.message : "Agent run failed.");
    } finally {
      if (attempt === walletAttempt.current) setRunningNow(false);
    }
  }

  async function endLease() {
    if (!group || !canManageGroup || endingLease) return;
    const attempt = walletAttempt.current;
    setEndingLease(true);
    try {
    const name = group.propertyName;
    const deleted = await onDeleteGroup(group.id);
    if (!deleted || attempt !== walletAttempt.current) return;
    setMessages([
      {
        id: createMessageId("assistant"),
        role: "assistant",
        text: `${name} is closed and Kvara autopay is stopped. Your wallet permission was not revoked onchain; remove it in MetaMask if you no longer want it active.`
      }
    ]);
    setConfirmEndLease(false);
    } catch (cause) {
      if (attempt === walletAttempt.current) pushAssistant(cause instanceof Error ? cause.message : "Could not close this lease. Try again.");
    } finally {
      if (attempt === walletAttempt.current) setEndingLease(false);
    }
  }

  async function askKvara(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || asking || !canManageGroup) return;
    setInput("");
    pushUser(message);

    if (!group) {
      pushAssistant("Create an apartment first, then I can recalculate splits and answer rent history questions.");
      return;
    }

    setAsking(true);
    const attempt = walletAttempt.current;
    try {
      const response = await sendVeniceMessage({ message, groupId: group.id, conversation: messages.slice(-12).map(({ role, text }) => ({ role, content: text.slice(0, 2000) })) });
      if (attempt !== walletAttempt.current) return;
      const commandSummary = response.commands.length > 0 ? summarizeRentCommands(group, response.commands) : "";
      if (response.commands.length > 0) {
        await onCommands(response.commands, response.group);
      }
      pushAssistant(joinChatSections(response.message, commandSummary));
    } catch (cause) {
      if (attempt === walletAttempt.current) pushAssistant(cause instanceof Error ? cause.message : "Kvara agent request failed.");
    } finally {
      if (attempt === walletAttempt.current) setAsking(false);
    }
  }

  async function copyInvite(roommate: Roommate) {
    if (!group) return;
    try {
    await navigator.clipboard.writeText(createInviteUrl(group, roommate.id));
    setCopiedInviteId(roommate.id);
    window.setTimeout(() => setCopiedInviteId(null), 1400);
    } catch {
      pushAssistant(`Copy this invitation link:\n${createInviteUrl(group, roommate.id)}`);
    }
  }

  function pushUser(text: string) {
    setMessages((current) => [...current, { id: createMessageId("user"), role: "user", text }]);
  }

  function pushAssistant(text: string) {
    setMessages((current) => [...current, { id: createMessageId("assistant"), role: "assistant", text }]);
  }

  return (
    <main className="workspace">
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="flex items-center gap-3">
            <div>
              <a href={window.location.pathname} className="workspace-wordmark" aria-label="Kvara home">Kvara<span>.</span></a>
              <p className="workspace-caption">A little less to think about.</p>
            </div>
          </div>
          {account ? (
            <div className="workspace-wallet flex flex-wrap items-center justify-end gap-2">
              <span title={account} className="workspace-wallet-address border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-600">
                {shortAddress(account)}
              </span>
              {profileRole ? (
                <span className="workspace-wallet-role border border-stone-300 bg-[#efe7d8] px-3 py-2 text-xs font-semibold text-stone-700">
                  {profileRoleLabel(profileRole)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={switchWallet}
                className="workspace-icon-button"
                aria-label="Switch wallet" title="Switch wallet"
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                onClick={disconnectWallet}
                className="workspace-icon-button"
                aria-label="Disconnect wallet" title="Disconnect wallet"
              >
                <X size={14} />
              </button>
            </div>
          ) : <span className="workspace-network"><span /> Base Mainnet</span>}
        </header>

        <nav className="workspace-mobile-nav" aria-label="Workspace views">
          <button aria-current={mobileView === "chat" ? "page" : undefined} onClick={() => setMobileView("chat")}>Conversation</button>
          <button aria-current={mobileView === "home" ? "page" : undefined} onClick={() => setMobileView("home")}><House size={15} /> Your home</button>
        </nav>
        <section className="workspace-layout" data-mobile-view={mobileView}>
          <div className="workspace-conversation">
            <div className="workspace-conversation-heading">
              <div><p className="workspace-overline">Your rent desk</p><h1>{visibleGroup ? visibleGroup.propertyName : "Make yourself at home."}</h1></div>
              <span className="workspace-network"><span /> Base</span>
            </div>
            {!visibleGroup ? <ol className="workspace-progress" aria-label="Setup progress">
              {[["Connect", signedIn], ["Profile", profileReady && signedIn], ["Home", false]].map(([label, done], index) => (
                <li key={String(label)} data-complete={done ? "true" : "false"}><span>{done ? <Check size={12} /> : index + 1}</span>{label}</li>
              ))}
            </ol> : null}
            <div ref={chatScroll} className="workspace-messages" aria-label="Conversation" onScroll={() => {
              const area = chatScroll.current;
              if (area && area.scrollHeight - area.scrollTop - area.clientHeight < 100) setNewMessages(false);
            }}>
              <AssistantBubble>
                {!account
                  ? "Welcome to Kvara. Connect your wallet to find your home or start a new lease."
                  : connecting ? "Confirm the sign-in message in MetaMask."
                  : !signedIn ? "Sign in to open your rent desk."
                  : profileLoading
                    ? "Checking your Kvara profile on Base."
                    : !profileReady
                      ? "First, a place for you. Are you renting, a landlord, or both?"
                  : isInvite
                    ? group && inviteRoommate ? `Welcome to ${group.propertyName}. Approve your rent limit to get settled in.` : "This invitation is unavailable for this wallet. Switch to the invited wallet or ask the host for a new link."
                    : group
                      ? canManageGroup
                        ? `${greeting ? `${greeting}. ` : "Welcome back. "}Your home is here. Tell me what's changed, and I will work out the rent.`
                        : connectedRoommate
                          ? `${greeting ? `${greeting}. ` : ""}Your share and payment history are here. ${permissionStatus(connectedRoommate) === "granted" ? "Your rent permission is active." : "Approve your rent limit to join autopay."}`
                          : `I found ${group.propertyName}. You can ask me rent questions from this wallet.`
                      : "This wallet has no Kvara apartment yet. Tell me the basics and I will prepare the rent room."}
              </AssistantBubble>

              {!signedIn ? (
                <ActionBubble>
                  <button
                    type="button"
                    onClick={connectWallet}
                    disabled={connecting}
                    className="inline-flex h-11 items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 active:translate-y-[1px]"
                  >
                    {connecting ? <Loader2 size={17} className="animate-spin" /> : <Wallet size={17} />}
                    {connecting ? "Signing in" : "Connect MetaMask"}
                  </button>
                  {connectError ? <p className="mt-3 text-sm text-rose-700">{connectError}</p> : null}
                </ActionBubble>
              ) : null}

              {signedIn && connectError ? (
                <ActionBubble>
                  <p className="text-sm text-rose-700">{connectError}</p>
                </ActionBubble>
              ) : null}

              {account && walletChainId && walletChainId !== BASE_CHAIN_HEX ? (
                <ActionBubble>
                  <p className="text-sm text-stone-700">Kvara settles rent in USDC on Base Mainnet.</p>
                  <button
                    type="button"
                    onClick={switchToBase}
                    className="mt-3 inline-flex h-10 items-center gap-2 bg-emerald-950 px-3 text-sm font-semibold text-white transition hover:bg-emerald-900"
                  >
                    <RefreshCw size={15} />
                    Switch to Base
                  </button>
                </ActionBubble>
              ) : null}

              {signedIn && account && !profileLoading && !profileChecked ? <ActionBubble>
                <p className="text-sm text-rose-700" role="alert">{profileError}</p>
                <button className="workspace-text-button mt-3" onClick={retryProfile}><RefreshCw size={14} className="mr-2 inline" /> Check again</button>
              </ActionBubble> : null}
              {signedIn && account && walletChainId === BASE_CHAIN_HEX && profileChecked && !profileLoading && !profileReady ? (
                <ProfileSetupBubble
                  loading={profileSubmitting}
                  error={profileError}
                  onSelect={handleCreateProfile}
                  txHash={profileTxHash}
                />
              ) : null}

              {signedIn && account && profileReady && isInvite && group && inviteRoommate ? (
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

              {signedIn && account && profileReady && !isInvite && !group ? (
                <SetupBubble
                  draft={setupDraft}
                  error={setupError}
                  loading={creating}
                  onChange={setSetupDraft}
                  onSubmit={handleCreateGroup}
                />
              ) : null}

              {signedIn && account && profileReady && group && (!isInvite || canManageGroup) ? (
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
              {asking || runningNow ? <p className="workspace-thinking" role="status"><Loader2 size={14} className="animate-spin" />{runningNow ? "Checking this month's payments..." : "Working out the rent..."}</p> : null}
              <div ref={chatEnd} />
            </div>

            {newMessages ? <button className="workspace-new-messages" onClick={() => { chatEnd.current?.scrollIntoView({ block: "end" }); setNewMessages(false); }}><ArrowDown size={14} /> Latest message</button> : null}
            <form onSubmit={askKvara} className="workspace-composer">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                aria-label="Message Kvara"
                maxLength={2000}
                placeholder={!signedIn ? "Connect your wallet to begin" : !profileReady ? "Create your profile to continue" : !group ? "Set up your home first" : !canManageGroup ? "Your host manages rent changes" : "Tell Kvara what's changed..."}
                disabled={!signedIn || !profileReady || !canManageGroup}
                className="min-w-0 flex-1 border border-stone-300 bg-white px-3 py-3 text-sm outline-none transition focus:border-emerald-800 disabled:bg-stone-100"
              />
              <button
                type="submit"
                disabled={!signedIn || !profileReady || !canManageGroup || asking || !input.trim()}
                className="grid h-12 w-12 place-items-center bg-emerald-950 text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
                aria-label="Send"
                title="Send"
              >
                {asking ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </form>
            <p className="workspace-composer-note">{canManageGroup ? "Rent changes stay within each resident's approved limit." : "Your wallet. Your rent. Your say."}</p>
          </div>

          <ApartmentSnapshot
            group={visibleGroup}
            inviteRoommate={signedIn ? inviteRoommate : null}
            connectedRoommate={signedIn ? connectedRoommate : null}
            setupDraft={setupDraft}
            stats={stats}
            history={signedIn ? history : []}
            events={signedIn ? agentEvents : []}
            canManageGroup={canManageGroup}
            onEndLease={endLease}
            confirming={confirmEndLease}
            ending={endingLease}
            onConfirmEndLease={setConfirmEndLease}
          />
        </section>
      </div>
    </main>
  );
}

function AssistantBubble({ children }: { children: string }) {
  return (
    <div className="workspace-assistant">
      <span className="workspace-speaker">Kvara</span>
      <div className="workspace-assistant-text">
        <LinkifiedText text={children} />
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: string }) {
  return (
    <div className="workspace-user">
      <div>
        {children}
      </div>
    </div>
  );
}

function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("http") ? (
          <a
            key={`${part}-${index}`}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="workspace-message-link"
          >
            {/^https:\/\/basescan.org\/tx\/0x[\da-f]{64}$/i.test(part) ? <>View transaction <ArrowUpRight size={14} /></> : part}
          </a>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        )
      )}
    </>
  );
}

function ActionBubble({ children }: { children: ReactNode }) {
  return <div className="workspace-action">{children}</div>;
}

function ProfileSetupBubble({
  loading,
  error,
  onSelect,
  txHash
}: {
  loading: boolean;
  error?: string;
  onSelect: (role: KvaraProfileRole) => void;
  txHash?: `0x${string}`;
}) {
  const options: Array<{ role: KvaraProfileRole; label: string; icon: typeof House }> = [
    { role: "resident", label: "Resident", icon: House },
    { role: "landlord", label: "Landlord", icon: KeyRound },
    { role: "both", label: "Both", icon: Building2 }
  ];

  return (
    <ActionBubble>
      <p className="mb-3 text-sm font-semibold">Your role</p>
      {txHash ? <div className="flex flex-wrap items-center gap-3">
        <a className="workspace-message-link" href={`${BASE_EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer">View profile transaction <ArrowUpRight size={14} /></a>
        <button className="workspace-text-button" disabled={loading} onClick={() => onSelect("resident")}>Check confirmation</button>
      </div> : <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.role}
              type="button"
              onClick={() => onSelect(option.role)}
              disabled={loading}
              className="flex h-12 items-center justify-center gap-2 border border-stone-400 bg-white px-3 text-sm font-semibold text-stone-900 transition hover:border-emerald-900 hover:bg-stone-50 disabled:text-stone-400"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
              {option.label}
            </button>
          );
        })}
      </div>}
      <p className="mt-3 text-xs leading-relaxed text-stone-600">A public profile, created once on Base. A small network fee in ETH applies.</p>
      {loading ? <p className="mt-3 text-sm text-stone-600" role="status">Confirm in MetaMask, then wait for Base.</p> : null}
      {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
    </ActionBubble>
  );
}

function SetupBubble({
  draft,
  error,
  loading,
  onChange,
  onSubmit
}: {
  draft: SetupDraft;
  error: string | null;
  loading: boolean;
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
      <form onSubmit={onSubmit} className="grid gap-4">
        <h2 className="text-lg font-semibold">The place you call home</h2>
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
          <Field label="Payment time (UTC)">
            <input
              value={draft.rentRunTime}
              onChange={(event) => onChange({ ...draft, rentRunTime: event.target.value })}
              type="time"
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-800"
            />
          </Field>
        </div>
        <div role="group" aria-label="Residents">
          <p className="mb-2 text-sm font-semibold">Who lives here?</p>
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
        </div>
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-11 w-fit items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 active:translate-y-[1px]"
        >
          {loading ? "Preparing your home" : "Prepare apartment"}
          {loading ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpRight size={16} />}
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
        disabled={!walletMatches || loading || (status === "granted" && permissionCoversShare(roommate))}
        className="mt-4 inline-flex h-11 items-center gap-2 bg-emerald-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:bg-stone-300"
      >
        <ShieldCheck size={17} />
        {loading ? detail ?? "Opening MetaMask" : status === "granted" ? permissionCoversShare(roommate) ? "Permission active" : "Update permission" : "Grant permission"}
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
  const needsPermission = connectedRoommate && (permissionStatus(connectedRoommate) !== "granted" || !permissionCoversShare(connectedRoommate));
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
            {permissionLoading ? permissionDetail ?? "Opening MetaMask" : connectedRoommate.permission ? "Update my permission" : "Grant my permission"}
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
  connectedRoommate,
  setupDraft,
  stats,
  history,
  events,
  canManageGroup,
  onEndLease,
  confirming,
  ending,
  onConfirmEndLease
}: {
  group: RentGroup | null;
  inviteRoommate: Roommate | null;
  connectedRoommate: Roommate | null;
  setupDraft: SetupDraft;
  stats: { granted: number; total: number; monthlyTotal: number };
  history: PaymentRecord[];
  events: AgentEvent[];
  canManageGroup: boolean;
  onEndLease: () => void;
  confirming: boolean;
  ending: boolean;
  onConfirmEndLease: (value: boolean) => void;
}) {
  const currentRoommate = connectedRoommate ?? inviteRoommate;
  const hasDraft = Boolean(
    setupDraft.propertyAddress.trim() ||
      setupDraft.landlordAddress.trim() ||
      setupDraft.residents.some((resident) => resident.name.trim() || resident.walletAddress.trim())
  );

  if (!group) return <aside className="workspace-home workspace-empty-home">
    <img src={propertyHero} alt="Sunlit apartment buildings surrounded by trees" />
    <div className="workspace-empty-copy"><p className="workspace-overline">Room for living</p>
      <h2>{setupDraft.propertyAddress || "Home, without the rent reminders."}</h2>
      <p>{hasDraft ? "Your home details will appear here once the lease is ready." : "One home. Every share accounted for."}</p>
      <div className="workspace-empty-rule"><House size={18} /><span>Monthly rent, paid together.</span></div>
    </div>
  </aside>;

  return (
    <aside className="workspace-home">
      <div className="workspace-home-heading">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="workspace-overline"><House size={14} /> Your home</p>
            <h2 className="mt-3 text-2xl font-semibold leading-tight text-stone-950">
              {group?.propertyName ??
                (setupDraft.propertyAddress ? derivePropertyName(setupDraft.propertyAddress) : "Not connected")}
            </h2>
          </div>
        </div>
        <p className="workspace-home-status"><span data-ready={stats.granted === stats.total && stats.total > 0} />{!group.autopayEnabled ? "Autopay paused" : stats.granted === stats.total ? "Permissions ready" : "Waiting for permissions"}</p>
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
        {group ? <SnapshotRow label="Landlord" value={shortAddress(group.landlordAddress)} /> : null}
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
        {currentRoommate ? <SnapshotRow label="Your part" value={`${formatUsd(currentRoommate.share)} USDC`} /> : null}
        {group ? <SnapshotRow label="Autopay" value={group.autopayEnabled ? "Enabled for this lease" : "Paused"} /> : null}
        {group ? <SnapshotRow label="Collected this month" value={`${formatUsd(stats.monthlyTotal)} USDC`} /> : null}
      </div>

      {currentRoommate ? <PermissionSnapshot roommate={currentRoommate} /> : null}

      {group ? (
        <ResidentsSnapshot roommates={group.roommates} />
      ) : hasDraft ? (
        <DraftResidentsSnapshot residents={parseResidentRowsSafe(setupDraft.residents)} />
      ) : null}

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

      {history.length > 0 ? <PaymentProofSnapshot history={history} /> : null}

      {group && canManageGroup ? (
        <div className="border-t border-stone-300 p-4">
          <button
            type="button"
            onClick={() => onConfirmEndLease(true)}
            className="inline-flex h-10 w-full items-center justify-center gap-2 border border-stone-400 bg-white px-3 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 active:translate-y-[1px]"
          >
            <DoorOpen size={16} />
            End lease
          </button>
          {confirming ? <div className="mt-3 text-sm" role="alert">
            <p>Stop future rent payments for this home? Existing wallet permissions remain in MetaMask.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="workspace-danger-button" disabled={ending} onClick={onEndLease}>{ending ? "Closing..." : "Confirm end lease"}</button>
              <button className="workspace-text-button" disabled={ending} onClick={() => onConfirmEndLease(false)}>Keep lease</button>
            </div>
          </div> : null}
        </div>
      ) : null}
    </aside>
  );
}

function PermissionSnapshot({ roommate }: { roommate: Roommate }) {
  const permission = roommate.permission;
  const status = permissionStatus(roommate);
  const insufficient = Boolean(permission) && !permissionCoversShare(roommate);
  return (
    <div className="border-t border-stone-300 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase text-stone-500">Your permission</p>
        <span className={status === "granted" && !insufficient ? "text-xs font-semibold uppercase text-emerald-800" : "text-xs font-semibold uppercase text-rose-700"}>
          {insufficient ? "Needs update" : status === "granted" ? "Active" : status}
        </span>
      </div>
      {permission ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 border border-stone-300 bg-white p-3 text-sm">
          <div><dt className="text-xs text-stone-500">Asset</dt><dd className="mt-1 font-semibold">Base USDC</dd></div>
          <div><dt className="text-xs text-stone-500">30-day cap</dt><dd className="mt-1 font-semibold">{formatUnits(BigInt(permission.allowanceAtoms), permission.tokenDecimals)} USDC</dd></div>
          <div><dt className="text-xs text-stone-500">Purpose</dt><dd className="mt-1 font-semibold">Monthly rent</dd></div>
          <div><dt className="text-xs text-stone-500">Expires</dt><dd className="mt-1 font-semibold">{formatPermissionExpiry(permission.expiresAt)}</dd></div>
          <div><dt className="text-xs text-stone-500">Execution</dt><dd className="mt-1 font-semibold">{permission.executionMode === "aa" ? "Kvara smart account" : "1Shot relayer"}</dd></div>
          <div><dt className="text-xs text-stone-500">Settlement</dt><dd className="mt-1 font-semibold">Base Mainnet</dd></div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-stone-600">Grant a bounded Base USDC permission before rent day.</p>
      )}
      {insufficient ? <p className="mt-2 text-sm text-rose-700">Your current share is above this permission cap. Grant a new permission before rent day.</p> : null}
    </div>
  );
}

function PaymentProofSnapshot({ history }: { history: PaymentRecord[] }) {
  const payments = history.filter((payment) => payment.txHash || payment.basescanUrl).slice(0, 3);
  if (payments.length === 0) return null;
  return (
    <div className="border-t border-stone-300 p-4">
      <p className="text-xs font-semibold uppercase text-stone-500">Base proof</p>
      <div className="mt-3 divide-y divide-stone-300 border border-stone-300 bg-white">
        {payments.map((payment) => (
          <a
            key={payment.id}
            href={payment.basescanUrl ?? `${BASE_EXPLORER_URL}/tx/${payment.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-800"
          >
            <span className="min-w-0">
              <span className="block truncate font-semibold">{payment.roommateName}</span>
              <span className="text-xs text-stone-500">{formatUsd(payment.amount)} USDC - {humanPaymentStatus(payment.status)}</span>
            </span>
            <ArrowUpRight size={15} className="shrink-0 text-emerald-800" />
          </a>
        ))}
      </div>
    </div>
  );
}

function formatPermissionExpiry(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ResidentsSnapshot({ roommates }: { roommates: Roommate[] }) {
  return (
    <div className="border-t border-stone-300 p-4">
      <p className="text-xs font-semibold uppercase text-stone-500">Residents this month</p>
      <div className="mt-3 divide-y divide-stone-300 border border-stone-300 bg-white">
        {roommates.map((roommate) => (
          <div key={roommate.id} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-stone-950">{residentDisplayName(roommate)}</p>
              <p className="mt-1 truncate font-mono text-[11px] text-stone-500">{shortAddress(roommate.walletAddress)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-stone-950">{formatUsd(roommate.share)} USDC</p>
              <p className="mt-1 text-[11px] font-semibold uppercase text-stone-500">
                {residentPermissionLabel(roommate)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DraftResidentsSnapshot({
  residents
}: {
  residents: Array<{ name: string; walletAddress: `0x${string}`; share?: string }>;
}) {
  if (residents.length === 0) return null;
  return (
    <div className="border-t border-stone-300 p-4">
      <p className="text-xs font-semibold uppercase text-stone-500">Residents draft</p>
      <div className="mt-3 divide-y divide-stone-300 border border-stone-300 bg-white">
        {residents.map((resident) => (
          <div key={resident.walletAddress} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-stone-950">{resident.name}</p>
              <p className="mt-1 truncate font-mono text-[11px] text-stone-500">{shortAddress(resident.walletAddress)}</p>
            </div>
            <p className="text-sm font-semibold text-stone-950">
              {resident.share ? `${formatUsd(resident.share)} USDC` : "Auto"}
            </p>
          </div>
        ))}
      </div>
    </div>
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

function summarizeRentCommands(group: RentGroup, commands: RentCommand[]): string {
  const lines: string[] = [];

  commands.forEach((command) => {
    if (command.type === "set_splits") {
      const splitLines = command.splits
        .map((split) => {
          const roommate = group.roommates.find((item) => item.id === split.roommateId);
          if (!roommate) return "";
          if (Number(roommate.share).toFixed(2) === Number(split.share).toFixed(2)) return "";
          return `- ${residentDisplayName(roommate)}: ${formatUsd(roommate.share)} -> ${formatUsd(split.share)} USDC`;
        })
        .filter(Boolean);
      if (splitLines.length > 0) {
        lines.push("Updated this month's split:");
        lines.push(...splitLines);
        lines.push(`Total rent stays ${formatUsd(group.totalRent)} USDC.`);
      }
    }

    if (command.type === "add_roommate") {
      lines.push(`Added ${command.name} at ${formatUsd(command.share)} USDC.`);
    }

    if (command.type === "remove_roommate") {
      const roommate = group.roommates.find((item) => item.id === command.roommateId);
      lines.push(`Removed ${roommate ? residentDisplayName(roommate) : "a resident"} from this month's split.`);
    }
  });

  return lines.join("\n");
}

function summarizeAgentRun(
  group: RentGroup,
  payments: PaymentRecord[],
  events: AgentEvent[],
  existingPaymentIds: Set<string>,
  startedAt: number
): string {
  const runPayments = payments
    .filter((payment) => payment.groupId === group.id)
    .filter((payment) => !existingPaymentIds.has(payment.id) || Date.parse(payment.updatedAt) >= startedAt)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  if (runPayments.length === 0) {
    const recentEvent = events.find((event) => Date.parse(event.createdAt) >= startedAt - 2000);
    return recentEvent
      ? `I checked rent day. ${recentEvent.message}.`
      : "I checked rent day, but no new payment records were created.";
  }

  const submitted = runPayments.filter((payment) => payment.status === "submitted").length;
  const pending = runPayments.filter((payment) => payment.status === "pending").length;
  const confirmed = runPayments.filter((payment) => payment.status === "confirmed").length;
  const uncertain = runPayments.filter((payment) => payment.status === "submission_unknown");
  const blocked = runPayments.filter((payment) => payment.status === "failed" || payment.status === "rejected" || payment.status === "submission_unknown");
  const live = submitted + pending + confirmed;

  if (live > 0) {
    const parts = [
      submitted ? `${submitted} submitted on Base` : "",
      pending ? `${pending} pending` : "",
      confirmed ? `${confirmed} confirmed` : ""
    ].filter(Boolean);
    const blockedText = blocked.length > 0 ? ` ${formatBlockedPayments(blocked)}` : "";
    return joinChatSections(`Rent day started: ${parts.join(", ")}.${blockedText}`, formatPaymentAttempts(runPayments));
  }

  if (uncertain.length > 0) {
    return joinChatSections(
      "Payment submission needs review. Kvara will not retry automatically until the outcome is known.",
      formatPaymentAttempts(runPayments)
    );
  }

  return joinChatSections(
    `I checked rent day, but no payment was submitted. ${formatBlockedPayments(blocked)}`,
    formatPaymentAttempts(runPayments)
  );
}

function formatBlockedPayments(payments: PaymentRecord[]): string {
  if (payments.length === 0) return "No roommate payment was ready.";
  const visible = payments.slice(0, 3).map((payment) => {
    const name = payment.roommateName || shortAddress(payment.walletAddress);
    return `${name}: ${humanPaymentError(payment.error)}`;
  });
  const rest = payments.length > visible.length ? `; ${payments.length - visible.length} more blocked` : "";
  return `Blocked: ${visible.join("; ")}${rest}.`;
}

function formatPaymentAttempts(payments: PaymentRecord[]): string {
  if (payments.length === 0) return "";
  return ["Payment attempts:", ...payments.map((payment) => `- ${formatPaymentLine(payment)}`)].join("\n");
}

function summarizePaymentStatus(payments: PaymentRecord[]): string {
  return ["Base payment status:", ...payments.map((payment) => `- ${formatPaymentLine(payment)}`)].join("\n");
}

function formatPaymentLine(payment: PaymentRecord): string {
  const name = payment.roommateName || shortAddress(payment.walletAddress);
  const amount = `${formatUsd(payment.amount)} USDC`;
  const explorerUrl = payment.basescanUrl ?? (payment.txHash ? `https://basescan.org/tx/${payment.txHash}` : "");

  if (payment.status === "confirmed") {
    return `${name}: confirmed ${amount}${explorerUrl ? ` - ${explorerUrl}` : ""}`;
  }
  if (payment.status === "submitted") {
    return `${name}: submitted ${amount}${explorerUrl ? ` - ${explorerUrl}` : ` - operation ${shortOperationId(payment.taskId)}`}`;
  }
  if (payment.status === "pending") {
    return `${name}: pending ${amount}${payment.taskId ? ` - operation ${shortOperationId(payment.taskId)}` : ""}`;
  }
  if (payment.status === "submission_unknown") {
    return `${name}: needs review ${amount} - ${humanPaymentError(payment.error)}`;
  }
  if (payment.status === "rejected") {
    return `${name}: rejected ${amount} - ${humanPaymentError(payment.error)}`;
  }
  return `${name}: blocked ${amount} - ${humanPaymentError(payment.error)}`;
}

function humanPaymentError(error: string | undefined): string {
  return paymentErrorText(error);
}

function joinChatSections(...sections: string[]): string {
  return sections.map((section) => section.trim()).filter(Boolean).join("\n\n");
}

async function pollPaymentStatuses(
  groupId: string,
  taskIds: string[],
  onPaymentsUpdated: (records: PaymentRecord[]) => void
): Promise<PaymentRecord[]> {
  let latest: PaymentRecord[] = [];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(attempt === 0 ? 1500 : 3000);
    const response = await refreshStatuses(groupId, taskIds);
    if (response.payments.length > 0) {
      latest = response.payments;
      onPaymentsUpdated(response.payments);
    }

    if (latest.length > 0 && latest.every((payment) => paymentHasExplorerLink(payment) || paymentIsTerminal(payment))) {
      break;
    }
  }

  return latest;
}

function shortOperationId(value: string | undefined): string {
  if (!value) return "pending";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function paymentHasExplorerLink(payment: PaymentRecord): boolean {
  return Boolean(payment.basescanUrl || payment.txHash);
}

function paymentIsTerminal(payment: PaymentRecord): boolean {
  return payment.status === "confirmed" || payment.status === "failed" || payment.status === "rejected";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
    if (share && (!Number.isFinite(Number(share)) || Number(share) < 0)) {
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

function buildRentSchedule(dueDayValue: string, rentRunTimeValue: string): {
  dueDay: number;
  rentRunTime: string;
  nextRunAt: string;
} {
  return nextRentSchedule(Number(dueDayValue), rentRunTimeValue);
}

function formatDraftRentRun(dueDay: string, rentRunTime: string): string {
  return `Day ${dueDay || "1"} at ${rentRunTime || "09:00"} UTC`;
}

function formatRentRun(nextRunAt: string | undefined, dueDay: number, rentRunTime: string): string {
  if (!nextRunAt) return `Day ${dueDay} at ${rentRunTime} UTC`;
  return `Next ${new Date(nextRunAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
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
  if (status === "granted") return permissionCoversShare(roommate) ? "ready" : "needs update";
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  return "pending";
}

function derivePropertyName(address: string): string {
  const firstPart = address.trim().split(",")[0]?.trim();
  return firstPart || "New apartment";
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
