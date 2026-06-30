# Social Automation — Backend

Production-ready backend for a comment-to-DM automation SaaS (Instagram Business + Facebook Pages) built on the official Meta Graph API.

Clean modular monolith: **Node + Express + TypeScript + MongoDB/Mongoose**, with **JWT auth**, **Brevo** transactional email, and a **Repository → Service → Controller** layered architecture. No Redis, no AI, no microservices (per MVP scope).

## Stack

- Node.js, Express 4, TypeScript (strict)
- MongoDB + Mongoose 8
- JWT access/refresh auth + httpOnly refresh cookie
- Zod request validation
- Winston logger, Helmet, CORS, rate limiting, compression
- Brevo (transactional email) — dry-run by default in dev
- Meta Graph API integration (OAuth, webhooks, comment reply, private replies, Send API, token refresh)

## Getting started

```bash
cd backend
cp .env.example .env          # fill in values (or keep stubs for local dev)
npm install
npm run seed:plans            # seed Free/Starter/Pro plans (needs MongoDB)
npm run dev                   # start with hot reload
```

Build & run production:

```bash
npm run build
npm start
```

Quality gates:

```bash
npm run typecheck
npm run lint
npm run format:check
```

## Environment

See [.env.example](.env.example). For local development you only strictly need
`MONGODB_URI` and the three JWT secrets — Brevo and Meta calls are stubbed
(`EMAIL_DRY_RUN=true`, placeholder Meta creds) so nothing external is required
to boot the API. Plug real Meta/Brevo credentials in later without code changes.

## Architecture

```
src/
  config/         env (zod-validated), logger (winston), database (mongoose)
  constants/      enums + HTTP status codes
  types/          shared TS types + Express request augmentation
  models/         13+ Mongoose models (users, workspaces, socialAccounts,
                  automations, keywords, conversations, messages, leads,
                  analytics, notifications, activityLogs, plans, subscriptions,
                  invoices, payments)
  repositories/   Repository Pattern over Mongoose (generic BaseRepository)
  validators/     Zod schemas per resource
  middlewares/    auth, validate, error handler, not-found, rate limiting
  services/       business logic (auth, account, automation, lead, inbox,
                  analytics, settings, subscription, notification, webhook,
                  email/Brevo, meta/Graph API)
  controllers/    thin HTTP handlers (asyncHandler-wrapped)
  routes/         Express routers mounted under API_PREFIX
  scripts/        seedPlans, refreshTokens (cron-friendly)
  app.ts          express app assembly
  server.ts       bootstrap + graceful shutdown
```

## API surface (prefix `API_PREFIX`, default `/api/v1`)

| Group | Routes |
| --- | --- |
| `/auth` | register, login, refresh, logout, verify-email, resend-verification, forgot-password, reset-password, facebook |
| `/users` | me, me/notifications (+ unread-count, read, read-all) |
| `/accounts` | list, oauth/url, oauth/callback, connect, :id, disconnect |
| `/automations` | CRUD, list (search/filter/paginate), :id/status |
| `/messages` | conversations (unified inbox), thread, status, reply, unread-count |
| `/leads` | list, export (CSV), :id (get/update/delete) |
| `/analytics` | dashboard, overview (daily series, top keyword, platform) |
| `/settings` | profile, workspace, notifications, password, account (delete) |
| `/subscriptions` | plans, current, invoices |
| `/webhooks/meta` | GET verify handshake, POST receive (signature-verified) |

## Comment-to-DM flow

1. Meta delivers a webhook to `POST /webhooks/meta` → signature verified via
   `X-Hub-Signature-256` against the raw body.
2. `webhook.service` resolves the connected account, dedupes by external id,
   records the inbound comment.
3. Active automations on that account are matched against the comment text by
   keyword.
4. On a match: public reply is posted, a private DM (private reply) is sent,
   a conversation + lead are created, analytics counters and the audit log are
   updated, and the owner is notified (in-app + email).

## Notes & future-proofing

- Subscription/billing collections exist but no gateway is wired (future phase).
- Token refresh is a standalone script (`job:refresh-tokens`) intended for a
  scheduled cron — no queue/Redis dependency.
- Multi-member workspaces, websockets, and AI are intentionally out of scope but
  the schema/architecture leave room for them.
