import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { isAddress } from "viem";
import { z } from "zod";
import { getAaExecutorInfo } from "./aaExecutor.js";
import { getRelayerCapabilities, refreshTaskStatuses } from "./agent.js";
import { authenticatedWallet, AuthError, issueAuthChallenge, requireAuth, verifyAuthChallenge } from "./auth.js";
import { ONE_SHOT_ATTRIBUTION_SUPPORT, getBuilderAttribution } from "./baseAttribution.js";
import { assertProductionConfig, BASE_CHAIN_ID, USDC_BASE_ADDRESS, config } from "./config.js";
import { applyRentCommands, isGroupAdmin, isGroupMember, validateGroupForSave } from "./domain.js";
import { logError, logInfo } from "./logger.js";
import { getAgentState, runAgentNow, scheduleGroup, startScheduler } from "./scheduler.js";
import { closeGroup, createGroup, getGroup, GroupChangedError, initStore, listGroups, listPayments, saveGroupIfUnchanged, storeMode } from "./store.js";
import type { PermissionGrant, RentGroup } from "./types.js";
import { runVeniceAgent, VeniceError } from "./veniceAgent.js";

const walletSchema = z.string().refine(isAddress, "A valid EVM wallet address is required.");
const roommateSchema = z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(80), walletAddress: walletSchema,
  share: z.string().min(1).max(48), permission: z.unknown().optional()
});
const groupSchema = z.object({
  id: z.string().min(1).max(160).optional(), propertyName: z.string().max(120).optional(),
  propertyAddress: z.string().max(240).optional(), landlordAddress: walletSchema,
  totalRent: z.string().min(1).max(48), dueDay: z.number().int().min(1).max(28).optional(),
  rentRunTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), nextRunAt: z.string().datetime().optional(),
  autopayEnabled: z.boolean().optional(), permissionBufferPercent: z.number().int().min(0).max(100).optional(),
  roommates: z.array(roommateSchema).min(1).max(20), createdAt: z.number().optional(), updatedAt: z.number().optional()
});
const permissionSchema = z.object({
  status: z.enum(["pending", "granted", "expired", "failed"]), walletAddress: walletSchema,
  permissionContext: z.array(z.unknown()).min(1), rawContext: z.string().min(1).max(500_000),
  allowanceAtoms: z.string().regex(/^\d+$/), shareAtoms: z.string().regex(/^\d+$/),
  adjustmentBufferAtoms: z.string().regex(/^\d+$/).optional(), adjustmentBufferPercent: z.number().min(0).max(100).optional(),
  feeBufferAtoms: z.string().regex(/^\d+$/), tokenAddress: walletSchema, tokenDecimals: z.number().int().min(0).max(36),
  executionMode: z.enum(["aa", "one-shot"]).optional(), relayerTargetAddress: walletSchema.optional(),
  feeCollector: walletSchema.optional(), sessionAccountAddress: walletSchema.optional(), delegationManager: walletSchema.optional(),
  dependencies: z.array(z.object({ factory: walletSchema, factoryData: z.string().regex(/^0x[0-9a-fA-F]*$/) })).max(20).optional(),
  grantedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(), landlordAddress: walletSchema.optional(), periodSeconds: z.number().int().positive().optional(),
  purpose: z.string().max(240).optional(), taskIds: z.array(z.string().max(160)).max(24).optional(), error: z.string().max(500).optional()
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    callback(new HttpError(403, "Origin is not allowed."));
  },
  methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Authorization", "Content-Type"]
}));
app.use(express.json({ limit: "600kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const agentLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });

assertProductionConfig();
await initStore();

app.get("/api/health", asyncRoute(async (_req, res) => {
  const builder = getBuilderAttribution(config.baseBuilderCode);
  const aaExecutor = config.paymentExecutionMode === "aa" ? await getAaExecutorInfo() : undefined;
  res.json({ ok: true, network: "Base Mainnet", chainId: BASE_CHAIN_ID, store: storeMode(),
    schedulerEnabled: config.schedulerEnabled, veniceConfigured: Boolean(process.env.VENICE_API_KEY),
    agentConfigured: Boolean(process.env.AGENT_PRIVATE_KEY), builderAttribution: builder.status,
    paymentExecutionMode: config.paymentExecutionMode,
    executionConfigured: config.paymentExecutionMode === "aa" ? aaExecutor?.configured : true,
    autonomousPaymentAttribution: config.paymentExecutionMode === "aa"
      ? builder.status === "configured"
      : ONE_SHOT_ATTRIBUTION_SUPPORT.supported });
}));

app.get("/api/execution-config", asyncRoute(async (_req, res) => {
  const aaExecutor = config.paymentExecutionMode === "aa" ? await getAaExecutorInfo() : undefined;
  res.json({
    chainId: BASE_CHAIN_ID,
    tokenAddress: USDC_BASE_ADDRESS,
    mode: config.paymentExecutionMode,
    configured: config.paymentExecutionMode === "aa" ? Boolean(aaExecutor?.configured) : true,
    executorAddress: aaExecutor?.address,
    paymasterEnabled: aaExecutor?.paymasterEnabled ?? false,
    builderAttribution: getBuilderAttribution(config.baseBuilderCode).status
  });
}));

app.post("/api/auth/challenge", authLimiter, asyncRoute(async (req, res) => {
  const { walletAddress } = z.object({ walletAddress: walletSchema }).parse(req.body);
  res.json({ challenge: await issueAuthChallenge(walletAddress) });
}));
app.post("/api/auth/verify", authLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ challengeId: z.string().uuid(), walletAddress: walletSchema,
    message: z.string().min(1).max(2_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
  res.json(await verifyAuthChallenge(input as Parameters<typeof verifyAuthChallenge>[0]));
}));

app.use("/api", requireAuth);
app.get("/api/groups", asyncRoute(async (req, res) => {
  res.json({ groups: await listGroups(authenticatedWallet(req)) });
}));
app.get("/api/groups/:groupId", asyncRoute(async (req, res) => {
  res.json({ group: await requireMemberGroup(routeParam(req, "groupId"), authenticatedWallet(req)) });
}));
app.post("/api/groups", asyncRoute(async (req, res) => {
  const wallet = authenticatedWallet(req);
  const body = groupSchema.parse(req.body.group);
  const now = Date.now();
  const group = validateGroupForSave({ ...body, id: randomUUID(), adminWalletAddress: wallet,
    roommates: body.roommates.map((roommate) => ({ ...roommate, id: randomUUID(), permission: undefined })),
    createdAt: now, updatedAt: now } as RentGroup);
  const saved = await createGroup(group);
  if (saved.autopayEnabled) await scheduleGroup(saved.id);
  res.status(201).json({ group: (await getGroup(saved.id)) ?? saved });
}));
app.put("/api/groups/:groupId", asyncRoute(async (req, res) => {
  const current = await requireAdminGroup(routeParam(req, "groupId"), authenticatedWallet(req));
  const body = groupSchema.parse(req.body.group);
  const currentRoommateById = new Map(current.roommates.map((roommate) => [roommate.id, roommate]));
  const next = validateGroupForSave({ ...current, ...body, id: current.id, adminWalletAddress: current.adminWalletAddress,
    createdAt: current.createdAt, closedAt: current.closedAt,
    roommates: body.roommates.map((roommate) => {
      const previous = currentRoommateById.get(roommate.id);
      const permission = previous?.walletAddress.toLowerCase() === roommate.walletAddress.toLowerCase()
        && (!previous.permission?.landlordAddress || previous.permission.landlordAddress.toLowerCase() === body.landlordAddress.toLowerCase())
        ? previous.permission
        : undefined;
      return { ...roommate, permission };
    }),
    updatedAt: Date.now() } as RentGroup);
  res.json({ group: await saveGroupIfUnchanged(current, next) });
}));
app.put("/api/groups/:groupId/roommates/:roommateId/permission", asyncRoute(async (req, res) => {
  const wallet = authenticatedWallet(req);
  const group = await requireMemberGroup(routeParam(req, "groupId"), wallet);
  const roommateId = routeParam(req, "roommateId");
  const roommate = group.roommates.find((item) => item.id === roommateId);
  if (!roommate) throw new HttpError(404, "Resident not found.");
  if (roommate.walletAddress.toLowerCase() !== wallet.toLowerCase()) throw new HttpError(403, "You can only attach a permission granted by your own wallet.");
  const permission = permissionSchema.parse(req.body.permission) as PermissionGrant;
  if (permission.walletAddress.toLowerCase() !== wallet.toLowerCase()) throw new HttpError(400, "Permission wallet does not match the authenticated wallet.");
  if (permission.executionMode === "aa") {
    const executor = await getAaExecutorInfo();
    if (!executor.configured || !executor.address) throw new HttpError(503, "Kvara smart-account execution is not configured.");
    if (permission.sessionAccountAddress?.toLowerCase() !== executor.address.toLowerCase()) {
      throw new HttpError(400, "Permission does not target the configured Kvara smart account.");
    }
    if (!permission.delegationManager) throw new HttpError(400, "Permission is missing its delegation manager.");
  } else if (!permission.relayerTargetAddress || !permission.feeCollector) {
    throw new HttpError(400, "1Shot permission is missing relayer execution data.");
  }
  const saved = await saveGroupIfUnchanged(group, { ...group,
    roommates: group.roommates.map((item) => item.id === roommate.id ? { ...item, permission } : item), updatedAt: Date.now() });
  res.json({ group: saved });
}));
app.delete("/api/groups/:groupId", asyncRoute(async (req, res) => {
  const groupId = routeParam(req, "groupId");
  await requireAdminGroup(groupId, authenticatedWallet(req));
  await closeGroup(groupId);
  res.json({ ok: true, revokedOnchain: false });
}));
app.get("/api/groups/:groupId/payments", asyncRoute(async (req, res) => {
  const groupId = routeParam(req, "groupId");
  await requireMemberGroup(groupId, authenticatedWallet(req));
  res.json({ payments: await listPayments(groupId) });
}));
app.get("/api/relayer/capabilities", asyncRoute(async (_req, res) => {
  res.json(await getRelayerCapabilities());
}));
app.post("/api/status", asyncRoute(async (req, res) => {
  const input = z.object({ groupId: z.string().min(1), taskIds: z.array(z.string().min(1)).max(100) }).parse(req.body);
  await requireMemberGroup(input.groupId, authenticatedWallet(req));
  const allowed = new Set((await listPayments(input.groupId)).map((payment) => payment.taskId).filter(Boolean));
  res.json({ payments: await refreshTaskStatuses(input.taskIds.filter((taskId) => allowed.has(taskId))) });
}));
app.post("/api/agent/schedule", agentLimiter, asyncRoute(async (req, res) => {
  const { groupId } = z.object({ groupId: z.string().min(1) }).parse(req.body);
  await requireAdminGroup(groupId, authenticatedWallet(req));
  res.json(await scheduleGroup(groupId));
}));
app.post("/api/agent/run", agentLimiter, asyncRoute(async (req, res) => {
  const { groupId } = z.object({ groupId: z.string().min(1) }).parse(req.body);
  await requireAdminGroup(groupId, authenticatedWallet(req));
  res.json(await runAgentNow(groupId));
}));
app.get("/api/agent/:groupId", asyncRoute(async (req, res) => {
  const groupId = routeParam(req, "groupId");
  await requireMemberGroup(groupId, authenticatedWallet(req));
  res.json(await getAgentState(groupId));
}));
app.post("/api/venice/chat", agentLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ groupId: z.string().min(1), message: z.string().trim().min(1).max(2_000),
    conversation: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2_000) })).max(12).optional()
  }).parse(req.body);
  const group = await requireAdminGroup(input.groupId, authenticatedWallet(req));
  const result = await runVeniceAgent({ message: input.message, group, history: await listPayments(group.id), conversation: input.conversation });
  const updatedGroup = result.commands.length ? await saveGroupIfUnchanged(group, applyRentCommands(group, result.commands)) : await requireAdminGroup(input.groupId, authenticatedWallet(req));
  res.json({ ...result, group: updatedGroup });
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof VeniceError) return void res.status(error.status).json({ error: error.message });
  if (error instanceof z.ZodError) return void res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request." });
  if (error instanceof HttpError) return void res.status(error.status).json({ error: error.message });
  if (error instanceof AuthError) return void res.status(401).json({ error: error.message });
  if (error instanceof GroupChangedError) return void res.status(409).json({ error: error.message });
  logError("http.request.failed", error);
  res.status(500).json({ error: "The request could not be completed." });
});

startScheduler();
app.listen(config.port, () => logInfo("server.started", { port: config.port, store: storeMode(), chainId: BASE_CHAIN_ID }));

async function requireMemberGroup(groupId: string, walletAddress: string): Promise<RentGroup> {
  const group = await getGroup(groupId);
  if (!group || group.closedAt) throw new HttpError(404, "Household not found.");
  if (!isGroupMember(group, walletAddress)) throw new HttpError(403, "You do not have access to this household.");
  return group;
}
async function requireAdminGroup(groupId: string, walletAddress: string): Promise<RentGroup> {
  const group = await requireMemberGroup(groupId, walletAddress);
  if (!isGroupAdmin(group, walletAddress)) throw new HttpError(403, "Only the household admin can perform this action.");
  return group;
}
function asyncRoute(handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>): express.RequestHandler {
  return (req, res, next) => void handler(req, res, next).catch(next);
}
function routeParam(req: express.Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value) throw new HttpError(400, `Missing route parameter: ${name}.`);
  return value;
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
