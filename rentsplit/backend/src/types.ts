export type PermissionStatus = "pending" | "granted" | "expired" | "failed";
export type PaymentStatus = "pending" | "submitted" | "confirmed" | "rejected" | "failed";

export type PermissionGrant = {
  status: PermissionStatus;
  walletAddress: `0x${string}`;
  permissionContext: unknown[];
  rawContext: string;
  allowanceAtoms: string;
  shareAtoms: string;
  adjustmentBufferAtoms?: string;
  adjustmentBufferPercent?: number;
  feeBufferAtoms: string;
  tokenAddress: `0x${string}`;
  tokenDecimals: number;
  relayerTargetAddress: `0x${string}`;
  feeCollector: `0x${string}`;
  grantedAt: number;
  expiresAt: number;
  taskIds?: string[];
  error?: string;
};

export type Roommate = {
  id: string;
  name: string;
  walletAddress: `0x${string}`;
  share: string;
  permission?: PermissionGrant;
};

export type RentGroup = {
  id: string;
  adminWalletAddress?: `0x${string}`;
  propertyName?: string;
  propertyAddress?: string;
  landlordAddress: `0x${string}`;
  totalRent: string;
  dueDay?: number;
  rentRunTime?: string;
  nextRunAt?: string;
  autopayEnabled?: boolean;
  permissionBufferPercent?: number;
  roommates: Roommate[];
  createdAt: number;
  updatedAt: number;
};

export type PaymentRecord = {
  id: string;
  groupId: string;
  roommateId: string;
  roommateName: string;
  walletAddress: `0x${string}`;
  amount: string;
  date: string;
  status: PaymentStatus;
  taskId?: string;
  txHash?: string;
  basescanUrl?: string;
  error?: string;
};

export type AgentEvent = {
  id: string;
  groupId: string;
  type: "scheduled" | "checked" | "submitted" | "confirmed" | "blocked" | "failed";
  message: string;
  createdAt: string;
};
