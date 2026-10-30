# Implementation Plan

This plan turns the design in [architecture.md](./architecture.md),
[agents.md](./agents.md), [shopify-integration.md](./shopify-integration.md), and
[security.md](./security.md) into an incremental build on top of the existing
Hono + React starter.

Nothing here is implemented yet. Each phase is independently reviewable and keeps the
current app (`/`, `/api/health`, `/api/hello`) working.

## Guiding constraints

- Add code under `src/server` and shared types under `src/shared`; keep `/` as the only
  frontend page and unknown paths returning JSON 404 (existing repository rules).
- No secrets in source. Shopify credentials come from environment variables.
- Ship docs and tests alongside each phase; run `npm run check` before every PR.
- Prefer fixture-based tests so most behavior is verifiable without a live store.

## Phase 0 — Contracts and scaffolding (no external calls)

- Define shared types: `SpokeRequest`/`SpokeResult`, `SpokeName`, spoke error codes,
  and domain models (`Customer`, `Order`, `ProductVariant`, `RefundQuote`).
- Define interfaces: `ShopifyClient`, `ConversationStore`, `AuditLog`, and the config
  loader for Shopify env vars.
- Add a `ShopifyFixtureClient` so everything downstream is testable offline.
- **Exit criteria:** types compile; contract unit tests pass; no live Shopify calls.

## Phase 1 — Shopify connector

- Implement `ShopifyLiveClient`: token acquisition (client credentials, and the OAuth
  code flow if multi-store is required), caching/refresh, GraphQL transport, cost-aware
  backoff, timeouts, and typed errors.
- Enforce secret redaction in logs and error paths.
- **Exit criteria:** connector tests against a mock HTTP server cover success, 401
  refresh, throttling/backoff, and redaction.

## Phase 2 — Read spokes

- Implement customer, order, product, and pricing spokes on top of `ShopifyClient`.
- Wire the deterministic `computeRefundable` math in the pricing spoke.
- **Exit criteria:** each read spoke has fixture-based tests, including "not found",
  "ambiguous member", and schema-rejection cases.

## Phase 3 — Hub orchestrator

- Implement the hub decision loop: intent classification, plan templates, spoke
  routing, result aggregation, and clarification questions.
- Define routing rules from the table in [agents.md](./agents.md).
- The LLM provider is an adapter behind an interface so the hub can be tested with a
  deterministic fake planner.
- **Exit criteria:** for representative transcripts, the hub produces the expected
  spoke sequence and final reply, verified with the fake planner.

## Phase 4 — Write spokes and guardrails

- Implement the refund and order-edit spokes.
- Implement confirmation capture, refund threshold/human-approval checks, idempotency
  keys, eligibility checks, and audit logging from [security.md](./security.md).
- **Exit criteria:** tests prove that unconfirmed writes are rejected, over-threshold
  refunds require approval, refunds cannot exceed `computeRefundable`, and repeated
  identical writes do not double-apply.

## Phase 5 — HTTP surface and UI

- Add a Hono agent route (for example `POST /api/agent/message`) with rate limiting and
  request-size limits.
- Add the minimal chat surface using existing RetroUI components, keeping `/` as the
  only page.
- **Exit criteria:** end-to-end happy path works against the fixture client; unknown
  paths still return JSON 404; existing health/greeting behavior is unchanged.

## Phase 6 — Hardening and observability

- Webhook ingestion with HMAC verification and idempotent processing.
- Metrics and structured, redacted logging; alerting on guardrail escalations and write
  failures.
- Pin and periodically review `SHOPIFY_API_VERSION`; add a dependency/upgrade note.
- **Exit criteria:** runbook for human approvals and incident response is documented.

## Dependencies and ordering

```text
Phase 0 ─▶ Phase 1 ─▶ Phase 2 ─▶ Phase 3 ─▶ Phase 4 ─▶ Phase 5 ─▶ Phase 6
                                   │             │
                                   └── read spokes feed both the hub and the writes
```

- Phase 1 depends on Phase 0 contracts.
- Phase 3 depends on read spokes (Phase 2) but can start with fixtures.
- Phase 4 depends on the pricing spoke (Phase 2) and hub confirmation flow (Phase 3).
- Phase 5 depends on a working hub (Phase 3) and is safe once writes are gated.

## Testing strategy

- **Unit:** pricing math, guardrail predicates, schema validation, redaction.
- **Contract:** hub↔spoke envelopes and error classification.
- **Integration:** spokes against `ShopifyFixtureClient`; connector against a mock
  HTTP server.
- **Orchestration:** representative transcripts → expected plans and replies with a
  deterministic fake planner.
- **Safety:** adversarial cases — unconfirmed writes, cross-customer access,
  over-threshold refunds, duplicate writes, retry-after-unknown-outcome.
- **Existing repo checks:** `npm run check` must stay green (tests + typecheck + build).

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Irreversible refund/order mistakes | Financial loss, trust | Confirmation + thresholds + idempotency + audit (Phase 4) |
| Shopify API version/scope drift | Breakage | Pin version, review schedule, typed scope errors |
| Token leakage | Account compromise | Server-only secrets, redaction tests, fail-fast config |
| Model hallucinating amounts/IDs | Wrong action | Deterministic pricing/authz; model never supplies the amount |
| Live-store testing risk | Real side effects | Fixture client as the default in tests |
| Ambiguous customer identity | Privacy breach | Strong-identifier authorization before any read/write |

## Definition of done

- Documentation covers architecture, agents, Shopify integration, security, and plan
  (this directory).
- Read and write spokes implemented behind typed interfaces with fixture tests.
- Guardrails enforced in code and proven by adversarial tests.
- `npm run check` passes; `/` remains the only page; unknown paths return JSON 404.
- Secrets supplied only via environment variables; no credentials committed.
- Human-approval and incident runbooks documented before enabling live writes.
