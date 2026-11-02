# Agents — Hub and Spokes

This document defines what the hub and each spoke are responsible for, the tools they
expose, and the rules for coordinating them. Contracts are described in
[architecture.md](./architecture.md).

## Hub agent (the "main agent")

The hub is the only coordinator. It does not call Shopify directly; it plans and
delegates.

**Responsibilities**

- Maintain conversation state and the current task plan.
- Classify intent (order status, product question, pricing, refund, order edit,
  general help) and choose a plan.
- Select the correct spoke(s) and sequence them when a task spans domains.
- Enforce guardrails (see [security.md](./security.md)): authorization, refund
  thresholds, confirmation, idempotency, and human-approval checkpoints.
- Resolve ambiguity by asking the customer for missing identifiers (email, order
  number) before acting.
- Aggregate spoke results into a single, cited reply.
- Write an audit record for every read that touches PII and every write.
- Escalate to a human when a policy blocks automation or a spoke fails unrecoverably.

**Explicitly not the hub's job**

- Direct Shopify API calls.
- Long-lived domain logic (that belongs to the relevant spoke).
- Calling one spoke from another spoke.

**Hub decision loop (per turn)**

1. Parse the customer message + session history.
2. Produce or update a plan (ordered steps with target spokes).
3. Execute steps, calling spokes with typed requests.
4. On spoke error: retry if `retryable` and within budget, else ask the customer or
   escalate.
5. Before any read that discloses order or PII data: authenticate the conversation
   (order number plus matching email/phone) and verify the order belongs to the
   identified customer. Reads are never treated as implicitly authorized.
6. Before any write: verify guardrails, obtain customer confirmation, and pass the
   resulting `confirmationToken` together with a deterministic `idempotencyKey` in the
   write spoke's `SpokeRequest.input`.
7. Compose the reply with evidence and update the audit log.

## Spokes (subagents)

Each spoke is a single-domain worker with a narrow tool set. All spokes share the
envelope in [architecture.md](./architecture.md) and the principles below:

- No conversation state.
- Idempotent writes.
- Return observed evidence.
- Return typed, classified errors.

### 1. Customer lookup spoke

- **Purpose:** Resolve "who is this customer?" without exposing unnecessary PII.
- **Tools:**
  - `findCustomer({ orderNumber, email?, phone? })` → the customer whose order matches
    `orderNumber` and at least one matching email/phone, with the customer ID.
  - `getCustomer({ customerId })` → profile fields needed for service.
- **Reads:** `read_customers`.
- **Guardrails:** require the two-factor rule from [security.md](./security.md) — an
  order number plus a matching email/phone; verify the order belongs to the identified
  customer before any order details are disclosed or any write happens; minimize
  returned PII; never return full payment details.

### 2. Order read spoke

- **Purpose:** Answer questions about an order.
- **Tools:**
  - `getOrder({ orderId })` / `getOrderByNumber({ orderNumber })` → status, totals,
    currency, line items, fulfillment, refund history.
  - `listCustomerOrders({ customerId, limit })` → recent orders.
- **Reads:** `read_orders`.
- **Returns:** order status, financial status, fulfillment status, and a stable order
  reference for citing to the customer.

### 3. Product read spoke

- **Purpose:** Relay product information to the customer.
- **Tools:**
  - `getProduct({ productId })` → title, description, variants, images.
  - `searchProducts({ query, limit })` → matching products.
- **Reads:** `read_products`.
- **Guardrails:** relay only published/sellable data; do not invent stock levels.

### 4. Pricing spoke

- **Purpose:** Provide pricing and compute refundable amounts deterministically.
- **Tools:**
  - `getVariantPrice({ variantId, quantity })` → unit and extended price.
  - `quoteOrder({ orderId })` → subtotal, discounts, shipping, tax, total paid.
  - `computeRefundable({ orderId, lineItemIds?, reason? })` → maximum refundable amount
    and its components.
- **Reads:** `read_products`, `read_orders`, optionally `read_price_rules`.
- **Guardrails:** pricing math lives server-side and is unit-tested; the hub never
  computes amounts from model output alone.

### 5. Refund spoke (write)

- **Purpose:** Create real refunds against real orders.
- **Tools:**
  - `createRefund({ orderId, amount, currency, reason, idempotencyKey, confirmationToken })`
    → refund result with Shopify refund ID.
- **Reads/writes:** `read_orders`, `write_orders` (refund mutations).
- **Guardrails:**
  - Must receive a confirmation token (`confirmationToken`) from the hub that matches
    the hub's recorded structured confirmation state, and a deterministic
    `idempotencyKey`; it rejects any request missing either one.
  - Must receive an explicit customer confirmation captured by the hub.
  - Amount must not exceed `computeRefundable` from the pricing spoke.
  - Honors the auto-refund threshold and human-approval rule in
    [security.md](./security.md). A pre-tool-use hook blocks a refund above
    `REFUND_AUTO_APPROVE_MAX` before this spoke runs and escalates it to human
    support for review instead.
  - Uses an idempotency key so retries cannot double-refund.

### 6. Order edit spoke (write)

- **Purpose:** Modify an existing order.
- **Tools:** every edit takes an `idempotencyKey` and a `confirmationToken`:
  - `updateShippingAddress({ orderId, address, idempotencyKey, confirmationToken })`
  - `addLineItem({ orderId, variantId, quantity, idempotencyKey, confirmationToken })`
  - `removeLineItem({ orderId, lineItemId, idempotencyKey, confirmationToken })`
  - `cancelOrder({ orderId, reason, idempotencyKey, confirmationToken })`
- **Reads/writes:** `read_orders`, `write_orders`.
- **Guardrails:** each edit rejects requests without a valid `confirmationToken` and a
  deterministic `idempotencyKey`, and is validated against order state (for example,
  cannot edit a fully refunded order); destructive edits (cancel order, remove line
  items) always require human approval.

## Routing summary

| Customer intent | Plan (spoke sequence) |
| --- | --- |
| "Where is my order?" | customer → order |
| "What did I buy / what's in it?" | order → product |
| "How much was X / what would a refund be?" | order → pricing |
| "I want a refund" | customer → order → pricing → refund (with confirmation/approval) |
| "Change my shipping address" | customer → order → orderEdit (with confirmation) |
| "Cancel my order" | customer → order → orderEdit (cancel, human approval) |
| "Tell me about product Y" | product |

## Extensibility

New spokes (returns, exchanges, subscriptions, discounts) follow the same template:
one domain, narrow typed tools, idempotent writes, evidence in results. The hub adds a
routing rule and a plan template; no existing spoke changes.
