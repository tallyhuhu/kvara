import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueAuthChallenge, verifyAuthChallenge } from "./auth.js";

test("creates a wallet-bound session and consumes its challenge once", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await issueAuthChallenge(account.address);
  const signature = await account.signMessage({ message: challenge.message });
  const session = await verifyAuthChallenge({
    challengeId: challenge.id,
    walletAddress: account.address,
    message: challenge.message,
    signature
  });
  assert.equal(session.walletAddress.toLowerCase(), account.address.toLowerCase());
  assert.ok(session.token.length > 20);
  await assert.rejects(() => verifyAuthChallenge({
    challengeId: challenge.id,
    walletAddress: account.address,
    message: challenge.message,
    signature
  }), /already used/);
});

test("rejects a signature from a different wallet", async () => {
  const intended = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const challenge = await issueAuthChallenge(intended.address);
  const signature = await attacker.signMessage({ message: challenge.message });
  await assert.rejects(() => verifyAuthChallenge({
    challengeId: challenge.id,
    walletAddress: intended.address,
    message: challenge.message,
    signature
  }), /invalid/);
});

test("rejects a modified message so domain, URI, nonce, and expiry stay bound to the challenge", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await issueAuthChallenge(account.address);
  const modifiedMessage = challenge.message.replace("Sign in to Kvara.", "Sign in somewhere else.");
  const signature = await account.signMessage({ message: modifiedMessage });
  await assert.rejects(() => verifyAuthChallenge({
    challengeId: challenge.id,
    walletAddress: account.address,
    message: modifiedMessage,
    signature
  }), /does not match/);
});
