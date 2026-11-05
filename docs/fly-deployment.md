# Fly.io demo deployment

## Live demo

The [shared demo](https://customer-service-order-agent-demo.fly.dev/) runs in the
`personal` Fly.io organization. Sign in as `demo` with `DEMO_PASSWORD` from the
private `.env.fly` file in the deployment worktree. Shopify requests go to the
`nate-ce.myshopify.com` development store.

Open **Demo orders** above the chat to browse Shopify test orders, newest first.
The picker shows ten orders per page. Open an order to find its synthetic
customer, demo email, quantities, and discount. The picker
reads Shopify again after a reported action and when reopened. Use **Refresh
orders** to pick up changes that Shopify finishes later.

`DEMO_ORDER_STORE_DOMAIN` in `fly.toml` must match the Shopify store configured
for the connector. The panel fetches up to 50 recent test orders and displays
those with a customer and a synthetic email domain.

The November 3, 2026 deployment passed the Fly health check, rejected anonymous
requests and incorrect credentials, and loaded the React page in an authenticated
browser. The browser streamed a live OpenRouter reply with a successful Shopify
product search. The same synthetic support request kept its reference after a
Machine restart. The verification used only Shopify reads.

## Deployment plan

Deploy the React page and Hono API together as one container. Visitors open an
HTTPS URL and enter a shared username and password in the browser's login prompt.
Chat and action requests use that same origin. No separate frontend host is needed.

1. Build the production image with Node.js 22.
2. Create one Fly app in `lax` (Los Angeles).
3. Store credentials in Fly secrets.
4. Mount one persistent volume at `/data`.
5. Deploy one Machine with 512 MB of memory.
6. Verify login, streaming chat, and persistent data.
7. Share the verified URL and demo credentials with visitors.

The `app` name in `fly.toml` identifies the deployed demo. For a separate copy,
choose a globally unique name and change `app` and `PUBLIC_ORIGIN` together.
Create the volume in the same region as the Machine.

## Implemented files

| File | Responsibility |
| --- | --- |
| `Dockerfile` | Build React and Hono and install production dependencies in the runtime image |
| `.dockerignore` | Exclude credentials, local databases, Git history, and generated artifacts from build uploads |
| `scripts/docker-entrypoint.sh` | Give the `node` user access to the mounted volume, then run the server as that user |
| `fly.toml` | Configure HTTPS, port 8787, health checks, automatic stop/start, volume storage, and Machine size |
| `.env.fly.example` | List runtime secrets for a separate demo environment |
| `src/server/deployment.ts` | Validate demo credentials and the public HTTPS origin before the server starts |
| `src/server/deployment.test.ts` | Verify access restrictions, streaming sessions, and proxied action confirmation |

The server binds to `0.0.0.0:8787`. Fly terminates HTTPS before forwarding requests
to Hono. Preserve the public `Host` header if you add a proxy in front of Fly.
The API checks that header and any browser `Origin` against `PUBLIC_ORIGIN`.
Session cookies use `Secure` when `PUBLIC_ORIGIN` is set. These checks use the
configured origin independently of forwarded headers. The Fly health check
continues to use `/api/health` without credentials.

## Access and data assumptions

This is a trusted-visitor demo. The shared password grants access to the whole app,
including the Shopify confirmation screen. The password does not separate customer
and operator roles. Use a dedicated demo store and synthetic customers and orders.
Refunds, cancellations, and address updates still call the configured Shopify store.

`DEMO_AUTH_REQUIRED=true` makes a missing or blank `DEMO_PASSWORD` a startup error.
It also requires `PUBLIC_ORIGIN`, which must be an HTTPS origin without a path,
query, or credentials. The username defaults to `demo`. Only `GET /api/health`
(and its HTTP `HEAD` equivalent) bypasses login. Health reports process liveness.
Use a chat request to check OpenRouter and Shopify access.

The app stores the action journal in `/data/shopify-actions.sqlite` and the human
support inbox in `/data/human-support.sqlite`. Both paths are set in `fly.toml`.
Fly's root filesystem is temporary. The mounted volume preserves both databases
across restarts and deployments. The first deployment creates fresh demo databases.
The image excludes local `.data` files.

Run exactly one Machine. Fly Volumes do not replicate automatically. Adding a
second Machine would create separate action journals and support inboxes. One
Machine also means deployments and host failures can interrupt the demo.

## First deployment

Run commands from the repository root. Use `flyctl` for the Fly.io command-line
tool. On the setup computer, `fly` resolves to a different application.

1. Sign in to Fly.io.

   The command-line tool was installed at `~/.fly/bin/flyctl`. Use the full path or
   add that directory to the current shell's search path:

   ```sh
   export PATH="$HOME/.fly/bin:$PATH"
   flyctl auth login
   ```

2. Find the organization that should own the app.

   ```sh
   flyctl orgs list
   ```

3. Edit `fly.toml`.

   Set `app` to an available name. Set `PUBLIC_ORIGIN` to
   `https://<that-name>.fly.dev`. Keep `DEMO_AUTH_REQUIRED=true`.

4. Create the app in your chosen organization.

   Replace both placeholders:

   ```sh
   flyctl apps create <that-name> --org <organization-slug>
   ```

5. Validate the configuration.

   ```sh
   flyctl config validate
   ```

6. Create the data volume.

   ```sh
   flyctl volumes create demo_data --region lax --size 1
   ```

7. Create a private secrets file.

   ```sh
   umask 077
   cp .env.fly.example .env.fly
   ```

8. Fill in `.env.fly` with the demo credentials.

   Set a long random `DEMO_PASSWORD`, an `OPENROUTER_API_KEY`, and the Shopify
   credentials for the demo store. Use a dedicated OpenRouter key with a provider
   credit limit. Do not paste secrets into chat, commit them, or prefix them with
   `VITE_`. Vite embeds variables with that prefix in browser code.

   The current Shopify connector requires `SHOPIFY_CLIENT_ID` and
   `SHOPIFY_CLIENT_SECRET` even when `SHOPIFY_ACCESS_TOKEN` is provided. Shopify
   must grant the order scopes and protected customer data access described in
   [the Shopify guide](shopify-integration.md). Without OpenRouter credentials,
   chat shows an error. Without Shopify credentials, commerce tools show an error.

9. Stage the runtime secrets.

   ```sh
   flyctl secrets import --stage < .env.fly
   ```

10. Allocate a shared public IPv4 address.

    ```sh
    flyctl ips allocate-v4 --shared
    ```

11. Allocate a public IPv6 address.

    ```sh
    flyctl ips allocate-v6
    ```

12. Run the repository checks.

    ```sh
    npm ci
    npm run check
    ```

13. Deploy the image.

    ```sh
    flyctl deploy --remote-only --ha=false
    ```

    `--ha=false` prevents creation of a spare Machine. Do not use a canary or
    blue-green deployment strategy with the single SQLite volume. Fly's default
    rolling deployment updates the existing Machine.

14. Check the running app.

    ```sh
    flyctl status
    flyctl checks list
    flyctl machine list
    ```

## Verify before sharing

Use your actual app URL in place of `https://<that-name>.fly.dev`.

1. Request `/api/health` without credentials.

   ```sh
   curl --fail https://<that-name>.fly.dev/api/health
   ```

   Expect HTTP 200 and `status: "ok"`.

2. Request `/` without credentials.

   ```sh
   curl -I https://<that-name>.fly.dev/
   ```

   Expect HTTP 401 and a `WWW-Authenticate: Basic` header.

3. Open the URL in a private browser window.

   Expect a login prompt. A wrong password must fail. The `demo` username and the
   configured password must show the page and load its assets.

4. Send a product question through chat.

   Expect visible streamed activity and a real Shopify product result. Inspect
   `/api/chat` in browser developer tools. Expect a `text/event-stream` response
   and an `order_chat` cookie with `Secure`, `HttpOnly`, and `SameSite=Strict`.

5. Confirm an address change on a synthetic, unfulfilled demo order.

   Expect the review card before execution and the updated address in Shopify
   after confirmation. An HTTP 403 here usually means `PUBLIC_ORIGIN` does not
   match the browser origin. Do not test a refund against a real payment.

6. Request human support in the same browser session.

   Expect a queued request with a reference. The app saves the request to a local
   inbox for staff to review.

7. Restart the app.

   ```sh
   flyctl apps restart
   ```

8. Check `/api/actions` in the same browser session.

   Expect the recorded action after restart. An authenticated request is required.
   Confirm that both database files still exist under `/data` through
   `flyctl ssh console`. Repeat the human support request and expect the same
   queued reference.

9. Share the URL and login credentials.

   Visitors share the login, but each browser has a separate chat session and
   session-bound action list. Browser Basic authentication usually caches login
   until the browser session closes. Close the private window to end that demo
   browser session.

## Updates, rollback, and maintenance

GitHub Actions runs `npm run check` on pull requests and pushes. After a merge
updates `main`, the deploy job waits for those checks and deploys that commit.
The job serializes deployments and skips a commit if a newer commit is already
on `main`. The job checks the public health endpoint and confirms that the demo
requires login. Find the result under **Actions → Check starter**.
Use **Run workflow** with the `main` branch to run the same checks and deploy
again if a merge does not start a run.

The job uses the repository secret `FLY_API_TOKEN`. It is scoped to the demo app
and expires after 8,760 hours (one year). Rotate it before expiry. Run from the
repository root to create a replacement and send it directly to GitHub Secrets:

```sh
set -o pipefail
flyctl tokens create deploy --name github-actions-demo --expiry 8760h |
  gh secret set FLY_API_TOKEN
```

The GitHub job labels the Fly image with `git-<commit-sha>`. Use `flyctl status`
to see the running image. Run `flyctl logs` when diagnosing a failed start. Use
`flyctl deploy --remote-only --ha=false` when deploying manually. The health
endpoint can pass with missing provider credentials, so test chat after changes
to OpenRouter or Shopify settings.

To roll back application code, find the previous image with
`flyctl releases --image`, then deploy that exact image:

```sh
flyctl deploy --image <previous-image-reference> --ha=false
```

Keep the volume during rollback. An image rollback does not undo Shopify changes
or restore the databases. Never delete the action journal to retry an uncertain
refund or cancellation. Use **Check Shopify status** to reconcile the outcome.
Do not restore an older volume snapshot while writes are in progress; an older
journal can omit actions that already happened in Shopify.

Rotate the shared password by changing `.env.fly` and importing it again with
`flyctl secrets import < .env.fly`. Importing without `--stage` restarts the app.
Do not publish the `.env.fly` file. Keep a secure copy if you need it for rotation.

Fly retains scheduled volume snapshots for seven days with this configuration.
Snapshots do not provide continuous replication. Inspect snapshots with
`flyctl volumes snapshots list <volume-id>`. Plan a consistent SQLite backup and
test restoration before using the service for real customer operations.

## Cost and availability

The Machine stops when idle and starts on the next request. The first visitor
after an idle period can see a startup delay. Before a scheduled demo, set
`min_machines_running=1` and deploy to keep the Machine running in the primary
region. Set the value back to `0` afterward to allow automatic stopping.

Charges depend on the selected region, running time, stopped root filesystem,
volume storage, snapshots, and outbound traffic. Automatic stopping does not make
the service free. OpenRouter usage is billed separately. Check the Fly calculator
for `lax`, one shared CPU, 512 MB of memory, and a 1 GB volume before deploying.

## Official references

- [Fly app configuration](https://docs.fly.io/reference/configuration)
- [Fly deployment command](https://docs.fly.io/flyctl/cmd/fly_deploy)
- [Fly Volumes and replication limits](https://docs.fly.io/volumes/overview)
- [Fly runtime secrets](https://docs.fly.io/apps/secrets)
- [Fly pricing](https://docs.fly.io/about/pricing)
