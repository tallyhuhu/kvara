import { AlertTriangle, Building2, CheckCircle2, ShieldCheck, Wallet } from "lucide-react";
import { formatUnits } from "viem";
import { useMetaMaskPermissions } from "../hooks/useMetaMaskPermissions";
import {
  BASE_EXPLORER_URL,
  RENT_PERIOD_SECONDS,
  formatUsd,
  permissionStatus,
  type PermissionGrant,
  type RentGroup,
  type Roommate
} from "../lib/groupStorage";

type Props = {
  group: RentGroup;
  roommate: Roommate;
  onPermissionGranted: (roommateId: string, permission: PermissionGrant) => void;
};

export function RoommateOnboard({ group, roommate, onPermissionGranted }: Props) {
  const { loading, error, detail, requestRentPermission } = useMetaMaskPermissions();
  const status = permissionStatus(roommate);
  const grant = roommate.permission;

  async function handleGrant() {
    const permission = await requestRentPermission(group, roommate);
    onPermissionGranted(roommate.id, permission);
  }

  return (
    <main className="min-h-[100dvh] bg-[#f4f1ea]">
      <div className="mx-auto grid min-h-[100dvh] max-w-5xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[1fr_340px]">
        <section className="flex min-h-[520px] flex-col justify-between rounded-md bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div>
            <div className="mb-8 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-md bg-emerald-950 text-stone-50">
                <Building2 size={20} />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-stone-950">{group.propertyName}</h1>
                <p className="text-sm text-stone-500">{roommate.name}</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Info label="Monthly share" value={`${formatUsd(roommate.share)} USDC`} />
              <Info label="Max permission" value={grant ? `${formatUnits(BigInt(grant.allowanceAtoms), grant.tokenDecimals)} USDC` : `share + ${group.permissionBufferPercent}%`} />
              <Info label="Period" value={`${Math.round(RENT_PERIOD_SECONDS / 86400)} days`} />
              <Info label="Wallet" value={short(roommate.walletAddress)} />
              <Info label="Landlord" value={short(group.landlordAddress)} />
            </div>

            {grant ? (
              <div className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={18} />
                  Permission granted
                </div>
                <p className="mt-2 text-sm text-emerald-700">
                  {formatUnits(BigInt(grant.allowanceAtoms), grant.tokenDecimals)} USDC / 30 days
                </p>
              </div>
            ) : null}

            {error ? (
              <div className="mt-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle size={16} />
                  Permission failed
                </div>
                {error}
              </div>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleGrant}
              disabled={loading || status === "granted"}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              <Wallet size={18} />
              {status === "granted" ? "Permission active" : loading ? detail ?? "Opening MetaMask" : "Grant permission"}
            </button>
            <a
              href={`${BASE_EXPLORER_URL}/address/${group.landlordAddress}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-white"
            >
              View landlord
            </a>
          </div>
        </section>

        <aside className="rounded-md bg-emerald-950 p-5 text-white shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={18} className="text-emerald-200" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-100">Scope</h2>
          </div>
          <dl className="mt-4 space-y-4 text-sm">
            <ScopeRow label="Token" value="USDC on Base" />
            <ScopeRow label="Type" value="erc20-token-periodic" />
            <ScopeRow label="Limit" value={`${formatUsd(roommate.share)} + ${group.permissionBufferPercent}%`} />
            <ScopeRow label="Status" value={status} />
          </dl>
        </aside>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-all text-sm font-semibold text-slate-950">{value}</dd>
    </div>
  );
}

function ScopeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-3">
      <dt className="text-slate-300">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

function short(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
