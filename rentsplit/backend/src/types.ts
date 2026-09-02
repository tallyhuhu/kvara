export type PermissionStatus = "pending" | "granted" | "expired" | "failed";
export type PaymentExecutionMode = "aa" | "one-shot";
export type PaymentStatus =
  | "scheduled"
  | "preparing"
  | "submission_unknown"
  | "pending"
  | "submitted"
  | "confirmed"
  | "rejected"
  | "failed";

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
  executionMode?: PaymentExecutionMode;
  relayerTargetAddress?: `0x${string}`;
  feeCollector?: `0x${string}`;
  sessionAccountAddress?: `0x${string}`;
  delegationManager?: `0x${string}`;
  dependencies?: Array<{ factory: `0x${string}`; factoryData: `0x${string}` }>;
  grantedAt: number;
  expiresAt: number;
  landlordAddress?: `0x${string}`;
  periodSeconds?: number;
  purpose?: string;
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
  scheduleTimeZone?: "UTC";
  closedAt?: string;
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
  executionMode?: PaymentExecutionMode;
  userOperationHash?: `0x${string}`;
  txHash?: string;
  basescanUrl?: string;
  error?: string;
  billingPeriod: string;
  idempotencyKey: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  failureStage?: "validation" | "estimate" | "submission" | "status";
};

export type AgentEvent = {
  id: string;
  groupId: string;
  type: "scheduled" | "checked" | "submitted" | "confirmed" | "blocked" | "failed" | "paused";
  message: string;
  createdAt: string;
};

export type AuthChallenge = {
  id: string;
  walletAddress: `0x${string}`;
  message: string;
  expiresAt: string;
  consumedAt?: string;
};

export type RentCycleStatus = "running" | "processing" | "completed" | "blocked" | "failed";

export type RentCycle = {
  groupId: string;
  billingPeriod: string;
  status: RentCycleStatus;
  leaseUntil: string;
  attemptCount: number;
  startedAt: string;
  updatedAt: string;
};
