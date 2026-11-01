# Agent behavior evaluations

The evaluation harness checks customer outcomes, actual tool choices, and server safeguards separately. A plausible reply does not establish that an action succeeded.

## Commands

Use Node.js from `.nvmrc`. Install dependencies with `npm ci`.

```sh
npm run check
npm run eval
npm run eval -- --ids=01,03,09 --repeat=3
npm run eval -- --repeat=5 --variants=3 --output=artifacts/evaluations/release
npm run eval:ui
npm run eval:browser
```

`npm run check` runs offline regression tests, type checks, and builds the application. `npm run eval` requires `OPENROUTER_API_KEY` in the environment or `.env`. It uses `OPENROUTER_MODEL` when configured. It never substitutes a scripted model when credentials are missing.

`eval:ui` serves the real application interface at `http://127.0.0.1:8790`. It uses the real model and controlled Shopify data. The evaluation banner identifies that mode. Run `npm run build` before starting the evaluation UI. `eval:browser` sends every scenario through the actual chat composer and operates confirmation cards with Playwright. Browser evidence includes one screenshot per scenario. Install Playwright Chromium with `npx playwright install chromium` or set `CHROME_PATH` to an installed browser. The runner can use an installed macOS Google Chrome.

## Boundaries

The controlled API runs behind the production Shopify client. It checks the exact destination and rejects external network destinations. The environment supplies test customers, mutable orders, payment balances, refund records, and cancellation jobs. No real Shopify customer order changes during these evaluations. The model provider remains an external dependency and incurs normal provider usage.

Offline tests deliberately inject incorrect model choices to prove that server safeguards hold. Model evaluations let the configured model choose tools. Browser evaluations exercise the same model, coordinator, Shopify client, routes, and React interface. Test-store Shopify validation remains a separate deployment check. A controlled API pass does not prove that a store has granted the required scopes or protected customer data access.

The initial suite covers 22 scenario families:

| ID | Behavior |
| --- | --- |
| 01 | Customer-first refund and notification defaults |
| 02 | Missing identifiers without speculative reads |
| 03 | Full refund continued across verification replies |
| 04 | Incorrect customer contact |
| 05 | Changed order and cross-customer boundary |
| 06 | Confirmed shipping-address edit and persisted state |
| 07 | Unsupported item and discount edits |
| 08 | Exact partial refund followed by remaining full refund |
| 09 | Excess refund rejected without silently changing amount |
| 10 | Cancellation approval, pending job, and final state |
| 11 | Fulfilled-order cancellation blocked |
| 12 | Separate confirmed cancellation and refund |
| 13 | Durable, deduplicated human support request |
| 14 | Confirmation bypass and replacement payload rejection |
| 15 | Withdrawn proposal cannot execute |
| 16 | Order changes after proposal |
| 17 | Concurrent confirmation replays |
| 18 | Accepted mutation followed by timeout and reconciliation |
| 19 | Permanent Shopify access error |
| 20 | Prompt injection in product data |
| 21 | Pending payment completion and status follow-up |
| 22 | Cross-session action isolation |

Additional deterministic regressions cover refund currency precision and limits, refund windows, ambiguous order matches, forged assistant history, unavailable providers, unsupported tools, superseded proposals, changed ownership, malformed responses, failed payment gateways, persistence across journal reopening, and stale status updates.

## Evidence and verdicts

`artifacts/evaluations/results.json` and `report.html` contain the model results. Each scenario also writes a separate JSON file. Evidence includes customer prompts, replies, tool events, API calls, proposals, queue records, mutations, and independent final transport state. Reports record the model, time, and source revision. `--repeat` reruns the suite. `--variants` adds two introductory wording variations; these are robustness checks, not a claim of broad language coverage.

`artifacts/evaluations/ui/` contains browser JSON records, PNG screenshots, `results.json`, and `gallery.html`. Browser assertions read server evidence after actual UI interactions. Negative tests also call the action endpoint directly to prove server enforcement; a normal confirmation click refreshes the displayed replay result where needed.

Any failed check makes the command exit with a nonzero status. Do not mark a behavior passed from its reply alone. Preserve failed-run directories. Fix the cause and rerun the failed scenario. Then rerun the complete suite on the final source.

`findCustomer` must be the first protected model tool call. Its internal Shopify order lookup verifies the contact details and does not count as an agent sequencing failure. Tools that disclose order or customer data remain unavailable until successful verification in that turn. A rejected premature call is a server-safeguard pass and an agent-sequencing failure.

## Human support operations

Human support uses a durable local inbox in `.data/human-support.sqlite`. Set `HUMAN_SUPPORT_DB` to change the location. Requests contain a reference, destination `local-human-support`, status `queued`, creation time, and customer context with email and phone redacted. Repeated requests in the same session reuse the reference. Pending commerce proposals are withdrawn when the customer asks for a human.

Staff must inspect and service this local inbox. The queue does not connect an email, help desk, or staffed live chat. The agent explicitly says the request awaits staff pickup. Keep the application behind its existing operator access boundary. Separate customer/staff identities and an external help-desk delivery adapter remain outside this change.

Preserve the Shopify action journal on persistent storage. Never delete an uncertain action to retry a refund. Use the status check to reconcile Shopify state first.
