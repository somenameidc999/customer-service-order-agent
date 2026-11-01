# Shopify Integration

This document describes how the agent authenticates to a Shopify store, which APIs it
uses, and how store data is mapped into the hub-and-spoke design in
[architecture.md](./architecture.md).

> **Status: live reads and confirmed writes are implemented.** The application
> uses `createShopifyLiveClient` for Shopify reads. Refunds, shipping-address updates,
> and cancellations produce server-owned proposals. Only the confirmation endpoint
> executes a stored proposal after explicit user confirmation. Refunds and
> cancellations also require store-operator approval. Tests inject the offline
> fixture client. All customer tools also enforce the per-turn authorization
> context before returning customer data. Line-item edits remain roadmap work. No live credentials or
> access tokens belong in this repository.

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
| `SHOPIFY_API_VERSION` | Pinned Admin API version, e.g. `2026-10` | No |

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

1. **`createShopifyLiveClient`** (`src/server/shopify/live-client.ts`) — real GraphQL
   reads. The application's tools use this client by default. Failed requests and
   empty searches never fall back to example data. HTTP 401 triggers one token
   refresh and retry; HTTP and GraphQL errors surface to the agent.
2. **`ShopifyFixtureClient`** (`src/server/testing/shopify-fixture.ts`) — returns
   recorded fixtures only when tests explicitly inject it. Application modules do
   not import this client.

The live client verifies an order number plus a matching order email or phone
before returning customer or order data. The agent creates a fresh client per
turn, so verification cannot leak across chats. Product searches are public and
bounded. Prices, currency and availability come directly from Shopify. Truncated
variant and line-item lists are marked in tool results.

Live monetary refunds use `refundCreate` with Shopify's required `@idempotent`
directive and server-generated action IDs. Amounts are validated against Shopify's
remaining refundable balance in the payment currency and allocated across original
payment transactions. A missing requested amount means the full remaining balance.
The review card is the authoritative human authorization for the server-computed
quote. Refunds do not restock inventory. Notifications are off unless requested.

Shipping-address changes use `orderUpdate`. Cancellations use `orderCancel`, restock
items, and do not refund captured payments. Both require an unfulfilled order. A
cancellation can release payment authorization holds. Cancellations report Shopify's
asynchronous job as processing until a status check confirms `cancelledAt`.
Refunds report gateway-pending states without claiming that payment succeeded.

`src/server/shopify/actions.ts` stores immutable action payloads, approvals, and
outcomes in a private SQLite journal. Session cookies bind proposals to one chat;
JSON confirmation requests reject cross-origin requests. Approvals expire after
15 minutes. Each execution rechecks the store, customer, order timestamp, and
remaining payment balance. A claim is persisted before any mutation, and uncertain
outcomes lock the order against duplicate writes. Read-only reconciliation uses
Shopify refund markers, address fields, or cancellation state. The journal must be
preserved across restarts. Audit records contain action IDs and states, without
contact information or credentials; the private proposal records contain shipping
addresses needed to execute the confirmed change.

The current app is local and treats its human UI user as the store operator.
Separate customer/staff authentication is required before exposing approval
controls to external customers. Every refund requires explicit operator approval,
including amounts below the future auto-approval threshold. Line-item edits and
fully automated refund policies remain roadmap work.

Queries use the pinned `2026-10` schema. See Shopify's
[product query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products),
[order fields](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order), and
[API versioning policy](https://shopify.dev/docs/api/usage/versioning).

Spokes depend on the interface, so the hub, routing, guardrails, and refund math can
be tested without touching a real store.
