import { randomBytes, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { verifyMessage } from "viem";
import { BASE_CHAIN_ID, config } from "./config.js";
import { normalizeWalletAddress } from "./domain.js";
import { consumeAuthChallenge, getAuthChallenge, saveAuthChallenge } from "./store.js";
import type { AuthChallenge } from "./types.js";

export type AuthSession = {
  walletAddress: `0x${string}`;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthSession;
    }
  }
}

const sessionKey = new TextEncoder().encode(config.authSessionSecret);

export async function issueAuthChallenge(rawAddress: string): Promise<AuthChallenge> {
  const walletAddress = normalizeWalletAddress(rawAddress);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.authChallengeTtlSeconds * 1_000);
  const nonce = randomBytes(16).toString("hex");
  const challenge: AuthChallenge = {
    id: randomUUID(),
    walletAddress,
    message: buildSignInMessage(walletAddress, nonce, now, expiresAt),
    expiresAt: expiresAt.toISOString()
  };
  await saveAuthChallenge(challenge);
  return challenge;
}

export async function verifyAuthChallenge(input: {
  challengeId: string;
  walletAddress: string;
  message: string;
  signature: `0x${string}`;
}): Promise<{ token: string; expiresAt: string; walletAddress: `0x${string}` }> {
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const challenge = await getAuthChallenge(input.challengeId);
  if (!challenge || challenge.consumedAt) throw new AuthError("Sign-in challenge is invalid or already used.");
  if (Date.parse(challenge.expiresAt) <= Date.now()) throw new AuthError("Sign-in challenge expired.");
  if (challenge.walletAddress.toLowerCase() !== walletAddress.toLowerCase() || challenge.message !== input.message) {
    throw new AuthError("Sign-in challenge does not match this wallet.");
  }

  const valid = await verifyMessage({ address: walletAddress, message: challenge.message, signature: input.signature });
  if (!valid) throw new AuthError("Wallet signature is invalid.");
  if (!(await consumeAuthChallenge(challenge.id))) throw new AuthError("Sign-in challenge was already used.");

  const expiresAt = new Date(Date.now() + config.authSessionTtlSeconds * 1_000);
  const token = await new SignJWT({ chainId: BASE_CHAIN_ID })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(walletAddress.toLowerCase())
    .setIssuer("kvara-api")
    .setAudience("kvara-web")
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
    .sign(sessionKey);

  return { token, expiresAt: expiresAt.toISOString(), walletAddress };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const value = req.get("authorization");
  if (!value?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Wallet authentication required." });
    return;
  }

  try {
    const token = value.slice("Bearer ".length).trim();
    const { payload } = await jwtVerify(token, sessionKey, { issuer: "kvara-api", audience: "kvara-web" });
    if (typeof payload.sub !== "string") throw new Error("Missing wallet subject.");
    req.auth = { walletAddress: normalizeWalletAddress(payload.sub) };
    next();
  } catch {
    res.status(401).json({ error: "Wallet session expired. Sign in again." });
  }
}

export function authenticatedWallet(req: Request): `0x${string}` {
  if (!req.auth) throw new AuthError("Wallet authentication required.");
  return req.auth.walletAddress;
}

export class AuthError extends Error {}

function buildSignInMessage(
  walletAddress: `0x${string}`,
  nonce: string,
  issuedAt: Date,
  expiresAt: Date
): string {
  return `${config.authDomain} wants you to sign in with your Ethereum account:
${walletAddress}

Sign in to Kvara. This signature does not authorize a transaction or allow Kvara to spend funds.

URI: ${config.authUri}
Version: 1
Chain ID: ${BASE_CHAIN_ID}
Nonce: ${nonce}
Issued At: ${issuedAt.toISOString()}
Expiration Time: ${expiresAt.toISOString()}`;
}
