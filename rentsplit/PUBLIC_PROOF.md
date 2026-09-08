# Kvara public proof

Route: `/proof`. Public read-only endpoint: `GET /api/public/proof`.
The landing header links to it as **Live proof**. Existing Vercel rewrites support direct navigation and refresh.

## Definitions

| Field | Definition |
| --- | --- |
| `households` | `SELECT count(*) FROM rent_groups`. Includes closed leases and testing; not an onchain or paying-customer count. |
| `payments` | Number of distinct `(transactionHash, logIndex)` native Base USDC Transfer events verified against confirmed ledger candidates. |
| `settledUsdc` | Sum of verified event values as bigint atoms, formatted at six USDC decimals; JSON string, no floating-point sums. |
| `payingWallets` | Distinct case-normalized Transfer senders in those verified events; not people, all registered wallets, or Base Dashboard Users. |
| `transactions` | Distinct Base transaction hashes containing those verified rent transfers; excludes profiles and executor deployment transactions. |

`loadProofSnapshot()` in `backend/src/store.ts` performs one SQL statement for a consistent snapshot. It selects the latest 1,000 `payment_records` with `payload->>'status' = 'confirmed'`, ordered by `updated_at DESC, id`, and joins `rent_groups` by `group_id` for the landlord. The internal projection is limited to hash, payer, amount and recipient. Names, apartment details, permissions and authentication records are not selected. Closed groups remain available for historical matching.

`buildProof()` in `backend/src/proof.ts` requires chain ID 8453 and a successful receipt at or below the finalized head. It checks the canonical block hash and matches a native USDC Transfer with the exact recorded sender, landlord and amount. A duplicate ledger row cannot inflate a physical transfer. Amounts must be positive and valid to at most six decimals. Missing hashes, missing/changed landlords, invalid records and unmatched/unfinalized transfers are excluded. An RPC failure fails the refresh instead of publishing an understated replacement snapshot.

This is a bounded ledger-backed verification window, **not a lifetime chain index**. The response exposes considered/total candidate counts and displays a coverage warning if more than 1,000 records exist. Previous databases, unrecorded transfers and profile events are not indexed. Real mainnet test payments count because there is no reliable production-versus-test flag; simulated, failed and pending records do not count. The page states these limitations explicitly.

## Public evidence and attribution

The recent table contains at most 12 verified transfer events: block timestamp (UTC), amount, confirmed status, transaction hash, log index and a Basescan URL constructed by the server. Two transfers can share one Base transaction.

The sole fixed public address is native Base USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. All displayed payment hashes come from verification, not sample constants. No executor key derivation or permission payload is needed by proof. No fake rent contract is introduced.

`BASE_BUILDER_CODE` is displayed only if the existing attribution helper considers it configured. Configuration does not attest that every historical transaction carries ERC-8021 attribution. No start date is invented, and no Base Dashboard numbers are scraped/imported. Legacy 1Shot attribution is not claimed. Profile/user totals and currently active permission totals are intentionally omitted: invitation records and stored grants cannot reliably establish them.

## Privacy and availability

- Endpoint is registered before authentication middleware but after existing CORS, Helmet and rate limiting. Other routes retain authentication.
- Response is an explicit allowlist: aggregates, verification coverage, block timestamps, public hashes/links, Builder configuration and USDC address. No names, tenant address list, apartment locations, JWTs, challenges, secrets, raw errors or permission credentials.
- Transaction links inherently expose already-public chain activity, including sender/recipient when opened on Basescan.
- Successful snapshots are cached for 60 seconds server-side, with a single refresh shared by concurrent requests and `Cache-Control: public, max-age=30`.
- Four verification workers, deduplicated RPC reads per refresh, a 20-second work budget plus in-flight RPC timeouts, and a 15-second failure cooldown bound refresh work. Larger deployments should replace request-time verification with a durable incremental index, not silently increase this window.
- Unavailable responses are HTTP 503 with `no-store`. Existing browser data is explicitly marked as the last successful update; a fresh failure shows no metrics. Empty successful results show honest zeros.

## Validation and deployment

Run from `rentsplit`: `npm test`, `npm run typecheck`, `npm run build`. No lint script is configured. Also run `git diff --check` from the repository root.

Tests cover exact fractional amounts, duplicate ledger records, shared transaction hashes, wrong token/recipient/value, unsuccessful receipts, finality/canonical checks, zero activity, RPC failure and the canonical store's privacy projection including closed groups. Local HTTP checks confirm public access to proof and continued 401 responses on private groups. Browser checks use explicit fixtures plus a real empty local endpoint; no fixture data is shipped.

A separate read-only smoke test verified the historical Base transaction `0x00c2b781c3df52d645af8b6d0afdfc33d0d7fd3fee4169fc3dafcff547d5a779` as one 0.15-USDC transfer. This is validation evidence only, not a seeded metric. Production PostgreSQL reconciliation was not performed: the local Railway CLI was unauthenticated. Do not treat the local zero-data server as production traction.

No new environment variables, migrations or dependencies. Existing `VITE_API_URL`, `BASE_RPC_URL`, `DATABASE_URL`, CORS and optional `BASE_BUILDER_CODE` are used. The raw HTML Base app verification tag is unchanged.

Deploy backend and frontend; do not deploy just Vercel:

1. Commit the proof files and push `main` (Vercel builds frontend).
2. In the repository root, use `railway login`, `railway link` (VIkions / upbeat-cat / production), `railway service enchanting-alignment`, `railway status`, then `railway up`. Keep the service Root Directory `/rentsplit` and Config File `/rentsplit/railway.json` for the existing root upload layout.
3. Verify `<Railway domain>/api/public/proof` without authentication. Compare values with the current DB and open the recent Basescan links. A new payment may need to finalize before appearing.
4. Open `https://kvara-theta.vercel.app/proof` directly, refresh and check the landing link. This is the link for the application.

No production deployment is performed by this implementation task.
