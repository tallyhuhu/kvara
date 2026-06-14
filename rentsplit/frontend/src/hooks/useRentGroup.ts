import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyRentCommands,
  createId,
  deleteGroupLocal,
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
import { deleteGroupRemote, fetchGroup, fetchGroups, fetchPayments, saveGroupRemote } from "../lib/api";

type CreateGroupInput = {
  adminWalletAddress?: `0x${string}`;
  propertyName: string;
  propertyAddress: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  dueDay: number;
  rentRunTime: string;
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
    const invite = getInviteParams();

    setInviteRoommateId(invite?.roommateId ?? null);
    setHistory([]);

    if (invite?.payloadGroup) {
      setGroups([invite.payloadGroup]);
      setActiveGroup(invite.payloadGroup.id);
      return;
    }

    if (!invite?.groupId) {
      setGroups([]);
      setActiveGroup(null);
      return;
    }

    const inviteGroupId = invite.groupId;
    setActiveGroup(inviteGroupId);

    async function hydrateFromBackend() {
      try {
        const { group } = await fetchGroup(inviteGroupId);
        setGroups([group]);
        setActiveGroup(group.id);
        const { payments } = await fetchPayments(group.id);
        setHistory(payments);
      } catch {
        setGroups([]);
      }
    }

    void hydrateFromBackend();
  }, []);

  const loadGroupsForWallet = useCallback(async (walletAddress: `0x${string}`) => {
    try {
      const { groups: remoteGroups } = await fetchGroups(walletAddress);
      setGroups(remoteGroups);
      setActiveGroup(remoteGroups[0]?.id ?? null);
      setHistory([]);
      return remoteGroups;
    } catch {
      const localGroups = readGroups().filter((group) => groupBelongsToWallet(group, walletAddress));
      setGroups(localGroups);
      setActiveGroup(localGroups[0]?.id ?? null);
      setHistory(readPaymentHistory().filter((record) => localGroups.some((group) => group.id === record.groupId)));
      return localGroups;
    }
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
      adminWalletAddress: input.adminWalletAddress,
      propertyName: input.propertyName.trim() || "Apartment",
      propertyAddress: input.propertyAddress.trim(),
      landlordAddress: input.landlordAddress,
      totalRent: input.totalRent,
      dueDay: input.dueDay,
      rentRunTime: input.rentRunTime,
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
    setGroups((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setActiveGroup(saved.id);
    saveGroupRemote(saved).catch(() => undefined);
    return saved;
  }, []);

  const updateGroup = useCallback((group: RentGroup) => {
    const saved = upsertGroup(group);
    setGroups((current) => {
      const exists = current.some((item) => item.id === saved.id);
      if (!exists) return [saved, ...current];
      return current.map((item) => (item.id === saved.id ? saved : item));
    });
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

  const deleteGroup = useCallback(
    (groupId: string) => {
      const deleted = deleteGroupLocal(groupId);
      setGroups((current) => {
        const next = current.filter((group) => group.id !== groupId);
        setActiveGroup((currentActiveId) => (currentActiveId === groupId ? next[0]?.id ?? null : currentActiveId));
        return next;
      });
      setHistory((current) => {
        const next = current.filter((record) => record.groupId !== groupId);
        savePaymentHistory(next);
        return next;
      });
      if (deleted) deleteGroupRemote(groupId).catch(() => undefined);
      return deleted;
    },
    []
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
    deleteGroup,
    loadGroupsForWallet,
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

function groupBelongsToWallet(group: RentGroup, walletAddress: string): boolean {
  const wallet = walletAddress.toLowerCase();
  if (group.adminWalletAddress?.toLowerCase() === wallet) return true;
  return group.roommates.some((roommate) => roommate.walletAddress.toLowerCase() === wallet);
}
