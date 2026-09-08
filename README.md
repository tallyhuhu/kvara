# Kvara

Kvara is an autonomous recurring payment agent on Base. A user grants a bounded Base USDC permission once; Kvara then coordinates and executes rent payments without pooling funds or requiring a fresh wallet signature every month.

Shared household rent is the first product wedge. The same constrained recurring-payment architecture can later support utilities, subscriptions, team expenses, and invoices without broadening the current product prematurely.

## Why It Exists

Shared rent still depends on reminders, manual transfers, pooled wallets, or centralized recurring credentials. Kvara replaces that coordination with explicit onchain policy: one token, one spending cap, a 30-day period, an expiry, and a known delegated executor.

Base is the settlement rail rather than an optional network:

- native Base USDC settlement;
- low-cost recurring execution;
- smart-account and permission-based UX;
- public Basescan proof for every confirmed payment;
- ERC-8021 Builder attribution wherever Kvara controls final transaction calldata.

## Product Flow

1. Every new wallet creates a one-time `Resident`, `Landlord`, or combined profile on Base. The wallet sends this useful onchain action itself with Kvara's Builder Code, preserving per-wallet attribution.
2. The household admin signs in with a wallet and creates a home with landlord, residents, rent shares, and schedule.
3. Each resident opens an invite and grants a bounded `erc20-token-periodic` permission through MetaMask Smart Accounts Kit.
4. The Postgres-backed scheduler claims the monthly rent cycle and reserves one logical payment per resident.
5. Kvara redeems the permission through an attributed ERC-4337 UserOperation. Existing 1Shot-targeted permissions remain supported by the legacy adapter.
6. Payment state moves from preparing to submitted/pending and then confirmed or rejected; an unknown submission outcome is never retried automatically, and confirmed transactions link to Basescan.
7. Venice converts natural-language household changes into structured commands. The backend validates exact totals and authorization before applying them.

## Architecture

```text
React + Vite (Vercel)
  | attributed onchain profile + wallet signature session + ERC-7715 permission
  |-- KvaraProfileRegistry: wallet -> Resident / Landlord / Both
  v
Express API (Railway)
  |-- Postgres: households, challenges, cycles, payments, operation IDs
  |-- durable polling scheduler + cycle lease + payment idempotency
  |-- Venice structured command validation
  |-- attributed AA executor -> Base/CDP Bundler (+ optional Paymaster)
  |-- legacy adapter -> 1Shot EIP-7710 relayer
  v
Base Mainnet USDC -> landlord
```

The browser is not the source of truth. Household configuration, permissions, schedules, payment attempts, events, and operation IDs are stored server-side. API ownership is derived from a signed wallet session, never from a wallet address supplied in request JSON.

## Money Safety

- No pooled Kvara wallet and no custody of resident USDC.
- Payment uniqueness is enforced by `group + roommate + billing period`.
- A deterministic logical payment ID prevents duplicate payment creation; submitted 1Shot task IDs and AA UserOperation hashes are persisted for reconciliation.
- Postgres rent-cycle leases prevent concurrent workers from starting the same cycle.
- Submitted tasks are reconciled after restarts instead of being replaced.
- Landlord and wallet snapshots are checked against the permission before payment.
- Closing a lease disables Kvara automation but does **not** claim to revoke the MetaMask permission onchain. The user must remove that permission in MetaMask.
- Production refuses to boot without Postgres and a strong session secret.

## Base Builder Code / ERC-8021

Set the real Base.dev code in both environments:

```bash
VITE_BASE_BUILDER_CODE=your-real-code
BASE_BUILDER_CODE=your-real-code
```

Kvara uses `ox/erc8021` `Attribution.toDataSuffix` through centralized frontend/backend helpers. The frontend defaults to Kvara's registered code; an explicitly empty or malformed value blocks profile submission rather than creating an unattributed profile. The backend reports missing attribution in its health response, so configure its code explicitly. Viem wallet and Bundler clients are configured at client level when a valid code exists.

**Per-wallet attribution:** after connecting, each wallet calls `setProfile` on `KvaraProfileRegistry` in its own Base transaction. Kvara appends the Builder Code directly to that contract calldata, waits for confirmation, reads the saved role back onchain, and exposes the Basescan proof in chat. Autonomous rent still uses the shared executor, while onboarding now attributes every actual wallet separately.

