# Shopify Integration

This document describes how the agent authenticates to a Shopify store, which APIs it
uses, and how store data is mapped into the hub-and-spoke design in
[architecture.md](./architecture.md).

> **Status: token acquisition is implemented** in `src/server/shopify/`
> (`loadShopifyConfig` and `createShopifyTokenProvider`); the remaining spoke and write
> flows are still design only. No live credentials, tokens, or store secrets belong in
> this repository. The examples below use placeholders.

## 1. Configuration and secrets

The Shopify app credentials are supplied through environment variables and are only
ever read server-side:

| Variable | Purpose | Sensitive |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Store host, e.g. `example.myshopify.com` | No |
| `SHOPIFY_CLIENT_ID` | Shopify app client ID | Yes |
| `SHOPIFY_CLIENT_SECRET` | Shopify app client secret | Yes |
| `SHOPIFY_SCOPES` | Comma-separated Admin API scopes to request | No |
| `SHOPIFY_ACCESS_TOKEN` | Cached token (optional; normally obtained at runtime) | Yes |
| `SHOPIFY_API_VERSION` | Pinned Admin API version, e.g. `2025-01` | No |

Rules:

- Secrets are loaded once at startup into a server-only config object and are never
  logged, returned in responses, or sent to the browser.
- The repository's `.gitignore` already excludes `.env` and `.env.*`; add a
  `.env.example` with **empty placeholder names only** if a sample is needed.
- A missing or malformed credential must fail fast at startup with a clear message,
  not at first customer request.

## 2. Authentication: client ID + secret → access token

The agent uses the Shopify app credentials to obtain an Admin API access token. Which
flow applies depends on how the app is distributed:

### 2a. Client credentials grant (single store / custom app)

For a store-owned custom app acting on its own store, the app exchanges its client
ID and secret directly for an access token:

```text
POST https://{SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token
Content-Type: application/json

{
  "client_id": "{SHOPIFY_CLIENT_ID}",
  "client_secret": "{SHOPIFY_CLIENT_SECRET}",
  "grant_type": "client_credentials"
}
```

Response (illustrative):

```json
{ "access_token": "shpat_...", "scope": "read_orders,write_orders,...", "expires_in": 86399 }
```

### 2b. Authorization code grant (multi-store / public app)

For installing into other merchants' stores, the standard OAuth flow applies:

1. Redirect the merchant to
   `https://{shop}/admin/oauth/authorize?client_id=...&scope=...&redirect_uri=...`.
2. Shopify redirects back to the app with a `code` and `hmac`.
3. Verify the `hmac` signature (see Webhooks/HMAC below).
4. Exchange `code` for an access token at `/admin/oauth/access_token`
   (`grant_type=authorization_code`).
5. Store the token server-side, associated with the shop domain.

**Token lifecycle:** cache the token in memory (and/or the durable store), refresh
before expiry, and re-acquire on `401`. Tokens must not be persisted in logs, error
messages, or client-visible state.

## 3. API surface

All store access uses the Shopify **Admin GraphQL API**:

```text
POST https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json
X-Shopify-Access-Token: {access_token}
Content-Type: application/json
```

Representative operations per spoke:

| Spoke | Operation | Notes |
| --- | --- | --- |
| Customer | `customers(query:)` | Lookup by email/phone; return IDs only |
| Order | `order(id:)` / `orders(query:)` | Status, totals, line items, fulfillment, refunds |
| Product | `product(id:)` / `products(query:)` | Title, variants, images, prices |
| Pricing | `order(id:)` for money fields | Deterministic totals used for refund math |
| Refund | `refundCreate(...)` mutation | Real refund; requires idempotency |
| Order edit | `orderUpdate`, `orderEditBegin/Add/Commit`, `orderCancel` | Real mutations |

Shopify's API changes over time; the client pins `SHOPIFY_API_VERSION` and the plan
includes a scheduled review of the pinned version (see
[implementation-plan.md](./implementation-plan.md)).

## 4. Scopes (least privilege)

Request only what the spokes need. A plausible minimal set:

| Scope | Used by |
| --- | --- |
| `read_customers` | Customer lookup |
| `read_orders` | Order read, pricing |
| `write_orders` | Refund, order edit |
| `read_products` | Product read, pricing |
| `read_price_rules` (optional) | Pricing/discount explanation |

Do not request scopes that are not used. Scope errors should surface as a distinct,
actionable failure category.

## 5. Reliability

- **Retries:** retry idempotent reads with exponential backoff on 429/5xx. Do **not**
  blindly retry writes; use idempotency keys.
- **Rate limits:** the GraphQL Admin API is cost-based (a leaky bucket). The connector
  should track the query cost from responses and back off as the bucket depletes.
- **Throttling errors:** map `THROTTLED` responses to `retryable: true`.
- **Idempotency:** every write carries a deterministic key derived from
  `sessionId + action + targetId + amount`, so a network retry cannot double-refund.
- **Timeouts:** set explicit request timeouts; distinguish "definitely failed" from
  "unknown outcome" and re-query state before retrying a write.

## 6. Webhooks (recommended, later phase)

- Verify the `X-Shopify-Hmac-Sha256` header using `SHOPIFY_CLIENT_SECRET` before
  trusting any payload.
- Use `orders/updated`, `orders/cancelled`, and `refunds/create` to keep local state
  fresh and to detect changes made outside the agent.
- Process webhooks idempotently (dedupe by webhook ID).

## 7. Data mapping and privacy

- Map Shopify IDs (customer, order, product, variant, refund) to internal references
  and cite them in replies/audit records.
- Truncate PII to what the current task needs; never store full payment instrument
  details.
- Access tokens, client secret, and raw customer PII must never appear in logs. See
  [security.md](./security.md).

## 8. Local development without a live store

To develop safely, the connector is an interface with two implementations:

1. **`ShopifyLiveClient`** — real GraphQL calls (used in production).
2. **`ShopifyFixtureClient`** — returns recorded fixtures for deterministic tests.

Spokes depend on the interface, so the hub, routing, guardrails, and refund math can
be tested without touching a real store.
