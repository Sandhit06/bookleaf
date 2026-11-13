# BookLeaf Author Support & Operations Portal

One Node.js application serves the portal and its REST API from the same origin. The author and admin interfaces now authenticate with the API and use server-side books, tickets, replies, triage, AI drafts, persistence, and server-sent updates. The supplied sample dataset is loaded by the backend; author and ticket data are no longer embedded in the browser bundle.

## Run locally

Requirements: Node.js 18 or newer and npm.

```sh
cp .env.example .env
npm ci
npm run seed
npm start
```

Open `http://localhost:4000`. API health is at `http://localhost:4000/api/v1/health`. In development, the default shared demo password is `bookleaf123`. Use any author email in `bookleaf_sample_data.json`, or `admin@bookleaf.in` for the operations portal. Change `DEMO_PASSWORD` before sharing the application. The shared password and seeded demo identities are for assessment/demo use only.

`npm run dev` starts Node's watch mode. `npm run seed` validates the supplied 10-author/18-book fixture and copies it into the backend seed location; it preserves existing tickets. Tickets are stored in `backend/src/db/tickets.json` unless `DATA_DIR` is set. The `.gitignore` excludes the ticket store and `.env`.

AI drafts run through the backend only. Set `OPENAI_API_KEY` to enable OpenAI (default model: `gpt-4o-mini`); omit the key to use the deterministic local fallback. Never put a provider key in the browser or commit a real key.

## Product and architecture

- `frontend/index.html` is the responsive author/admin portal. Login is required before the workspace appears. The role returned by the API controls available views; authors cannot switch identities or open admin views. Browser session state holds the short-lived bearer token in `sessionStorage`; ticket data is not stored in `localStorage`.
- `backend/src/server.js` serves the page and JSON API. It validates role-sensitive actions, persists tickets atomically to a JSON file, and sends author-scoped SSE events to the owner and admins.
- `backend/src/services/aiService.js` selects one relevant policy section and a compact book record, requests structured AI triage/drafting, validates the returned category and priority, and falls back locally on missing keys, provider errors, or malformed responses.
- `backend/src/db/bookleaf_sample_data.json` is the backend fixture copied from the root `bookleaf_sample_data.json` by the seed command.
- `backend/src/db/schema.sql` is a PostgreSQL schema proposal; the current running implementation uses JSON persistence rather than PostgreSQL.
- `openapi.yaml` documents the REST API.

The royalty scrubber is a forecast, not a payout statement. Unit costs that are absent from the supplied records are labeled illustrative; titles still in production show royalty estimates as TBD. The stock-availability action opens a support request; no retailer/print-partner API integration is supplied. Attachments currently retain file names and sizes only; the file itself is not uploaded.

## API summary

Protected routes use `Authorization: Bearer <token>`. Login uses `{ "email": "...", "password": "..." }` and returns `{ token, user }`.

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | Public | Authenticate a seeded author or admin demo account |
| `GET` | `/api/v1/authors/me/books` | Author | Return the signed-in author's profile and books |
| `GET` | `/api/v1/authors` | Admin | Return seeded author/book records for the operations queue |
| `GET` | `/api/v1/tickets` | Author/Admin | List own tickets or the full queue; supports `status`, `category`, `priority`, `from`, and `to` |
| `POST` | `/api/v1/tickets` | Author | Create ticket, run AI triage, and persist the initial conversation/draft |
| `PATCH` | `/api/v1/tickets/:id/triage` | Admin | Override status/category/priority or assign the ticket |
| `POST` | `/api/v1/tickets/:id/draft` | Admin | Regenerate a policy-grounded draft on the server |
| `POST` | `/api/v1/tickets/:id/responses` | Author/Admin | Add a public response; admins can add hidden internal notes and set ticket status |
| `GET` | `/api/v1/events` | Authenticated | Receive ticket events over SSE; events are scoped to the ticket's author and admins |
| `GET` | `/api/v1/health` | Public | Health check for the host's deployment monitor |

Errors use JSON `{ error, message }` responses. Authors cannot request another author's tickets, books, or ticket responses; internal notes are removed from author responses. See `openapi.yaml` for the API contract.

## AI design and limits

The server selects a policy section from the query intent and includes only that text and the referenced book's relevant operational fields. It does not send the full catalogue or ticket history. The API records model token usage when the provider returns it. The local fallback uses a token estimate and sets `ai_degraded: true` so the admin knows that the draft needs review. Admins can edit the draft or write a reply manually. The implementation currently supports OpenAI only; the Anthropic variables from earlier drafts have been removed.

The demo uses one shared password for seeded accounts and a JSON ticket store. Do not use these choices for real author accounts or multi-instance production. For a real service, add per-user password hashes/managed identity, PostgreSQL migrations and transactions, object storage for uploads, audit history, rate limiting, and a shared event broker.

## Deploy on Render Free

The frontend and API run together as one Node web service. For a Render Free demo deployment:

1. Connect the repository to a Render **Web Service**. Keep **Root Directory** blank so Render uses the repository root.
2. Set **Build Command** to `npm ci` and **Start Command** to `npm start`.
3. Set these environment variables in the service's **Environment** page:
   - `NODE_ENV=production`
   - `DATA_DIR=/tmp/bookleaf-data`
   - `JWT_SECRET` to a unique, cryptographically random string of at least 32 characters
   - `DEMO_PASSWORD` to a strong, unique demo password
   - `OPENAI_API_KEY` (optional; without it the local fallback is used)
   - `OPENAI_MODEL=gpt-4o-mini` (optional)
4. Do not set `PORT`; Render supplies it. Set the health check path to `/api/v1/health`.
5. Deploy. Open the service URL and confirm `/api/v1/health` returns `{"status":"ok"}`. Open `/` to use the frontend, then sign in with a seeded author email or `admin@bookleaf.in` and the configured `DEMO_PASSWORD`.

The server defaults to `/tmp/bookleaf-data` on Render when `DATA_DIR` is omitted. The path is writable on the Free instance, so the app can start and tickets can be created, replied to, and triaged during that running instance. **This is temporary storage:** Render Free clears local files when a service sleeps, restarts, or redeploys. Tickets may therefore disappear, including after the service spins down while idle. Do not use this configuration when ticket history must be durable. Render Free services also spin down after 15 minutes without inbound traffic and can take about a minute to start again.

Render Free cannot attach persistent disks. To keep the JSON ticket file across restarts, move the web service to a paid compute plan and mount a disk at `/var/data`, then set `DATA_DIR=/var/data`. Alternatively, the project needs a database-backed storage adapter to use a managed database. The current server does not yet read/write tickets from PostgreSQL; Render's Free Postgres also expires 30 days after creation, so it is not durable long-term storage.

The default port is 4000 locally; the server honors the `PORT` variable supplied by the host. The current UI uses same-origin API paths and must be served by this same Node service. A separately hosted frontend needs an API base URL configuration and is not supported by the current build.

### Other hosting platforms

The app can run on any long-lived Node host that supports Node 18+, outbound HTTPS, an environment-variable store, and a persistent writable volume mounted through `DATA_DIR`. Configure the same start command, environment variables, health check, and disk as above. **Do not deploy the current JSON/SSE implementation to Vercel's serverless runtime as-is**: its filesystem is ephemeral and function lifetimes do not provide the persistent ticket store and long-lived SSE connection used here. Vercel would require a database-backed storage adapter and a realtime service, which are not part of this project yet.

## Assessment write-up

See [WRITEUP.md](WRITEUP.md) for the approach, trade-offs, and production evolution plan.
