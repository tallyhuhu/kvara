# Kvara

Kvara is an autonomous rent desk for shared apartments. Roommates grant a bounded MetaMask Advanced Permission once, and Kvara can later collect each share in Base USDC and pay the landlord without asking everyone to sign again.

The demo focuses on a real household scenario: create an apartment, invite roommates, grant capped permissions, run rent day through 1Shot, verify the Base transaction on Basescan, then ask Venice to adapt the rent split when a roommate is away.

## Live Demo Flow

1. Open the landing page and enter the Kvara rent desk.
2. Create an apartment with landlord wallet, monthly rent, rent day, and roommate wallets.
3. Grant a bounded MetaMask Advanced Permission for the connected resident.
4. Run the demo rent day.
5. Kvara submits the delegated USDC payment through 1Shot and shows the Basescan transaction link in chat.
6. Ask Venice for a natural-language rent change, for example: "Mike is away for one week."
7. Venice interprets the intent and Kvara updates this month's rent split autonomously.

Verified Base execution from the demo:

https://basescan.org/tx/0x56add80d8932718a3611980e5c5a450e89db6542473328ef8371d7a843a84e05

## Working Integrations

- **MetaMask Smart Accounts Kit**: Kvara uses `@metamask/smart-accounts-kit` and `wallet_requestExecutionPermissions` to request ERC-7715 Advanced Permissions from production MetaMask. The rent permission is scoped to Base USDC, a 30-day period, and a capped amount that includes the roommate share plus a small fee and adjustment buffer.
- **1Shot Permissionless Relayer**: The backend calls the 1Shot EIP-7710 JSON-RPC flow: `relayer_getCapabilities`, `relayer_getFeeData`, `relayer_estimate7710Transaction`, `relayer_send7710Transaction`, and `relayer_getStatus`. Successful executions return task IDs, transaction hashes, and Basescan links.
- **Venice AI**: The backend uses Venice's OpenAI-compatible chat completions endpoint to parse natural-language household changes into structured rent commands. Venice can recalculate temporary absences, explain payment history, and update the active split.
- **Base Mainnet**: Payments run on Base Mainnet (`chainId: 8453`) using native Base USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- **Railway Postgres**: Apartment state, permissions, events, and payment records are stored server-side with Railway Postgres. The browser is only a UI client/cache.
- **Vercel + Railway**: The frontend is deployed separately from the backend. Vercel serves the React app, while Railway runs the Express agent and Postgres-backed storage.

## Product Idea

Roommates do not need to remember rent day or coordinate repeated signatures. They approve a bounded, revocable permission once. After that, Kvara acts like a household agent:

- collects only within the approved USDC limit;
- adapts this month's split when plans change;
- pays the landlord through delegated execution;
- records transaction status and Basescan proof;
- keeps the user experience as a simple chat and apartment summary.

This makes the demo useful for real shared apartments, not just a wallet transaction showcase.

## Architecture

```text
rentsplit/
  frontend/      React + Vite + TypeScript + Tailwind
  backend/       Node.js + Express agent
```

Frontend responsibilities:

- apartment creation and invite links;
- MetaMask connection;
- ERC-7715 permission request through Smart Accounts Kit;
- chat-first dashboard;
- payment status and Basescan links.

Backend responsibilities:

- group and payment persistence;
- Venice intent parsing;
- scheduled and manual rent execution;
- 1Shot fee quoting, submission, and status polling.

## Environment

```bash
VITE_API_URL=https://your-railway-backend.up.railway.app
VITE_AGENT_ADDRESS=0x...
VITE_RELAYER_URL=https://relayer.1shotapi.com/relayers
VITE_RELAYER_FEE_BUFFER_USDC=0.05

DATABASE_URL=postgresql://...
VENICE_API_KEY=...
VENICE_MODEL=llama-3.3-70b
VENICE_BASE_URL=https://api.venice.ai/api/v1
RELAYER_URL=https://relayer.1shotapi.com/relayers
RELAYER_FEE_BUFFER_USDC=0.05
```

## Local Development

```bash
cd rentsplit
npm install
npm run dev
```

Frontend: `http://localhost:3000`

Backend: `http://localhost:3001`

## Notes For Judges

- Kvara does not deploy a custom rent contract. The core qualification path is MetaMask Advanced Permissions plus delegated execution through 1Shot.
- The user grants an `erc20-token-periodic` permission for Base USDC. The period is 30 days and the allowance is intentionally bounded.
- 1Shot is used for the demo payment path and returns a real Base transaction hash.
- Venice is not a decorative chat widget. It produces structured commands that update rent state.
- The UI avoids a generic SaaS dashboard and presents the app as a real estate/rental experience with a chat-based rent agent.

## Official Docs Used

- MetaMask Advanced Permissions: https://docs.metamask.io/smart-accounts-kit/guides/advanced-permissions/execute-on-metamask-users-behalf/
- MetaMask supported permissions: https://docs.metamask.io/smart-accounts-kit/get-started/supported-advanced-permissions/
- 1Shot EIP-7710 quickstart: https://1shotapi.com/docs/quickstarts/gas-sponsorship-eip7710
- Venice overview: https://docs.venice.ai/overview/about-venice
