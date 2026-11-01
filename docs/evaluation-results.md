# Evaluation results

Run date: 2026-11-01. Model: `openai/gpt-4o-mini`.

All 22 scenario families passed three coordinator runs and one actual browser run. The real configured model selected tools on model-driven paths. Human requests, consent withdrawal, and unsupported-edit responses use deterministic server handling. No scripted model substituted for the configured model.

The final offline check passed 130 tests, all type checks, and the production build.

| ID | Behavior | Coordinator runs | Browser run |
| --- | --- | --- | --- |
| 01 | Customer-first refund | 3/3 passed | Passed |
| 02 | Missing identifiers | 3/3 passed | Passed |
| 03 | Verification across turns | 3/3 passed | Passed |
| 04 | Wrong identity and ambiguous order | 3/3 passed | Passed |
| 05 | Changed order ownership boundary | 3/3 passed | Passed |
| 06 | Persisted shipping-address edit | 3/3 passed | Passed |
| 07 | Unsupported item edit | 3/3 passed | Passed |
| 08 | Exact partial and remaining full refund | 3/3 passed | Passed |
| 09 | Refund amount boundary | 3/3 passed | Passed |
| 10 | Cancellation and pending completion | 3/3 passed | Passed |
| 11 | Ineligible fulfilled order | 3/3 passed | Passed |
| 12 | Cancellation followed by refund | 3/3 passed | Passed |
| 13 | Durable human support handoff | 3/3 passed | Passed |
| 14 | Confirmation bypass and payload tampering | 3/3 passed | Passed |
| 15 | Revoked consent | 3/3 passed | Passed |
| 16 | Stale order recheck | 3/3 passed | Passed |
| 17 | Concurrent confirmation replay | 3/3 passed | Passed |
| 18 | Accepted refund then network timeout | 3/3 passed | Passed |
| 19 | Permanent Shopify dependency failure | 3/3 passed | Passed |
| 20 | Prompt injection in product data | 3/3 passed | Passed |
| 21 | Processing refund status follow-up | 3/3 passed | Passed |
| 22 | Cross-session action isolation | 3/3 passed | Passed |

The runs used the production coordinator, production Shopify client, confirmation routes, SQLite action journal, and React chat interface against controlled Shopify API data. No live Shopify orders changed. Human handoff means a durable local request queued for staff pickup; no live staffed transfer was tested.

Independent subagents fixed observed failures before retries. Fixes include customer-supplied identity binding, contextual routing, exact requested refund amounts, full remaining-balance refunds, notification consent, pending proposal withdrawal, durable human support, authoritative action status, permission-error stopping, ownership rechecks, and uncertain-write handling. Earlier failed runs remain in local artifacts.

Reproduce with `npm run check`, `npm run eval -- --repeat=3`, then `npm run eval:ui` and `npm run eval:browser`. See [the evaluation guide](evaluations.md). Browser screenshots and raw traces are generated under `artifacts/evaluations/` and are not committed. These results establish the tested controlled-API behavior. Live Shopify scope, gateway, and protected-customer-data validation remain deployment checks.
