# Kvara Launch Checklist

The frontend stays on Vercel. Railway runs the API and rent scheduler, with a separate Postgres service. Do not put private keys or API secrets into Vercel's `VITE_` variables.

## Railway Service

Create the GitHub-backed service and use:

| Setting | Value |
| --- | --- |
| Root Directory | `/rentsplit` |
| Railway Config File | `/rentsplit/railway.json` |
| Build Command | `npm run build --workspace backend` |
| Start Command | `npm run start --workspace backend` |
| Healthcheck Path | `/api/health` |

The shared root includes the committed npm lockfile. The config file path is relative to the repository root, not the Root Directory. These settings follow Railway's [shared monorepo guide](https://docs.railway.com/deployments/monorepo). The older `backend/railway.json` is for an isolated `/rentsplit/backend` deployment; do not mix its commands with the shared-root configuration.

Add Postgres in the same Railway project and environment. In the **API service's** Variables, add `DATABASE_URL` as a reference to `${{Postgres.DATABASE_URL}}` (adjust `Postgres` if the service has another name). Keep `DATABASE_SSL=true` for Railway's standard SSL-enabled template. See [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).

Set these API variables, replacing the example frontend domain:

```dotenv
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=true
CORS_ORIGINS=https://your-kvara.vercel.app
AUTH_DOMAIN=your-kvara.vercel.app
AUTH_URI=https://your-kvara.vercel.app
AUTH_SESSION_SECRET=<at-least-32-random-characters>
PAYMENT_EXECUTION_MODE=aa
AGENT_PRIVATE_KEY=<existing-agent-private-key>
BUNDLER_RPC_URL=<your-Base-mainnet-bundler-endpoint>
AA_PAYMASTER_ENABLED=false
BASE_BUILDER_CODE=bc_p5fkvcvx
VENICE_API_KEY=<your-inference-key>
VENICE_MODEL=<your-tested-model-id>
SCHEDULER_ENABLED=false
```

Generate the session secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it private and stable across redeployments.

Keep the same agent key used in your successful local payment test: changing it changes the derived executor and invalidates existing executor-bound permissions. With no paymaster, the derived smart account needs Base ETH for UserOperation gas. The private-key owner and the derived account are different addresses; never infer one from the other. Profile transactions are sent by each user's own wallet and require its own small Base ETH balance.

Let Railway supply `PORT`. Generate an API domain targeting that port. Kvara's server already listens on all interfaces and reads `PORT`. Railway's [healthcheck](https://docs.railway.com/deployments/healthchecks) gates a new deployment, but is not continuous uptime monitoring.

## Connect Vercel

Set these frontend variables and redeploy Vercel (Vite embeds them at build time):

```dotenv
VITE_API_URL=https://your-api.up.railway.app
VITE_BASE_BUILDER_CODE=bc_p5fkvcvx
```

Do not append `/api` to `VITE_API_URL`. The client adds it. Keep the existing Base verification tag in `frontend/index.html`; it must also appear in the deployed page source.

## Verify Before Autopay

1. Open `https://your-api.up.railway.app/api/health`. Expect `ok: true`, `store: "postgres"`, `paymentExecutionMode: "aa"`, `builderAttribution: "configured"`, `executionConfigured: true`, and `schedulerEnabled: false`. This confirms configuration, not available gas or successful payment execution.
2. Open `/api/execution-config` and compare `executorAddress` with the tested local executor. Check its Base ETH balance without revealing the private key.
3. Sign in from the deployed frontend, create a small test lease, then disconnect and connect a different wallet. It must not inherit the first wallet's private household data.
4. A fresh wallet creates its profile on Base, then grants its rent permission. Check profile and payment transactions on Basescan. Base.dev metrics may update later; one wallet address is not proof of one distinct human.
5. Trigger a small test rent payment once. Wait for a confirmed status and verify the USDC recipient and amount on Basescan. Never clear an unknown submission just to retry it.
6. Redeploy the API and sign in again. The same lease and payment history must remain in Postgres. Configure database backups before collecting real customer rent.
7. Review all active leases and dates, then set `SCHEDULER_ENABLED=true` and redeploy. Keep the service always on, with one replica initially. Dates and times in the app are explicitly UTC. Due payments cannot execute while the process is stopped.

An empty new Postgres database will not contain your local test households. Do not run local and Railway schedulers against the same live permissions in separate databases: their duplicate-payment guards would not be shared. Stop the local scheduler before enabling the production one.

## Review Verification

The launch review uses deterministic unit/regression tests and isolated browser fixtures. Those fixtures do not send mainnet transactions, call paid Venice inference, or validate Railway's Postgres connection. The live checks above still need to be completed after deployment.
