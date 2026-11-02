# Security, Privacy, and Safety Guardrails

Because the agent can read customer data and perform real, irreversible Shopify
actions (refunds, order edits, cancellations), safety is a first-class part of the
design, not an add-on. This document defines the rules the hub and spokes must
enforce.

## 1. Secret handling

- `SHOPIFY_CLIENT_SECRET` and any access token are **server-only**. They never reach
  the browser, the conversation transcript, or logs.
- Load secrets from environment variables at startup; fail fast if required values are
  missing or malformed. Never hardcode credentials in source, docs, or tests.
- `.env` and `.env.*` are already git-ignored. Provide at most a `.env.example` with
  empty placeholder names.
- Redact secrets and tokens from error messages and telemetry. Add a redaction test
  that asserts a token value never appears in serialized logs.

## 2. Customer privacy (PII)

- Collect the minimum data needed for the current task; do not echo full customer
  records when a reference (order number, last-4, status) is sufficient.
- Never store or display full payment instrument data.
- Log audit records with internal IDs and action outcomes, not raw PII payloads.
- Honor data-subject requests: support locating and deleting a customer's stored
  conversation/audit data (Shopify provides `customers/data_request` and
  `customers/redact` compliance webhooks for apps).

## 3. Authorization

- The agent must authenticate the *conversation* to a customer before disclosing order
  details or performing writes. At minimum, require a strong identifier (order number
  plus matching email/phone) and never disclose another customer's data.
- Verify that the order being modified belongs to the identified customer before any
  write.
- Never let model output decide authorization; authorization is deterministic,
  server-side logic.

## 4. Confirmation before writes

Every mutating action follows: **propose → confirm → execute**.

- The hub summarizes the exact change (order, amount, currency, line items, reason)
  and asks the customer to confirm explicitly.
- Confirmation is captured as structured state, not inferred from free text.
- The write spoke rejects requests that lack a confirmation token from the hub.

## 5. Refund guardrails

Refunds are the highest-risk action. The hub must enforce all of the following:

1. **Amount bounded.** Refund amount must not exceed the pricing spoke's
   `computeRefundable` result, and must be in the order's currency.
2. **Idempotency.** Each refund uses a deterministic idempotency key so retries cannot
   double-refund.
3. **Eligibility.** Reject refunds for already-refunded or voided amounts, and respect
   a configurable window (for example, 180 days) if the business requires one.
4. **Auto-approval threshold.** Refunds at or below `REFUND_AUTO_APPROVE_MAX` (a
   configurable env value) may proceed automatically after customer confirmation.
5. **Human approval.** Refunds above the threshold, or flagged as risky (repeat
   refunds, mismatched customer, unusual amount), require an explicit human approval
   recorded in the audit log before execution.
6. **Verified quote.** Model-supplied amounts are untrusted requests. The server
   validates and normalizes the requested amount, computes allocations from
   Shopify's remaining gateway balances, and binds the exact amount and currency
   to a review card. Human confirmation authorizes that immutable server quote.
   Omitting a requested amount uses Shopify's full remaining refundable balance.

## 6. Order-edit guardrails

- Validate the order's current state before editing (for example, cannot add line
  items to a fully refunded or cancelled order).
- Destructive actions (cancel order, remove line items) always require human approval.
- Non-destructive edits (shipping address) require customer confirmation and a state
  re-check immediately before the mutation to avoid stale-write races.
- A pre-tool-use hook rejects an `updateShippingAddress` whose new address is a PO box
  before any proposal is stored; the Shopify write client enforces the same rule
  independently.

## 7. Audit trail

Every PII read and every write appends an immutable audit record containing:

- timestamp, session ID, and (where applicable) approval reference;
- the spoke and action performed;
- target Shopify IDs;
- input summary, outcome, and any evidence IDs returned by Shopify;
- whether human approval was required and who approved.

The audit log is append-only and retained per policy. It must not contain secrets or
full payment data.

## 8. Tool confinement and least privilege

- A spoke receives only the tools its domain requires; the refund tool is not
  available to read-only paths.
- Shopify scopes follow least privilege (see
  [shopify-integration.md](./shopify-integration.md)).
- Spokes validate their input against a schema before calling Shopify; malformed or
  out-of-range inputs are rejected, not coerced.

## 9. Webhook and transport security

- Verify `X-Shopify-Hmac-Sha256` with the client secret before trusting any webhook.
- Use HTTPS everywhere; TLS is terminated by the hosting platform.
- Apply rate limiting and request-size limits at the Hono edge to protect the agent
  endpoint.

## 10. Failure and escalation

- Unknown write outcomes (timeout, ambiguous response) are treated as
  "verify before retry": re-query Shopify state before attempting the mutation again.
- When any guardrail blocks automation, the hub escalates to a human with a summary and
  the relevant order reference — it never silently downgrades the policy.
