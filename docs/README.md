# Customer Service Agent — Documentation

This directory holds the design and plan documents for a **hub-and-spoke customer
service agent** that answers order questions and performs real Shopify actions
(lookups, pricing, product reads, order edits, and refunds).

These documents are the deliverable for issue #1 ("Documentation"). They describe
*how the agent would be implemented*; they intentionally do **not** change the
existing Hono + React starter application. The starter (`/` page, `/api/health`,
`/api/hello`) continues to work unchanged while this design is reviewed.

## Reading order

| Document | Purpose |
| --- | --- |
| [architecture.md](./architecture.md) | The hub-and-spoke architecture, runtime components, and request/data flow |
| [agents.md](./agents.md) | Hub and spoke (subagent) catalog: responsibilities, tools, contracts, escalation |
| [shopify-integration.md](./shopify-integration.md) | Shopify authentication (client ID/secret → access token), API usage, scopes, rate limits |
| [security.md](./security.md) | Secret handling, PII, refund authorization guardrails, audit logging, compliance |
| [implementation-plan.md](./implementation-plan.md) | Phased build plan, work breakdown, dependencies, risks, testing strategy, definition of done |

## Scope of issue #1

In scope:

- Documentation for a hub-and-spoke customer service agent.
- A plan for implementing it incrementally on top of this repository's stack.

Out of scope (future issues):

- Production code for the agent, Shopify connector, or LLM provider calls.
- Any change to the current single-page UI, API contracts, or verification inputs.
- Deployment, credential provisioning, or connecting to a live Shopify store.

## Key capabilities the agent must provide

1. **Order information** — tell the customer about an order (status, totals, line items, fulfillment).
2. **Customer lookup** — find a customer by email, phone, or order reference.
3. **Pricing information** — quote current prices, discounts, and refundable amounts.
4. **Shopify connectivity** — authenticate to a Shopify store with an app client ID/secret to obtain an access token.
5. **Refunds** — create real refunds against real orders.
6. **Product information** — read products and relay them to the customer.
7. **Order edits** — modify an order (for example shipping address, line items, cancellation).

## Design principles

- **One hub, narrow spokes.** The hub owns conversation state, planning, and routing.
  Spokes are small, single-purpose workers that each wrap a bounded set of Shopify or
  domain tools. No spoke coordinates another spoke.
- **Server-side only.** Shopify credentials and all store mutations live behind the
  Hono server; nothing secret reaches the browser.
- **Least privilege.** Request only the Shopify scopes actually needed, and constrain
  spokes to the actions they are allowed to take.
- **Safe by default.** Refunds and order edits require validation, confirmation, and
  (above a threshold) human approval, described in [security.md](./security.md).
- **Typed contracts.** Hub↔spoke messages and Shopify payloads use explicit TypeScript
  types so behavior is testable without a live store.
