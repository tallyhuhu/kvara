import "dotenv/config";
import cors from "cors";
import express from "express";
import { collectGroupRent, getRelayerCapabilities, refreshTaskStatuses } from "./agent.js";
import { getAgentState, runAgentNow, scheduleGroup } from "./scheduler.js";
import { getGroup, initStore, listGroups, listPayments, saveGroup, savePaymentRecords, storeMode } from "./store.js";
import { runVeniceAgent } from "./veniceAgent.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

await initStore();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    network: "Base",
    chainId: 8453,
    store: storeMode(),
    veniceConfigured: Boolean(process.env.VENICE_API_KEY),
    agentConfigured: Boolean(process.env.AGENT_PRIVATE_KEY)
  });
});

app.get("/api/groups", async (_req, res, next) => {
  try {
    res.json({ groups: await listGroups() });
  } catch (cause) {
    next(cause);
  }
});

app.get("/api/groups/:groupId", async (req, res, next) => {
  try {
    const group = await getGroup(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    res.json({ group });
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/groups", async (req, res, next) => {
  try {
    const group = await saveGroup(req.body.group);
    if (group.autopayEnabled) {
      await scheduleGroup(group);
    }
    res.json({ group });
  } catch (cause) {
    next(cause);
  }
});

app.get("/api/groups/:groupId/payments", async (req, res, next) => {
  try {
    res.json({ payments: await listPayments(req.params.groupId) });
  } catch (cause) {
    next(cause);
  }
});

app.get("/api/relayer/capabilities", async (_req, res, next) => {
  try {
    res.json(await getRelayerCapabilities());
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/collect", async (req, res, next) => {
  try {
    const payments = await collectGroupRent(req.body.group);
    await saveGroup(req.body.group);
    await savePaymentRecords(payments);
    res.json({ payments });
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/status", async (req, res, next) => {
  try {
    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : [];
    const payments = await refreshTaskStatuses(taskIds);
    await savePaymentRecords(payments);
    res.json({ payments });
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/agent/schedule", async (req, res, next) => {
  try {
    res.json(await scheduleGroup(req.body.group));
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/agent/run", async (req, res, next) => {
  try {
    res.json(await runAgentNow(req.body.group));
  } catch (cause) {
    next(cause);
  }
});

app.get("/api/agent/:groupId", async (req, res, next) => {
  try {
    res.json(await getAgentState(req.params.groupId));
  } catch (cause) {
    next(cause);
  }
});

app.post("/api/venice/chat", async (req, res, next) => {
  try {
    const result = await runVeniceAgent({
      message: String(req.body.message ?? ""),
      group: req.body.group,
      history: Array.isArray(req.body.history) ? req.body.history : []
    });
    res.json(result);
  } catch (cause) {
    next(cause);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Kvara backend listening on http://localhost:${port}`);
});
