# Hono + React starter

A small TypeScript starter with one frontend page at `/`, a Hono API, and the pixel components from [retroui.io](https://retroui.io/) (`pixel-retroui`).

## Run locally

Use Node.js 22.12 or newer. `.nvmrc` selects Node.js 22.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite serves React on port 5173 and proxies `/api` to Hono on port 8787. Both servers restart or refresh when their source changes. Stop both with Ctrl+C.

The default page includes RetroUI `Card`, `Button`, and `Input` components. The system check loads the real Hono health response. The greeting form makes a real API request. The command button copies `npm run dev`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API and frontend together |
| `npm run typecheck` | Check frontend and backend TypeScript |
| `npm test` | Check API behavior and the single-page routing constraint |
| `npm run build` | Type-check and build the frontend and backend |
| `npm start` | Serve the production build and API from Hono on port 8787 |
| `npm run check` | Run tests and build |

For production, run `npm run build` before `npm start`. Open http://localhost:8787. Run commands from the repository root because static asset paths resolve from that directory.

Optional environment variables: `PORT` changes the API port (default `8787`); `HOST` changes the API bind address (default `127.0.0.1`). Set `HOST=0.0.0.0` when deploying to a container. Set `PORT` for `npm run dev` to update both the API and Vite's proxy target. The frontend port is 5173; Vite fails clearly if that port is already in use.

## Structure

```text
index.html                  The only frontend HTML entry
src/client/App.tsx          The only frontend page
src/client/ChatPanel.tsx    Chat history, composer and activity indicators
src/client/styles.css       Page layout and theme
src/server/app.ts           Hono routes and production static serving
src/server/index.ts         Node server entry
src/server/agent/           Chat agent: OpenRouter client, hooks, tools, SSE route
src/server/shopify/         Shopify connector: live reads, write proposals, and confirmed mutations
src/server/app.test.ts      API and routing tests
src/shared/contracts.ts     Shared API response types
src/shared/chat.ts          Shared chat and agent event types
vite.config.ts              React build and development API proxy
```

## API

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/health` | Status, service name, and server timestamp |
| GET | `/api/hello?name=Ada` | Personalized greeting from Hono |
| POST | `/api/chat` | Streams an agent turn as server-sent events |

The greeting name defaults to `builder`. Supplied names are trimmed and must contain 1–40 characters. Invalid names return HTTP 400 with an error message.

There is no frontend router and no additional frontend page. Vite's SPA fallback is disabled. In production, Hono serves `/` and `/assets/*`; unknown routes return HTTP 404 JSON. Add future API routes in `src/server/app.ts`.

## Chat interface

The single page includes an agent chat surface. It keeps the running conversation visible, lets you scroll the history, and shows live activity for the agent's **hooks**, **subagents** (spokes) and **tool calls** as they run. It calls `POST /api/chat`, which streams server-sent events (`hook`, `subagent`, `tool_call`, `assistant_message`, `error`).

Agent replies come from [OpenRouter](https://openrouter.ai/). Configure the key in the environment before starting the server:

```sh
OPENROUTER_API_KEY=... npm start
```

Optional environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter API key. Required for live replies. | unset |
| `OPENROUTER_MODEL` | Model slug to call | `openai/gpt-4o-mini` |
| `OPENROUTER_BASE_URL` | OpenRouter-compatible API base URL | `https://openrouter.ai/api/v1` |

When `OPENROUTER_API_KEY` is missing or the provider fails, the chat surface shows an explicit error instead of a fabricated reply, and `POST /api/chat` returns HTTP 400 for malformed requests. The key is read from the environment only and is never sent to the browser or written to logs.

No database, authentication, external service, or environment file is required. The only optional external dependencies are the OpenRouter key used by the chat interface and the Shopify credentials used by the connector.

## Shopify connector

The connector (`src/server/shopify/`) reads the Shopify app credentials from the server environment (or a `.env` file) and obtains an Admin API access token with the client credentials grant, caching it until shortly before it expires. Chat tools use the live GraphQL client for product searches, product details, verified customer and order lookups, and refund history. There is no sample-data fallback. Credentials are read server-side only and are never logged, returned in responses, or sent to the browser. See [`docs/shopify-integration.md`](docs/shopify-integration.md) for the full design.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Store host | `nate-ce.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Shopify app client ID (required) | unset |
| `SHOPIFY_CLIENT_SECRET` | Shopify app client secret (required) | unset |
| `SHOPIFY_SCOPES` | Comma-separated Admin API scopes | unset |
| `SHOPIFY_API_VERSION` | Pinned Admin API version | `2026-10` |
| `SHOPIFY_ACCESS_TOKEN` | Pre-provisioned token that skips acquisition | unset |

```ts
import { getShopifyAccessToken } from './src/server/shopify/index.js'

const accessToken = await getShopifyAccessToken()
```

A missing or malformed credential fails with an actionable error at the point the
connector is used; the rest of the app keeps running without Shopify configured.

Customer and order reads require an order number plus matching order email or phone.
Verification is isolated to each chat turn. Product queries need no customer details.
Product searches return at most 20 active products and 25 variants per product;
results flag truncated variant lists. Order details flag truncated line-item lists.
Refunds, shipping-address updates, and cancellations create a review card with the
exact action and order. Click **Confirm in Shopify** to execute. Refunds and
cancellations also require the store-operator approval checkbox. The model cannot
approve a write or supply an executable approval token. Captured payments are not
refunded by cancellation; request a separate refund when needed. Customer
notifications default to off and can be included in the proposal when requested.
Refunds are monetary refunds to original payment methods and do not restock items.
Address changes and cancellations require an unfulfilled order. Line-item quantity,
product, and discount edits are not included.

The server rechecks ownership, the order version, refundable funds, and payment
currency before execution. Refund allocations use exact decimal arithmetic and
Shopify's remaining gateway balances. A private SQLite journal at
`.data/shopify-actions.sqlite` preserves proposals, approvals, outcomes, and audit
records across restarts. Repeated confirmations reuse the recorded result. Unknown
outcomes block another change until Shopify confirms the outcome. Use **Check
Shopify status** instead of submitting another refund. Proposals expire after 15
minutes. Keep `.data/` on persistent storage; do not delete the journal to retry an
uncertain write.

This local app treats the person using its confirmation UI as the store operator.
It does not implement separate customer/staff accounts. Keep the default loopback
bind address unless an authenticated access layer is provided.

Shopify must grant this app protected customer data access, including order data
and name/address/email/phone fields, as well as the `read_orders`, `write_orders`,
and customer scopes. A valid token or successful product lookup does not prove
that the app can read orders. If Shopify returns `ACCESS_DENIED` for the `Order`
object, enable the data access in the app dashboard before testing order writes.
See [Shopify's protected customer data setup](https://shopify.dev/docs/apps/launch/protected-customer-data).

Assistant messages render Markdown, including lists, links, code blocks, and
GitHub-style tables. Raw HTML and remote images are disabled.

Optional settings: `SHOPIFY_ACTIONS_DB` changes the journal path;
`REFUND_WINDOW_DAYS` restricts refunds to orders inside that window.

The offline client lives under
`src/server/testing/` and is used only when tests explicitly inject it.

## Documentation

The `docs/` directory contains the design and plan for a hub-and-spoke customer
service agent that integrates with Shopify (order/customer/product lookups, pricing,
refunds, and order edits). Start at [`docs/README.md`](docs/README.md). The Shopify
token acquisition, live reads, and confirmed writes described in [`docs/shopify-integration.md`](docs/shopify-integration.md)
are implemented in `src/server/shopify/`. The remaining roadmap is documented separately.

## References

- [Hono](https://hono.dev/)
- [React](https://react.dev/)
- [RetroUI](https://retroui.io/) · [pixel-retroui source](https://github.com/Dksie09/RetroUI)
- [Vite](https://vite.dev/)
