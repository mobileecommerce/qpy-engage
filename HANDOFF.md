# Qpy Engage engineering handoff

Updated: July 18, 2026 (real authentication added — read "Authentication" below before assuming the shared workspace-key model still applies)

## Source and deployments

- Repository: https://github.com/mobileecommerce/qpy-engage
- Continue from branch: `agent/publish-github-pages`
- Branch URL: https://github.com/mobileecommerce/qpy-engage/tree/agent/publish-github-pages
- Live frontend: https://mobileecommerce.github.io/qpy-engage/
- GitHub Pages source branch: `gh-pages`
- Cloudflare Worker: `qpy-engage-api`
- Worker URL: https://qpy-engage-api.qpy-engage.workers.dev
- D1 database: `qpy-engage-db`

Do not continue from `main`; it is behind the active branch.

## Product state

### Working with a real backend

- WhatsApp Cloud API manual connection using WABA ID, Phone Number ID, and a Meta access token
- Server-side validation of Meta assets
- AES-GCM encrypted access-token storage in Cloudflare D1
- WABA webhook subscription
- Signed WhatsApp webhook verification and ingestion
- Live Inbox loading from D1 with eight-second refresh
- Live inbound WhatsApp messages
- Outbound free-form WhatsApp replies through Graph API during the customer-service window
- Meta `hello_world` test message
- Connection diagnostics and token-refresh recovery
- Public privacy, terms, and data-deletion pages

### Implemented primarily as browser-product functionality

- AI assistant builder, instructions, knowledge setup, actions, voice configuration, testing, governance, and publishing
- Campaign builder, audience import, image attachment, scheduling, and campaign records
- Automation builder and templates
- Team and subscription management UI
- Analytics and exports
- Web-chat widget setup

These product areas persist per-workspace through `/api/state` now that real accounts exist (see below), so they sync across devices/browsers for the same signed-in account, but they are still interactive simulations, not calls to production services. Instagram is currently a sandbox/demo connection. AI responses (assistant test chat, knowledge Q&A) are canned strings, not calls to a production model. Campaign "sends" and billing are simulated; no bulk WhatsApp/Instagram broadcast API or payment processor is wired up.

## Authentication and multi-tenancy

Real accounts replaced the single shared `default` workspace and the `x-qpy-setup-key` model:

