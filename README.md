# Hono + React starter

A small TypeScript starter with one frontend page at `/`, a Hono API, and the pixel components from [retroui.io](https://retroui.io/) (`pixel-retroui`).

## Run locally

Use Node.js 22.12 or newer. `.nvmrc` selects Node.js 22.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite serves React on port 5173 and proxies `/api` to Hono on port 8787. Both servers restart or refresh when their source changes. Stop both with Ctrl+C.

The default page includes RetroUI `Card`, `Button`, and `Input` components. The system check loads the real Hono health response. The greeting form makes a real API request. The command button copies `npm run dev`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API and frontend together |
| `npm run typecheck` | Check frontend and backend TypeScript |
| `npm test` | Check API behavior and the single-page routing constraint |
| `npm run build` | Type-check and build the frontend and backend |
| `npm start` | Serve the production build and API from Hono on port 8787 |
| `npm run check` | Run tests and build |

For production, run `npm run build` before `npm start`. Open http://localhost:8787. Run commands from the repository root because static asset paths resolve from that directory.

Optional environment variables: `PORT` changes the API port (default `8787`); `HOST` changes the API bind address (default `127.0.0.1`). Set `HOST=0.0.0.0` when deploying to a container. Set `PORT` for `npm run dev` to update both the API and Vite's proxy target. The frontend port is 5173; Vite fails clearly if that port is already in use.

## Structure

```text
index.html                  The only frontend HTML entry
src/client/App.tsx          The only frontend page
src/client/styles.css       Page layout and theme
src/server/app.ts           Hono routes and production static serving
src/server/index.ts         Node server entry
src/server/app.test.ts      API and routing tests
src/shared/contracts.ts     Shared API response types
vite.config.ts              React build and development API proxy
```

## API

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/health` | Status, service name, and server timestamp |
| GET | `/api/hello?name=Ada` | Personalized greeting from Hono |

The greeting name defaults to `builder`. Supplied names are trimmed and must contain 1–40 characters. Invalid names return HTTP 400 with an error message.

There is no frontend router and no additional frontend page. Vite's SPA fallback is disabled. In production, Hono serves `/` and `/assets/*`; unknown routes return HTTP 404 JSON. Add future API routes in `src/server/app.ts`.

No database, authentication, external service, environment file, or secret is required.

## References

- [Hono](https://hono.dev/)
- [React](https://react.dev/)
- [RetroUI](https://retroui.io/) · [pixel-retroui source](https://github.com/Dksie09/RetroUI)
- [Vite](https://vite.dev/)
