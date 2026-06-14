# Kvara

Autonomous rent payment agent for shared apartments. Roommates grant a bounded ERC-7715 permission once in MetaMask, then the backend household agent schedules delegated USDC transfers through the 1Shot relayer on Base.

## Stack

- Frontend: React + Vite + TypeScript + Tailwind CSS
- Web3: `@metamask/smart-accounts-kit`, Viem, Wagmi
- Backend: Node.js + Express
- Storage: Railway Postgres, with in-memory fallback for local demos
- AI: Venice OpenAI-compatible chat completions
- Relayer: 1Shot EIP-7710 JSON-RPC API
- Network: Base Mainnet, chain ID `8453`
- Token: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Frontend runs on `http://localhost:3000`. Backend runs on `http://localhost:3001`.

## Env

```bash
VENICE_API_KEY=...
AGENT_PRIVATE_KEY=...
VITE_AGENT_ADDRESS=...
DATABASE_URL=...
```

`DATABASE_URL` is optional locally. Without it, the backend uses memory storage; on Railway, attach Postgres and set `DATABASE_URL`.

## Flow

1. Admin creates an apartment with landlord, rent amount, due day, buffer, and roommate wallets.
2. Admin copies each invite link.
3. Roommate opens the invite link and grants an `erc20-token-periodic` permission in MetaMask.
4. Backend stores the group and schedules the household agent for the rent date.
5. The agent submits delegated rent collection through 1Shot:
   - `relayer_getCapabilities`
   - `relayer_getFeeData`
   - `relayer_estimate7710Transaction`
   - `relayer_send7710Transaction`
   - `relayer_getStatus`
6. Venice chat returns structured commands for split changes and history questions; commands are shown as pending until applied.

## Docs Followed

- MetaMask Advanced Permissions: https://docs.metamask.io/smart-accounts-kit/guides/advanced-permissions/execute-on-metamask-users-behalf/
- MetaMask supported permissions: https://docs.metamask.io/smart-accounts-kit/get-started/supported-advanced-permissions/
- 1Shot EIP-7710 quickstart: https://1shotapi.com/docs/quickstarts/gas-sponsorship-eip7710
- Venice overview: https://docs.venice.ai/overview/about-venice

## Notes

- Permissions delegate to the 1Shot relayer `targetAddress` returned from `relayer_getCapabilities`, which is required for redemption by the public relayer.
- The requested permission amount is rent share plus the apartment adjustment buffer and `VITE_RELAYER_FEE_BUFFER_USDC`, because the 1Shot bundle includes both the landlord USDC transfer and the relayer fee transfer.
- Browser localStorage is only a UI cache/fallback. Backend storage is the source of truth when `DATABASE_URL` is configured.
- `Run agent now` is a demo override. The product path is scheduled backend execution via the household agent.
