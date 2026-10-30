# Architecture — Hub-and-Spoke Customer Service Agent

## Overview

The agent uses a **hub-and-spoke** (orchestrator/worker) architecture:

- The **hub** is the single coordinating agent. It understands the customer's
  request, plans the steps, decides which spoke handles each step, and assembles the
  final reply. The hub is the only component that talks to the customer and the only
  component that coordinates.
- The **spokes** are focused subagents. Each spoke owns one domain (customers, orders,
  products, pricing, refunds, edits) and exposes a small set of typed tools. Spokes
  never call other spokes; if a task spans domains, the hub sequences them.

This keeps each spoke small enough to test and reason about, while giving the hub one
place to enforce policy, budget, and safety rules.

```text
                          ┌────────────────────────────┐
             customer ───▶ │         HUB AGENT          │ ◀─── conversation state
             (chat)        │  plan · route · aggregate  │
                          │  guardrails · audit        │
                          └────────────┬───────────────┘
                                       │ typed hub↔spoke messages
        ┌───────────────┬──────────────┼───────────────┬───────────────┐
        ▼               ▼              ▼               ▼               ▼
 ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
 │  Customer  │  │   Order    │  │  Product   │  │  Pricing   │  │  Refund    │
 │  lookup    │  │   read     │  │   read     │  │   quote    │  │   write    │
 └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
       │               │               │               │               │
       └───────────────┴───────┬───────┴───────────────┴───────────────┘
                               ▼
                    ┌────────────────────┐        ┌──────────────────────┐
                    │  Shopify Connector │ ─────▶ │ Shopify Admin GraphQL│
                    │  token + retries   │        │ API (store)          │
                    └────────────────────┘        └──────────────────────┘
```

## Runtime components

| Component | Responsibility | Where it would live |
| --- | --- | --- |
| Chat/HTTP edge | Accepts customer messages, streams replies | Hono route, e.g. `src/server/agent/` (future) |
| Hub agent | Planning, routing, state, policy enforcement, audit | `src/server/agent/hub` (future) |
| Spoke agents | One domain each, expose typed tools | `src/server/agent/spokes/*` (future) |
| Shopify connector | Token acquisition/caching, GraphQL calls, retries, idempotency | `src/server/shopify/` (future) |
| Conversation store | Session state (short-term) and audit trail (long-term) | Pluggable; see below |
| Config/secret loader | Reads Shopify client ID/secret and unrelated settings from env | `src/server/config.ts` (future) |

> These paths are proposals. They follow the existing layout convention
> (`src/server`, `src/shared`) so the agent can reuse the starter's routing and
> typecheck/build tooling.

## Request flow (example: "I want a refund for order #1042")

1. **Ingress.** The customer message reaches the Hono agent route with a session ID.
2. **Hub plan.** The hub classifies intent (`refund_request`) and builds a plan:
   identify customer → load order → verify refund eligibility → compute amount →
   confirm with customer → execute refund → reply.
3. **Customer lookup.** Hub calls the customer spoke; it searches Shopify customers
   by the identifiers the customer supplied.
4. **Order read.** Hub calls the order spoke for the matched order's status, line
   items, and totals.
5. **Pricing.** If the amount is ambiguous, the hub asks the pricing spoke to resolve
   the refundable amount (paid amount, taxes, shipping, discounts).
6. **Authorization + policy check (hub).** This step has two halves with different
   scopes:
   - **Authorization (every request).** The hub authenticates the *conversation* to a
     customer before disclosing any order details: it requires an order number plus a
     matching email/phone and verifies that the order belongs to the identified
     customer. This half runs for read-only and write requests alike and is never
     skipped. See [security.md](./security.md).
   - **Refund policy (refunds only).** For a refund the hub applies the
     [security.md](./security.md) guardrails: threshold, eligibility window, prior
     refunds. If human approval is required, the hub pauses and requests it.
7. **Confirmation.** The hub summarizes the refund and asks the customer to confirm;
   the confirmation is recorded as structured state and passed to the write spoke as
   a `confirmationToken`.
8. **Refund write.** On confirmation, the hub calls the refund spoke, which calls the
   Shopify connector to create a real refund with an idempotency key.
9. **Reply + audit.** The hub replies with the refund result and appends an audit
   record.

Read-only requests (order status, product info, pricing) follow the same pattern and
**still run the authorization half of step 6**: the hub authenticates the conversation
(order number plus matching email/phone) and verifies order ownership before
disclosing order or PII data. They only skip the write-only steps: the refund-policy
half of step 6, confirmation (step 7), and the write call (step 8).

## Hub↔spoke contract

All hub↔spoke communication uses a single typed envelope so routing, logging, and
tests are uniform. Illustrative shape:

```ts
// src/shared/agent.ts (proposed)
export interface SpokeRequest<TInput> {
  requestId: string
  sessionId: string
  spoke: SpokeName
  action: string
  input: TInput
}

export type SpokeResult<TOutput> =
  | { ok: true; output: TOutput; evidence: string[] }
  | { ok: false; error: { code: SpokeErrorCode; message: string; retryable: boolean } }

export type SpokeName =
  | 'customer' | 'order' | 'product' | 'pricing' | 'refund' | 'orderEdit'
```

Rules:

- **Spokes are pure functions of their input plus the Shopify API.** They hold no
  conversation state.
- **Authorization is enforced for reads too.** The hub authenticates the conversation
  and verifies order ownership before any spoke returns order or PII data; spokes never
  treat a read as implicitly authorized.
- **Every write is idempotent.** Write spokes accept an `idempotencyKey` derived from
  `sessionId + action + targetId + amount`, carried in `SpokeRequest.input`.
- **Every write carries a confirmation token.** Write spokes reject any request whose
  `input.confirmationToken` is missing or does not match the hub's recorded structured
  confirmation state.
- **Evidence over assertions.** Read spokes return the raw identifiers/values they
  observed so the hub can cite them to the customer and to the audit log.
- **Failures are explicit.** Spokes return typed errors with `retryable` set; the hub
  decides whether to retry, ask the customer, or escalate.

## State and storage

- **Short-term conversation state** (current turn, plan, pending confirmations) can
  start in memory keyed by session ID for a prototype.
- **Durable state** (confirmed refunds, approvals, audit log) should use a small
  persistent store. Options, in order of setup cost:
  1. Append-only JSONL file for local development.
  2. SQLite for a single-instance deployment.
  3. Managed Postgres for multi-instance deployments.

The store choice is intentionally deferred; the hub depends only on a narrow
`ConversationStore` / `AuditLog` interface so it can be swapped.

## Why hub-and-spoke here

- **Testability.** Each spoke can be tested against recorded Shopify fixtures without
  the hub or an LLM.
- **Safety.** Mutating actions are isolated in dedicated spokes, so guardrails and
  approvals have a single choke point.
- **Least privilege.** A spoke only receives the tools it needs; the hub never hands a
  refund tool to an order-lookup path.
- **Evolvability.** New capabilities (returns, exchanges, subscriptions) become new
  spokes without changing existing ones.
