import { FormEvent, useEffect, useMemo, useState } from "react";
import { Building2, CalendarDays, Copy, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { isAddress } from "viem";
import {
  DEFAULT_PERMISSION_BUFFER_PERCENT,
  createInviteUrl,
  demoRunInMinutes,
  formatUsd,
  nextMonthlyRun,
  normalizeAddress,
  splitEqual,
  type RentGroup
} from "../lib/groupStorage";

type DraftRoommate = {
  id: string;
  name: string;
  walletAddress: string;
  share: string;
};

type Props = {
  activeGroup: RentGroup | null;
  onCreate: (input: {
    propertyName: string;
    propertyAddress: string;
    landlordAddress: `0x${string}`;
    totalRent: string;
    dueDay: number;
    nextRunAt: string;
    autopayEnabled: boolean;
    permissionBufferPercent: number;
    roommates: Array<{ name: string; walletAddress: `0x${string}`; share: string }>;
  }) => RentGroup;
};

export function CreateGroup({ activeGroup, onCreate }: Props) {
  const [propertyName, setPropertyName] = useState(activeGroup?.propertyName ?? "Maple House");
  const [propertyAddress, setPropertyAddress] = useState(activeGroup?.propertyAddress ?? "24 Maple St, Apt 6B");
  const [landlordAddress, setLandlordAddress] = useState(activeGroup?.landlordAddress ?? "");
  const [totalRent, setTotalRent] = useState(activeGroup?.totalRent ?? "3000.00");
  const [dueDay, setDueDay] = useState(activeGroup?.dueDay ?? 1);
  const [autopayEnabled, setAutopayEnabled] = useState(activeGroup?.autopayEnabled ?? true);
  const [demoRunSoon, setDemoRunSoon] = useState(true);
  const [permissionBufferPercent, setPermissionBufferPercent] = useState(
    activeGroup?.permissionBufferPercent ?? DEFAULT_PERMISSION_BUFFER_PERCENT
  );
  const [customSplits, setCustomSplits] = useState(false);
  const [roommates, setRoommates] = useState<DraftRoommate[]>(
    activeGroup?.roommates.map((roommate) => ({
      id: roommate.id,
      name: roommate.name,
      walletAddress: roommate.walletAddress,
      share: roommate.share
    })) ?? [
      { id: crypto.randomUUID(), name: "Alex", walletAddress: "", share: "1000.00" },
      { id: crypto.randomUUID(), name: "Maya", walletAddress: "", share: "1000.00" },
      { id: crypto.randomUUID(), name: "Niko", walletAddress: "", share: "1000.00" }
    ]
  );
  const [createdGroup, setCreatedGroup] = useState<RentGroup | null>(activeGroup);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!activeGroup) return;
    setPropertyName(activeGroup.propertyName);
    setPropertyAddress(activeGroup.propertyAddress);
    setLandlordAddress(activeGroup.landlordAddress);
    setTotalRent(activeGroup.totalRent);
    setDueDay(activeGroup.dueDay);
    setAutopayEnabled(activeGroup.autopayEnabled);
    setPermissionBufferPercent(activeGroup.permissionBufferPercent);
    setRoommates(
      activeGroup.roommates.map((roommate) => ({
        id: roommate.id,
        name: roommate.name,
        walletAddress: roommate.walletAddress,
        share: roommate.share
      }))
    );
    setCreatedGroup(activeGroup);
  }, [activeGroup]);

  const equalSplits = useMemo(() => splitEqual(totalRent, roommates.length), [roommates.length, totalRent]);
  const totalShares = useMemo(
    () =>
      (customSplits ? roommates.map((roommate) => roommate.share) : equalSplits).reduce(
        (sum, share) => sum + Number(share || 0),
        0
      ),
    [customSplits, equalSplits, roommates]
  );

  function addRoommate() {
    setRoommates((current) => [
      ...current,
      { id: crypto.randomUUID(), name: `Roommate ${current.length + 1}`, walletAddress: "", share: "0.00" }
    ]);
  }

  function removeRoommate(id: string) {
    setRoommates((current) => current.filter((roommate) => roommate.id !== id));
  }

  function updateRoommate(id: string, patch: Partial<DraftRoommate>) {
    setRoommates((current) =>
      current.map((roommate, index) => {
        const share = customSplits ? roommate.share : equalSplits[index] ?? "0.00";
        return roommate.id === id ? { ...roommate, share, ...patch } : { ...roommate, share };
      })
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      if (roommates.length === 0) throw new Error("Add at least one roommate.");
      const normalizedRoommates = roommates.map((roommate, index) => ({
        name: roommate.name.trim() || `Roommate ${index + 1}`,
        walletAddress: normalizeAddress(roommate.walletAddress),
        share: customSplits ? roommate.share : equalSplits[index] ?? "0.00"
      }));

      const shareTotal = normalizedRoommates.reduce((sum, roommate) => sum + Number(roommate.share || 0), 0);
      if (Math.abs(shareTotal - Number(totalRent || 0)) > 0.01) {
        throw new Error("Roommate shares must add up to the monthly rent.");
      }

      const group = onCreate({
        propertyName,
        propertyAddress,
        landlordAddress: normalizeAddress(landlordAddress),
        totalRent,
        dueDay,
        nextRunAt: demoRunSoon ? demoRunInMinutes(1) : nextMonthlyRun(dueDay).toISOString(),
        autopayEnabled,
        permissionBufferPercent,
        roommates: normalizedRoommates
      });
      setCreatedGroup(group);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create group.");
    }
  }

  async function copyInvite(group: RentGroup, roommateId: string) {
    const invite = createInviteUrl(group, roommateId);
    await navigator.clipboard.writeText(invite);
    setCopied(roommateId);
    window.setTimeout(() => setCopied(null), 1400);
  }

  return (
    <section className="h-full border-r border-stone-200 bg-[#fbfaf7]">
      <div className="border-b border-stone-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-emerald-900 text-stone-50">
            <Building2 size={18} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-stone-950">Kvara</h1>
            <p className="text-sm text-stone-500">Autonomous rent desk</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 px-5 py-5">
        <div className="grid gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Property</span>
            <input
              value={propertyName}
              onChange={(event) => setPropertyName(event.target.value)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Address</span>
            <input
              value={propertyAddress}
              onChange={(event) => setPropertyAddress(event.target.value)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700">Landlord wallet</span>
          <input
            value={landlordAddress}
            onChange={(event) => setLandlordAddress(event.target.value)}
            placeholder="0x..."
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700">Monthly rent, USDC</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={totalRent}
            onChange={(event) => setTotalRent(event.target.value)}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
          />
        </label>

        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Due day</span>
            <input
              type="number"
              min="1"
              max="28"
              value={dueDay}
              onChange={(event) => setDueDay(Number(event.target.value))}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Buffer</span>
            <input
              type="number"
              min="0"
              max="100"
              value={permissionBufferPercent}
              onChange={(event) => setPermissionBufferPercent(Number(event.target.value))}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
        </div>

        <div className="rounded-md border border-stone-200 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
              <CalendarDays size={16} />
              Autopay
            </div>
            <Toggle enabled={autopayEnabled} onClick={() => setAutopayEnabled((value) => !value)} />
          </div>
          <button
            type="button"
            onClick={() => setDemoRunSoon((value) => !value)}
            className={`mt-3 w-full rounded-md border px-3 py-2 text-left text-xs font-semibold transition ${
              demoRunSoon
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-stone-200 bg-stone-50 text-stone-600"
            }`}
          >
            {demoRunSoon ? "Demo run: in 1 minute" : `Next run: day ${dueDay}`}
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <SlidersHorizontal size={16} />
            Custom splits
          </div>
          <Toggle enabled={customSplits} onClick={() => setCustomSplits((value) => !value)} />
        </div>

        <div className="space-y-3">
          {roommates.map((roommate, index) => {
            const share = customSplits ? roommate.share : equalSplits[index] ?? "0.00";
            return (
              <div key={roommate.id} className="rounded-md border border-stone-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <input
                    value={roommate.name}
                    onChange={(event) => updateRoommate(roommate.id, { name: event.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-700"
                  />
                  <button
                    type="button"
                    onClick={() => removeRoommate(roommate.id)}
                    className="grid h-8 w-8 place-items-center rounded-md border border-stone-200 text-stone-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                    aria-label="Remove roommate"
                    title="Remove roommate"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <input
                  value={roommate.walletAddress}
                  onChange={(event) => updateRoommate(roommate.id, { walletAddress: event.target.value })}
                  placeholder="Wallet 0x..."
                  className={`mb-2 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:border-emerald-500 ${
                    roommate.walletAddress && !isAddress(roommate.walletAddress)
                      ? "border-rose-300 bg-rose-50"
                      : "border-stone-300"
                  }`}
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-stone-500">Share</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={share}
                    disabled={!customSplits}
                    onChange={(event) => updateRoommate(roommate.id, { share: event.target.value })}
                    className="w-28 rounded-md border border-stone-300 px-2 py-1.5 text-sm outline-none disabled:bg-stone-100"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={addRoommate}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-emerald-700 hover:bg-emerald-50"
        >
          <Plus size={16} />
          Add roommate
        </button>

        <div className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-600">
          Split total: <span className="font-semibold text-stone-950">{formatUsd(totalShares)}</span> /{" "}
          {formatUsd(totalRent)}
        </div>

        {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        <button
          type="submit"
          className="w-full rounded-md bg-emerald-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-900 active:translate-y-[1px]"
        >
          Save apartment
        </button>
      </form>

      {createdGroup ? (
        <div className="border-t border-stone-200 px-5 py-4">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Invites</h2>
          <div className="space-y-2">
            {createdGroup.roommates.map((roommate) => (
              <button
                key={roommate.id}
                type="button"
                onClick={() => copyInvite(createdGroup, roommate.id)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-stone-200 bg-white px-3 py-2 text-left text-sm transition hover:bg-stone-50"
              >
                <span className="min-w-0 truncate text-stone-700">{roommate.name}</span>
                <span className="flex items-center gap-2 text-xs font-medium text-emerald-700">
                  {copied === roommate.id ? "Copied" : "Copy"}
                  <Copy size={14} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Toggle({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={onClick}
      className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-emerald-800" : "bg-stone-300"}`}
    >
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${enabled ? "left-6" : "left-1"}`} />
    </button>
  );
}