- `worker/auth.ts` implements signup/login/logout, PBKDF2 password hashing, and bearer session tokens (`sessions` table, 30-day expiry). No new secret is required — session tokens are self-contained.
- New D1 tables: `users`, `workspaces`, `workspace_members`, `sessions`. `whatsapp_messages` gained a `workspace_id` column. All are created idempotently at request time (see `ensureAuthSchema` / `ensureMetaSchema`) the same way the existing WhatsApp tables are, so no manual migration step is required to deploy this.
- Every `/api/meta/*` endpoint (except `config`, which is server-level non-tenant config) now requires a valid `Authorization: Bearer <token>` session instead of the old shared setup key. Connecting/disconnecting WhatsApp requires the `Owner` or `Admin` role.
- `/api/state` is now namespaced per authenticated workspace (`${workspaceId}::${key}` internally) instead of being a single global keyspace anyone could read or write.
- **First-signup migration**: when the very first user account is created, if a legacy `whatsapp_connections` row still exists under the old hardcoded workspace id `"default"`, that workspace id (and any `whatsapp_messages` rows with a null `workspace_id`) are adopted by that user's new workspace, so the already-connected WhatsApp number keeps working under the first real account. Every signup after that gets its own fresh workspace.
- The frontend now gates the whole app behind login/signup (`app/page.tsx`'s `AuthGate`/`Home`/`Workspace` split). The bearer token lives in `localStorage` (`qpy-engage-auth-token`) and is attached via an `AuthTokenContext` used by `useStoredState`, `Channels`, `LiveInbox`, and the new `useWorkspaceMembers` hook (Team page — invite/role/remove now hit real `/api/workspace/members` endpoints instead of local mock state).
- Role gating so far is minimal: Team invite/role-change/remove and WhatsApp connect/disconnect require Owner/Admin (enforced server-side); other pages don't yet differentiate by role.

**Not yet done**: this was built and reviewed carefully but has not been run through `npm run build`/typecheck or exercised against a live Worker (the agent session that built it had no local Node.js). Run `npm run build` and click through signup → connect WhatsApp → invite a teammate on a preview deploy before trusting this in production. There is also no "forgot password," email verification, or workspace-switching UI yet (a user invited to a second workspace only gets attached to it in the database, with login always resolving to their `Owner` workspace first).

## Current WhatsApp/Meta status

- Meta App ID: `966180749793118` (not a secret)
- Embedded Signup configuration ID: `2294788824594343` (not a secret)
- Graph API version: `v25.0`
- Callback URL: https://qpy-engage-api.qpy-engage.workers.dev/api/webhooks/whatsapp
- A Meta test WABA and test phone number have been connected successfully.
- Real inbound message delivery into Qpy Engage has been confirmed.
- The most recent outbound reply failed because the temporary Meta user access token became invalid.
- The user must replace it with a Meta System User Access Token, ideally with `Never` expiration, and these permissions:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
  - `business_management` when required for business-portfolio operations
- Qpy Engage provides Channels → WhatsApp → Refresh access token for this update.
- Business Verification and App Review are intentionally postponed.
- Embedded Signup is configured but cannot be treated as production-ready until Meta verification, App Review, and Advanced Access are completed.
- The Meta app is unpublished, so real production webhook delivery can be restricted by Meta. Dashboard test webhooks remain useful during development.

## Critical security notes

Never commit or print any of these values:

- `META_APP_SECRET`
- `META_TOKEN_ENCRYPTION_KEY`
- `META_WEBHOOK_VERIFY_TOKEN`
- Meta user or system-user access tokens
- User password hashes / session token hashes (not secrets you set, but never log them)

They are stored as Cloudflare Worker secrets. The Meta App Secret was shared in a prior private development conversation and should still be rotated before production; update the Cloudflare secret immediately after rotating so webhook signature validation and `appsecret_proof` continue to work. `META_SETUP_KEY` is retired — it's no longer read anywhere in the code and can be deleted from Cloudflare secrets.

Expected Cloudflare values:

- Non-secret vars in `wrangler.jsonc`: `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION`
- Secrets: `META_APP_SECRET`, `META_TOKEN_ENCRYPTION_KEY`, `META_WEBHOOK_VERIFY_TOKEN`

## Backend API map

- `GET /api/meta/config`: public non-secret Meta configuration
- `GET /api/meta/status`: sanitized connection status for the caller's workspace; requires a session
- `POST /api/meta/oauth/exchange`: Embedded Signup code exchange; requires an Owner/Admin session
- `POST /api/meta/manual/connect`: manual/system-user token connection; requires an Owner/Admin session
- `GET /api/meta/inbox`: live stored messages for the caller's workspace; requires a session
- `POST /api/meta/inbox/messages`: send live WhatsApp reply; requires a session
- `POST /api/meta/test-message`: send approved test template; requires a session
- `DELETE /api/meta/connection`: disconnect; requires an Owner/Admin session
- `GET|POST /api/webhooks/whatsapp`: Meta challenge and signed webhook delivery (unauthenticated by design — Meta calls this directly; resolves the workspace from the incoming `phone_number_id`)
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`: account auth
- `GET /api/workspace/members`, `POST /api/workspace/members` (invite), `PATCH /api/workspace/members/:email` (role), `DELETE /api/workspace/members/:email`: team management, Owner/Admin only for writes

The GitHub frontend calls the Worker through `META_BACKEND_ORIGIN` in `app/page.tsx`. CORS currently allows `https://mobileecommerce.github.io`, local development, and ChatGPT Sites preview hosts.

## Deployment

### Frontend / GitHub Pages

1. Validate the static build:

   ```bash
   NEXT_PUBLIC_BASE_PATH=/qpy-engage npm run build:pages
   ```

2. Publish the generated `out/` directory to the `gh-pages` branch.
3. Confirm https://mobileecommerce.github.io/qpy-engage/ serves the new build.

The product source remains on `agent/publish-github-pages`; do not edit generated GitHub Pages files as product source.

### Cloudflare Worker

1. Validate:

   ```bash
   npm run build
   ```

2. Deploy using the production configuration:

   ```bash
   npx wrangler deploy --config wrangler.jsonc
   ```

vinext may generate `.wrangler/deploy/config.json` with a duplicate local `DB` binding. If Wrangler reports that `DB` is assigned twice, temporarily move that generated redirect file out of `.wrangler/deploy/`, deploy with `wrangler.jsonc`, and restore it afterward. Do not alter the production D1 binding in `wrangler.jsonc`.

## Recommended next work

Done: real authentication, per-workspace data isolation, and role-based access for team/WhatsApp management (see "Authentication and multi-tenancy" above) — verify with `npm run build` and a live click-through before trusting it further.

1. Verify the auth changes actually build/deploy cleanly (`npm run build`, then a preview `wrangler deploy`) — they were written without a local Node.js runtime available and have not been executed.
2. Rotate the exposed Meta App Secret, then update the Cloudflare secret; delete the now-unused `META_SETUP_KEY` secret.
3. Add explicit token metadata/health monitoring and an admin-only credential rotation screen.
4. Add password reset, email verification, and a workspace-switching UI (a user invited to a second workspace is only attached to it in the database today; login always resolves to their Owner workspace).
5. Convert Inbox polling to realtime delivery now that the authentication model is in place.
6. Add database-backed contacts, conversation assignment, resolution, notes, and message attachments (currently only WhatsApp message history is D1-backed; contact metadata is still per-browser).
7. Connect AI assistant execution to an approved model provider with retrieval, action security, audit logs, and human handoff.
8. Implement real Instagram OAuth/webhooks, campaign template management, audience consent records, and scheduled delivery workers (bulk campaign "sends" are still simulated — Meta also requires approved message templates for outbound marketing sends outside the 24-hour customer-service window).
9. Complete Meta Business Verification, App Review, Advanced Access, and Embedded Signup production onboarding.
10. Wire up real billing (e.g. Stripe) if/when this needs to charge real customers; today's billing UI is fully simulated by design.

## Definition of production readiness

Authenticated accounts and per-workspace data isolation now exist, but do not call the product production-ready until it also has: authorization audited on every customer-data endpoint, durable job processing, credential rotation, monitoring, backups, rate limiting, abuse controls, audit logs, password reset/email verification, and completed Meta approvals.
