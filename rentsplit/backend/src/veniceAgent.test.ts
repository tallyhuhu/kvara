import assert from "node:assert/strict";
import test from "node:test";
import { runVeniceAgent, VeniceError, veniceErrorDetail } from "./veniceAgent.js";
import type { RentGroup } from "./types.js";

const group: RentGroup = {
  id: "home", propertyName: "Test", landlordAddress: "0x0000000000000000000000000000000000000003",
  totalRent: "0.10", createdAt: 1, updatedAt: 1,
  roommates: [
    { id: "a", name: "Alex", walletAddress: "0x0000000000000000000000000000000000000001", share: "0.05" },
    { id: "b", name: "Mike", walletAddress: "0x0000000000000000000000000000000000000002", share: "0.05" }
  ]
};
const change = {
  message: "Alex: 0.061667 USDC; Mike: 0.038333 USDC.",
  commands: [{ type: "set_splits", splits: [{ roommateId: "a", share: "0.061667" }, { roommateId: "b", share: "0.038333" }] }]
};

test("Venice request and validation", async (t) => {
  const key = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = "test-only";
  t.after(() => { if (key === undefined) delete process.env.VENICE_API_KEY; else process.env.VENICE_API_KEY = key; });

  await t.test("sends schema and conversation without requiring provider JSON mode", async (t) => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      assert.equal(body.response_format, undefined);
      assert.match(body.messages[0].content, /roommateId/);
      assert.equal(body.messages[1].content, "How long is Mike away?");
      assert.equal(JSON.parse(body.messages.at(-1).content).request, "A week, actually.");
      return Response.json({ choices: [{ message: { content: JSON.stringify(change) } }] });
    });
    const result = await runVeniceAgent({ message: "A week, actually.", group, history: [],
      conversation: [{ role: "assistant", content: "How long is Mike away?" }] });
    assert.deepEqual(result, change);
    assert.equal(group.roommates[0].share, "0.05");
  });

  await t.test("asks the model to repair invalid arithmetic before returning commands", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls++;
      if (calls === 2) assert.match(JSON.parse(options.body as string).messages.at(-1).content, /must equal/);
      const result = calls === 1 ? { ...change, commands: [{ type: "set_splits", splits: [
        { roommateId: "a", share: "0.06" }, { roommateId: "b", share: "0.03" }
      ] }] } : change;
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    });
    assert.deepEqual(await runVeniceAgent({ message: "Mike is away", group, history: [] }), change);
    assert.equal(calls, 2);
  });

  await t.test("fails closed after two malformed model replies", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: "not JSON" } }] }); });
    await assert.rejects(runVeniceAgent({ message: "Update rent", group, history: [] }), /Nothing was changed/);
    assert.equal(calls, 2);
  });

  await t.test("HTTP 400 is actionable and is not retried as a model response", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "Unsupported parameter" }, { status: 400 }); });
    await assert.rejects(runVeniceAgent({ message: "Update", group, history: [] }), (error: unknown) =>
      error instanceof VeniceError && /VENICE_MODEL/.test(error.message));
    assert.equal(calls, 1);
  });

  await t.test("clarifying questions return no changes", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: '  ```json\n{"message":"How long is Mike away?","commands":[]}\n```  ' } }] }));
    const result = await runVeniceAgent({ message: "Mike left", group, history: [] });
    assert.deepEqual(result.commands, []);
  });
});

test("extracts Venice string and nested error details", () => {
  assert.equal(veniceErrorDetail({ error: "Invalid model" }), "Invalid model");
  assert.equal(veniceErrorDetail({ error: { message: "Invalid parameter" } }), "Invalid parameter");
  assert.equal(veniceErrorDetail({ message: "Bad request" }), "Bad request");
});