Profile registry on Base Mainnet: [`0x49ab431ebeca10baa558c8513fcaa69d2827e070`](https://basescan.org/address/0x49ab431ebeca10baa558c8513fcaa69d2827e070)

**Exact autonomous payment status:** a rent payment executed in `PAYMENT_EXECUTION_MODE=aa` carries Kvara's Builder Code in the UserOperation calldata when `BASE_BUILDER_CODE` is valid. This is the primary path for new permissions and is compatible with Base.dev's current AA transaction analytics. The documented 1Shot request schema still does not expose outer `dataSuffix` customization, so legacy 1Shot payments are not claimed as attributed. Kvara never appends bytes to ERC20 inner calldata, permission contexts, delegation hashes, or signed permission data.

Permissions are executor-bound. After switching from `one-shot` to `aa`, residents must grant a new permission to the Kvara smart session account; an existing permission targeting 1Shot cannot be silently migrated.

## Base Mainnet Proof

Profile registry deployment with Builder attribution:

https://basescan.org/tx/0xfc97a5e25440ad0071390cfb6e0b2698039538b37496e6a37752348650a3e009

Confirmed autonomous delegated rent payment with Builder attribution:

https://basescan.org/tx/0x00c2b781c3df52d645af8b6d0afdfc33d0d7fd3fee4169fc3dafcff547d5a779

This repository does not fabricate transaction volume, users, or settlement metrics.

## Configuration

Copy [`rentsplit/.env.example`](rentsplit/.env.example). Frontend variables are public and prefixed with `VITE_`; backend secrets must exist only on Railway.

Required production values:

```bash
# Vercel
VITE_API_URL=https://your-api.up.railway.app
VITE_BASE_BUILDER_CODE=...

# Railway
NODE_ENV=production
DATABASE_URL=postgresql://...
CORS_ORIGINS=https://your-kvara-domain.example
AUTH_DOMAIN=your-kvara-domain.example
AUTH_URI=https://your-kvara-domain.example
AUTH_SESSION_SECRET=<at-least-32-random-characters>
VENICE_API_KEY=...
BASE_BUILDER_CODE=...
PAYMENT_EXECUTION_MODE=aa
AGENT_PRIVATE_KEY=0x...
BUNDLER_RPC_URL=https://api.developer.coinbase.com/rpc/v1/base/...
AA_PAYMASTER_ENABLED=false
SCHEDULER_ENABLED=false
```

The backend derives the public Kvara smart-account address from `AGENT_PRIVATE_KEY` and serves it from `/api/execution-config`; it is never copied into a public frontend secret. With `AA_PAYMASTER_ENABLED=false`, fund that derived smart account with enough Base ETH for gas. With `true`, the configured CDP endpoint is also used as the Paymaster and its sponsorship policy must allow the redemption calls. `RELAYER_DELEGATION_SECRET` remains optional and server-only for the 1Shot fallback.

## Development

```bash
cd rentsplit
npm install
npm run dev
```

Frontend: `http://localhost:3000`
Backend: `http://localhost:3001`

Verification:

```bash
npm test
npm run typecheck
npm run build
npm run compile:profile
```

Tests are deterministic and do not call Base Mainnet or spend funds.

## Deployment

Use the exact service settings and first-launch checks in [DEPLOYMENT.md](rentsplit/DEPLOYMENT.md).

1. Deploy `rentsplit/frontend` to Vercel and set the public variables above.
2. Deploy the backend with Railway Root Directory `/rentsplit` and Config File `/rentsplit/railway.json`. This retains the shared lockfile and builds only the backend workspace. Attach Postgres and set backend variables.
3. First boot with `SCHEDULER_ENABLED=false`; review existing active households and their due dates before allowing autonomous execution.
4. Redeploy the backend after adding auth variables; startup creates additive tables/indexes automatically.
5. Confirm `/api/health`, wallet sign-in, an invite, permission display, and the derived AA executor address. Then set `SCHEDULER_ENABLED=true` on the worker-capable API service. Multiple instances are protected by Postgres leases and payment uniqueness.
6. Connect a fresh wallet and create its Base profile. Verify the profile transaction and the new unique user in Base.dev; portal analytics can lag behind the block explorer.
7. Grant a fresh `aa` permission, run one real payment, wait for confirmation, and verify the final UserOperation suffix and payment link.

An always-on process is needed for exact-time execution. If hosting suspends the service, persisted due groups are recovered on wake, but payment cannot run while no process is executing.

## Current Status

Shipped: attributed per-wallet Base profiles, Base Mainnet USDC permission flow, attributed AA redemption, legacy 1Shot redemption, signed wallet sessions, household roles, durable schedules, duplicate-payment protection, persisted operation reconciliation, validated Venice changes, transaction proof, and Base app verification metadata.

Not shipped: wallet-native onchain revocation from Kvara, 1Shot outer-transaction Builder attribution, external alerting, and production load/chaos testing.

## Primary References

- [Base Builder Codes](https://docs.base.org/base-chain/builder-codes/overview)
- [MetaMask Advanced Permissions](https://docs.metamask.io/smart-accounts-kit/guides/advanced-permissions/execute-on-metamask-users-behalf/)
- [1Shot EIP-7710 gas sponsorship](https://1shotapi.com/docs/quickstarts/gas-sponsorship-eip7710)
- [CDP Bundler and Paymaster](https://docs.cdp.coinbase.com/paymaster/guides/quickstart)
- [Venice API](https://docs.venice.ai/overview/about-venice)
