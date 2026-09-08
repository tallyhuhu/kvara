import assert from "node:assert/strict";
import test from "node:test";
import { authenticateWallet, authorizedRequest, clearWalletSession } from "./lib/api.js";

const alice = "0x0000000000000000000000000000000000000001";
const bob = "0x0000000000000000000000000000000000000002";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("a delayed old-wallet 401 cannot clear the new wallet session or return its data", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  } });
  for (const wallet of [alice, bob]) storage.set(`kvara.wallet.session.${wallet}`, JSON.stringify({ token: wallet, walletAddress: wallet, expiresAt: "2099-01-01" }));
  let finish!: (value: Response) => void;
  try {
    clearWalletSession();
    await authenticateWallet(alice, { request: async () => "0x01" });
    globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
    const oldRequest = authorizedRequest("/api/groups");
    await authenticateWallet(bob, { request: async () => "0x02" });
    finish(response({ error: "expired" }, 401));
    await assert.rejects(oldRequest, /previous session/);
    globalThis.fetch = async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${bob}`);
      return response({ groups: [] });
    };
    assert.deepEqual(await authorizedRequest("/api/groups"), { groups: [] });
  } finally {
    globalThis.fetch = originalFetch;
    clearWalletSession();
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
