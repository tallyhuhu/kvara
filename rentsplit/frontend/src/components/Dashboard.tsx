import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  ExternalLink,
  Home,
  RefreshCw,
  ShieldCheck,
  Wallet,
  Zap
} from "lucide-react";
import { getAgentState, refreshStatuses, runAgentNow } from "../lib/api";
import {
  BASE_EXPLORER_URL,
  formatUsd,
  permissionStatus,
  type AgentEvent,
  type PaymentRecord,
  type RentCommand,
  type RentGroup
} from "../lib/groupStorage";
import propertyHero from "../assets/property-hero.png";
import { PaymentHistory } from "./PaymentHistory";
import { VeniceChat } from "./VeniceChat";

type Props = {
  group: RentGroup;
  history: PaymentRecord[];
  stats: { granted: number; total: number; monthlyTotal: number };
  onPaymentsUpdated: (records: PaymentRecord[]) => void;
  onCommands: (commands: RentCommand[]) => void;
};

export function Dashboard({
  group,
  history,
  stats,
  onPaymentsUpdated,
  onCommands
}: Props) {
  const [running, setRunning] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentNextRunAt, setAgentNextRunAt] = useState<string | undefined>(group.nextRunAt);
  const [error, setError] = useState<string | null>(null);

  const pendingTaskIds = useMemo(
    () =>
      history
        .filter((record) => record.taskId && (record.status === "pending" || record.status === "submitted"))
        .map((record) => record.taskId as string),
    [history]
  );
  const nextRunAt = agentNextRunAt ?? group.nextRunAt;
  const readyPercent = stats.total > 0 ? Math.round((stats.granted / stats.total) * 100) : 0;
  const confirmedCount = history.filter((record) => record.status === "confirmed").length;
  const isBusy = running || agentRunning;

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

  useEffect(() => {
    let cancelled = false;

    async function loadAgentState() {
      const response = await getAgentState(group.id);
      if (cancelled) return;
      setAgentEvents(response.events);
      setAgentNextRunAt(response.nextRunAt);
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
  }, [group.id, onPaymentsUpdated]);

  async function handleRunAgent() {
    setRunning(true);
    setAgentRunning(true);
    setError(null);
    try {
      const response = await runAgentNow(group);
      onPaymentsUpdated(response.payments);
      setAgentEvents(response.events);
      setAgentNextRunAt(response.nextRunAt);
      setAgentRunning(response.running);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent run failed");
      setAgentRunning(false);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#e9e3d7] text-stone-950">
      <div className="mx-auto max-w-[1540px] px-3 py-3 lg:px-4 lg:py-4">
        <section className="relative min-h-[560px] overflow-hidden bg-emerald-950 text-white">
          <img
            src={propertyHero}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#061a13]/95 via-[#061a13]/55 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-[#061a13]/90 to-transparent" />

          <div className="relative z-10 flex min-h-[560px] flex-col justify-between p-4 sm:p-6 lg:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 bg-[#061a13]/80 px-3 py-2 text-sm font-semibold">
                <Home size={17} />
                Kvara
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`${BASE_EXPLORER_URL}/address/${group.landlordAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 items-center gap-2 border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20"
                >
                  Landlord
                  <ExternalLink size={15} />
                </a>
                <button
                  type="button"
                  onClick={handleRunAgent}
                  disabled={isBusy || stats.granted === 0}
                  className="inline-flex h-10 items-center gap-2 bg-[#d8c7a3] px-4 text-sm font-semibold text-emerald-950 transition hover:bg-[#ead8ae] disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-white/70"
                >
                  {isBusy ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
                  Run agent now
                </button>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-end">
              <div className="max-w-4xl">
                <p className="max-w-xl text-sm font-medium text-stone-200">
                  {group.propertyAddress || "Base mainnet household desk"}
                </p>
                <h1 className="mt-4 text-5xl font-semibold leading-[0.95] tracking-[0] sm:text-7xl lg:text-8xl">
                  {group.propertyName}
                </h1>
                <div className="mt-6 grid max-w-3xl gap-2 sm:grid-cols-3">
                  <HeroFact label="Monthly rent" value={`${formatUsd(group.totalRent)} USDC`} />
                  <HeroFact label="Ready wallets" value={`${stats.granted}/${stats.total}`} />
                  <HeroFact label="Next run" value={formatDateTime(nextRunAt)} />
                </div>
              </div>

              <div className="border border-white/15 bg-[#071d15]/90 p-4 backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase text-stone-300">Autonomous rent agent</p>
                    <p className="mt-1 text-2xl font-semibold">{group.autopayEnabled ? "Armed" : "Paused"}</p>
                  </div>
                  <ShieldCheck size={32} className="text-[#d8c7a3]" />
                </div>
                <div className="mt-5 h-2 bg-white/15">
                  <div className="h-full bg-[#d8c7a3]" style={{ width: `${readyPercent}%` }} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <PanelFact label="Buffer" value={`+${group.permissionBufferPercent}%`} />
                  <PanelFact label="Confirmed" value={String(confirmedCount)} />
                  <PanelFact label="This month" value={`${formatUsd(stats.monthlyTotal)} USDC`} />
                  <PanelFact label="Due day" value={String(group.dueDay)} />
                </div>
              </div>
            </div>
          </div>
        </section>

        {error ? (
          <div className="mt-3 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
        ) : null}

        <section className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_420px]">
          <div className="border border-stone-300 bg-[#f7f2e8]">
            <div className="flex items-center justify-between border-b border-stone-300 px-4 py-3">
              <h2 className="text-sm font-semibold uppercase text-stone-900">Residents</h2>
              <span className="text-sm font-medium text-stone-500">{stats.granted} granted</span>
            </div>
            <div className="divide-y divide-stone-200">
              {group.roommates.map((roommate) => {
                const status = permissionStatus(roommate);
                return (
                  <div
                    key={roommate.id}
                    className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1.3fr)_140px_150px] md:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusIcon status={status} />
                        <p className="truncate font-semibold text-stone-950">{roommate.name}</p>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-stone-500">
                        {shortAddress(roommate.walletAddress)}
                      </p>
                    </div>
                    <div className="text-sm font-semibold text-stone-950">{formatUsd(roommate.share)} USDC</div>
                    <span className={`w-fit px-2 py-1 text-xs font-semibold uppercase ${statusClass(status)}`}>
                      {statusLabel(status)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <AgentTimeline events={agentEvents} nextRunAt={nextRunAt} running={isBusy} />
        </section>

        <section className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          <PaymentHistory records={history} />
          <VeniceChat group={group} history={history} onCommands={onCommands} />
        </section>
      </div>
    </main>
  );
}

function HeroFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/15 bg-[#061a13]/80 px-3 py-3">
      <p className="text-xs font-semibold uppercase text-stone-300">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function PanelFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-stone-400">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  );
}

function AgentTimeline({
  events,
  nextRunAt,
  running
}: {
  events: AgentEvent[];
  nextRunAt: string;
  running: boolean;
}) {
  return (
    <div className="border border-emerald-950 bg-[#082016] p-4 text-white">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase">Agent log</h2>
          <p className="mt-1 text-sm text-stone-300">{formatDateTime(nextRunAt)}</p>
        </div>
        {running ? <RefreshCw size={18} className="animate-spin text-[#d8c7a3]" /> : <CalendarDays size={18} />}
      </div>

      <div className="mt-4 space-y-3">
        {events.length === 0 ? (
          <div className="border border-white/10 bg-white/5 px-3 py-3 text-sm text-stone-300">
            Waiting for the first scheduled check.
          </div>
        ) : (
          events.slice(0, 6).map((event) => (
            <div key={event.id} className="grid grid-cols-[10px_1fr] gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 ${eventTone(event.type)}`} />
              <div>
                <p className="text-sm font-medium text-white">{event.message}</p>
                <p className="mt-1 text-xs text-stone-400">{formatDateTime(event.createdAt)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ReturnType<typeof permissionStatus> }) {
  if (status === "granted") return <CheckCircle2 size={17} className="text-emerald-700" />;
  if (status === "pending") return <Clock size={17} className="text-amber-700" />;
  if (status === "expired") return <AlertTriangle size={17} className="text-rose-700" />;
  return <Wallet size={17} className="text-stone-500" />;
}

function statusClass(status: ReturnType<typeof permissionStatus>): string {
  if (status === "granted") return "bg-emerald-100 text-emerald-900";
  if (status === "pending") return "bg-amber-100 text-amber-900";
  return "bg-rose-100 text-rose-900";
}

function statusLabel(status: ReturnType<typeof permissionStatus>): string {
  if (status === "granted") return "Granted";
  if (status === "pending") return "Pending";
  if (status === "expired") return "Expired";
  return "Failed";
}

function eventTone(type: AgentEvent["type"]): string {
  if (type === "submitted" || type === "confirmed") return "bg-emerald-300";
  if (type === "blocked" || type === "failed") return "bg-rose-300";
  if (type === "checked") return "bg-[#d8c7a3]";
  return "bg-white/45";
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function formatDateTime(value?: string): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
