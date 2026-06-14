import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyRentCommands,
  createId,
  demoRunInMinutes,
  getActiveGroupId,
  getInviteParams,
  permissionStatus,
  readGroups,
  readPaymentHistory,
  savePaymentHistory,
  setActiveGroupId,
  splitEqual,
  upsertGroup,
  type PaymentRecord,
  type PermissionGrant,
  type RentCommand,
  type RentGroup,
  type Roommate
} from "../lib/groupStorage";
import { fetchGroup, fetchGroups, fetchPayments, saveGroupRemote } from "../lib/api";

type CreateGroupInput = {
  propertyName: string;
  propertyAddress: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  dueDay: number;
  nextRunAt: string;
  autopayEnabled: boolean;
  permissionBufferPercent: number;
  roommates: Array<{ name: string; walletAddress: `0x${string}`; share?: string }>;
};

export function useRentGroup() {
  const [groups, setGroups] = useState<RentGroup[]>([]);
  const [activeGroupId, setActiveGroup] = useState<string | null>(null);
  const [history, setHistory] = useState<PaymentRecord[]>([]);
  const [inviteRoommateId, setInviteRoommateId] = useState<string | null>(null);

  useEffect(() => {
    const savedGroups = readGroups();
    const invite = getInviteParams();

    let nextGroups = savedGroups;
    let nextActiveGroupId = getActiveGroupId() ?? savedGroups[0]?.id ?? null;

    if (invite?.payloadGroup) {
      const imported = upsertGroup(invite.payloadGroup);
      nextGroups = readGroups();
      nextActiveGroupId = imported.id;
    } else if (invite?.groupId) {
      nextActiveGroupId = invite.groupId;
      setActiveGroupId(invite.groupId);
    }

    setGroups(nextGroups);
    setActiveGroup(nextActiveGroupId);
    setInviteRoommateId(invite?.roommateId ?? null);
    setHistory(readPaymentHistory());

    async function hydrateFromBackend() {
      try {
        if (invite?.groupId) {
          const { group } = await fetchGroup(invite.groupId);
          const saved = upsertGroup(group);
          setGroups(readGroups());
          setActiveGroup(saved.id);
          const { payments } = await fetchPayments(saved.id);
          setHistory(payments);
          return;
        }

        const { groups: remoteGroups } = await fetchGroups();
        if (remoteGroups.length === 0) return;
        remoteGroups.forEach((group) => upsertGroup(group));
        const refreshedGroups = readGroups();
        const nextId = getActiveGroupId() ?? refreshedGroups[0]?.id ?? null;
        setGroups(refreshedGroups);
        setActiveGroup(nextId);
      } catch {
        // Local cache keeps the demo usable without a backend or DATABASE_URL.
      }
    }

    void hydrateFromBackend();
  }, []);

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [activeGroupId, groups]
  );

  const inviteRoommate = useMemo(() => {
    if (!activeGroup || !inviteRoommateId) return null;
    return activeGroup.roommates.find((roommate) => roommate.id === inviteRoommateId) ?? null;
  }, [activeGroup, inviteRoommateId]);

  const createGroup = useCallback((input: CreateGroupInput) => {
    const defaultSplits = splitEqual(input.totalRent, input.roommates.length);
    const group: RentGroup = {
      id: createId("group"),
      propertyName: input.propertyName.trim() || "Apartment",
      propertyAddress: input.propertyAddress.trim(),
      landlordAddress: input.landlordAddress,
      totalRent: input.totalRent,
      dueDay: input.dueDay,
      nextRunAt: input.nextRunAt || demoRunInMinutes(1),
      autopayEnabled: input.autopayEnabled,
      permissionBufferPercent: input.permissionBufferPercent,
      roommates: input.roommates.map((roommate, index) => ({
        id: createId("roommate"),
        name: roommate.name.trim() || `Roommate ${index + 1}`,
        walletAddress: roommate.walletAddress,
        share: roommate.share?.trim() || defaultSplits[index] || "0.00"
      })),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const saved = upsertGroup(group);
    setGroups(readGroups());
    setActiveGroup(saved.id);
    saveGroupRemote(saved).catch(() => undefined);
    return saved;
  }, []);

  const updateGroup = useCallback((group: RentGroup) => {
    const saved = upsertGroup(group);
    setGroups(readGroups());
    setActiveGroup(saved.id);
    saveGroupRemote(saved).catch(() => undefined);
    return saved;
  }, []);

  useEffect(() => {
    if (!activeGroup) return;
    fetchPayments(activeGroup.id)
      .then(({ payments }) => setHistory(payments))
      .catch(() => undefined);
  }, [activeGroup]);

  const updateRoommatePermission = useCallback(
    (roommateId: string, permission: PermissionGrant) => {
      if (!activeGroup) return;
      const next: RentGroup = {
        ...activeGroup,
        updatedAt: Date.now(),
        roommates: activeGroup.roommates.map((roommate) =>
          roommate.id === roommateId ? { ...roommate, permission } : roommate
        )
      };
      updateGroup(next);
    },
    [activeGroup, updateGroup]
  );

  const addPaymentRecords = useCallback((records: PaymentRecord[]) => {
    setHistory((current) => {
      const next = [...records, ...current];
      savePaymentHistory(next);
      return next;
    });
  }, []);

  const mergePaymentRecords = useCallback((records: PaymentRecord[]) => {
    setHistory((current) => {
      const byId = new Map(current.map((record) => [record.id, record]));
      for (const record of records) {
        byId.set(record.id, { ...byId.get(record.id), ...record });
      }
      const next = Array.from(byId.values()).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      savePaymentHistory(next);
      return next;
    });
  }, []);

  const applyCommands = useCallback(
    (commands: RentCommand[]) => {
      if (!activeGroup || commands.length === 0) return activeGroup;
      const next = applyRentCommands(activeGroup, commands);
      return updateGroup(next);
    },
    [activeGroup, updateGroup]
  );

  const groupHistory = useMemo(
    () => (activeGroup ? history.filter((record) => record.groupId === activeGroup.id) : []),
    [activeGroup, history]
  );

  const stats = useMemo(() => {
    const roommates: Roommate[] = activeGroup?.roommates ?? [];
    const granted = roommates.filter((roommate) => permissionStatus(roommate) === "granted").length;
    const monthlyTotal = groupHistory
      .filter((record) => record.status === "confirmed")
      .filter((record) => new Date(record.date).getMonth() === new Date().getMonth())
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    return { granted, total: roommates.length, monthlyTotal };
  }, [activeGroup, groupHistory]);

  return {
    groups,
    activeGroup,
    setActiveGroupId: (groupId: string) => {
      setActiveGroupId(groupId);
      setActiveGroup(groupId);
    },
    createGroup,
    updateGroup,
    updateRoommatePermission,
    inviteRoommate,
    isInvite: Boolean(inviteRoommateId),
    history: groupHistory,
    allHistory: history,
    addPaymentRecords,
    mergePaymentRecords,
    applyCommands,
    stats
  };
}
