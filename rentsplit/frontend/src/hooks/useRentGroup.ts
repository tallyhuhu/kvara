import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createId, demoRunInMinutes, getInviteParams, permissionStatus, splitEqual,
  type PaymentRecord, type PermissionGrant, type RentCommand, type RentGroup, type Roommate
} from "../lib/groupStorage";
import {
  authenticateWallet, createGroupRemote, deleteGroupRemote, fetchGroups, fetchPayments,
  savePermissionRemote, updateGroupRemote
} from "../lib/api";

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

type BrowserProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function useRentGroup() {
  const invite = useMemo(() => getInviteParams(), []);
  const [groups, setGroups] = useState<RentGroup[]>([]);
  const [activeGroupId, setActiveGroupIdState] = useState<string | null>(invite?.groupId ?? null);
  const [history, setHistory] = useState<PaymentRecord[]>([]);

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [activeGroupId, groups]
  );
  const inviteRoommate = useMemo(() => {
    if (!activeGroup || !invite?.roommateId) return null;
    return activeGroup.roommates.find((roommate) => roommate.id === invite.roommateId) ?? null;
  }, [activeGroup, invite]);

  const replaceGroup = useCallback((group: RentGroup) => {
    setGroups((current) => current.some((item) => item.id === group.id)
      ? current.map((item) => item.id === group.id ? group : item)
      : [group, ...current]);
    setActiveGroupIdState(group.id);
    return group;
  }, []);

  const loadGroupsForWallet = useCallback(async (walletAddress: `0x${string}`) => {
    const provider = window.ethereum as BrowserProvider | undefined;
    if (!provider) throw new Error("MetaMask is not available in this browser.");
    await authenticateWallet(walletAddress, provider);
    const { groups: remoteGroups } = await fetchGroups();
    setGroups(remoteGroups);
    const invited = invite?.groupId ? remoteGroups.find((group) => group.id === invite.groupId) : undefined;
    setActiveGroupIdState(invited?.id ?? remoteGroups[0]?.id ?? null);
    setHistory([]);
    return remoteGroups;
  }, [invite]);

  const createGroup = useCallback(async (input: CreateGroupInput) => {
    const defaultSplits = splitEqual(input.totalRent, input.roommates.length);
    const draft: RentGroup = {
      id: createId("group"), adminWalletAddress: input.adminWalletAddress,
      propertyName: input.propertyName.trim() || "Apartment", propertyAddress: input.propertyAddress.trim(),
      landlordAddress: input.landlordAddress, totalRent: input.totalRent, dueDay: input.dueDay,
      rentRunTime: input.rentRunTime, nextRunAt: input.nextRunAt || demoRunInMinutes(1),
      autopayEnabled: input.autopayEnabled, permissionBufferPercent: input.permissionBufferPercent,
      roommates: input.roommates.map((roommate, index) => ({
        id: createId("roommate"), name: roommate.name.trim() || `Roommate ${index + 1}`,
        walletAddress: roommate.walletAddress, share: roommate.share?.trim() || defaultSplits[index] || "0.00"
      })),
      createdAt: Date.now(), updatedAt: Date.now()
    };
    const { group } = await createGroupRemote(draft);
    return replaceGroup(group);
  }, [replaceGroup]);

  const updateGroup = useCallback(async (group: RentGroup) => {
    const response = await updateGroupRemote(group);
    return replaceGroup(response.group);
  }, [replaceGroup]);

  const updateRoommatePermission = useCallback(async (roommateId: string, permission: PermissionGrant) => {
    if (!activeGroup) throw new Error("Household not found.");
    const response = await savePermissionRemote(activeGroup.id, roommateId, permission);
    replaceGroup(response.group);
  }, [activeGroup, replaceGroup]);

  const deleteGroup = useCallback(async (groupId: string) => {
    await deleteGroupRemote(groupId);
    setGroups((current) => {
      const next = current.filter((group) => group.id !== groupId);
      setActiveGroupIdState((currentId) => currentId === groupId ? next[0]?.id ?? null : currentId);
      return next;
    });
    setHistory((current) => current.filter((record) => record.groupId !== groupId));
    return true;
  }, []);

  useEffect(() => {
    if (!activeGroup) return;
    let cancelled = false;
    fetchPayments(activeGroup.id).then(({ payments }) => {
      if (!cancelled) setHistory(payments);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeGroup]);

  const mergePaymentRecords = useCallback((records: PaymentRecord[]) => {
    setHistory((current) => {
      const byId = new Map(current.map((record) => [record.id, record]));
      for (const record of records) byId.set(record.id, { ...byId.get(record.id), ...record });
      return Array.from(byId.values()).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    });
  }, []);

  const applyCommands = useCallback(async (_commands: RentCommand[], serverGroup: RentGroup) => {
    return replaceGroup(serverGroup);
  }, [replaceGroup]);

  const groupHistory = useMemo(
    () => activeGroup ? history.filter((record) => record.groupId === activeGroup.id) : [],
    [activeGroup, history]
  );
  const stats = useMemo(() => {
    const roommates: Roommate[] = activeGroup?.roommates ?? [];
    const granted = roommates.filter((roommate) => permissionStatus(roommate) === "granted").length;
    const now = new Date();
    const monthlyTotal = groupHistory.filter((record) => record.status === "confirmed")
      .filter((record) => { const date = new Date(record.date); return date.getUTCMonth() === now.getUTCMonth() && date.getUTCFullYear() === now.getUTCFullYear(); })
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    return { granted, total: roommates.length, monthlyTotal };
  }, [activeGroup, groupHistory]);

  return {
    groups, activeGroup, setActiveGroupId: setActiveGroupIdState, createGroup, updateGroup,
    updateRoommatePermission, deleteGroup, loadGroupsForWallet, inviteRoommate,
    isInvite: Boolean(invite?.roommateId), history: groupHistory, allHistory: history,
    mergePaymentRecords, applyCommands, replaceGroup, stats
  };
}
