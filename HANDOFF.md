# Qpy Engage engineering handoff

Updated: July 18, 2026 (real authentication, per-workspace isolation, and a real AI assistant provider are all live in production now — read "Authentication" and "AI assistant" below before assuming this is still a demo-only app)

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

- Real user accounts, sessions, and per-workspace data isolation (see "Authentication and multi-tenancy")
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
- Real AI assistant replies (text and voice) through Anthropic Claude — see "AI assistant" below

### Implemented primarily as browser-product functionality

- AI assistant builder UI: instructions, actions, voice configuration, governance, and publishing steps are all real inputs, but there's no real knowledge retrieval (see "AI assistant" below) and AI actions (webhooks) aren't actually called yet
- Campaign builder, audience import, image attachment, scheduling, and campaign records
- Automation builder and templates
- Team and subscription management UI (team membership is real — see auth section; subscription/billing is not)
- Analytics and exports
- Web-chat widget setup

These product areas persist per-workspace through `/api/state` now that real accounts exist (see below), so they sync across devices/browsers for the same signed-in account, but most are still interactive simulations, not calls to production services. Instagram is currently a sandbox/demo connection. Campaign "sends" and billing are simulated; no bulk WhatsApp/Instagram broadcast API or payment processor is wired up.

## AI assistant

Real text and voice replies were added on top of the existing Assistant builder UI, via `worker/assistant.ts`:

- `POST /api/assistant/respond` (session-authenticated) sends a system prompt + conversation history to Anthropic's Messages API (`claude-sonnet-5`) and returns the reply.
- The frontend composes the system prompt from the assistant's actual configured role/instructions, tone, fallback/handoff policy, restricted topics, and the *names* of connected knowledge sources — not their content. **There is no real retrieval/RAG**: no document content is ever extracted or indexed anywhere in this codebase; "Knowledge sources" are just metadata (name/type/page count). The prompt explicitly tells the model not to invent specific facts attributed to sources it wasn't actually given, but it also can't answer from real business content until real ingestion is built.
- Test Studio → Chat simulation calls this for real replies.
- Test Studio → Voice call now does a genuine listen → think → speak loop entirely in the browser: the Web Speech API's `SpeechRecognition` (Chrome/Edge only — not supported in Safari/Firefox) transcribes what the tester says, sends it through the same assistant endpoint, and speaks the reply with `SpeechSynthesis`, with a live transcript shown during the call.
- **Requires `ANTHROPIC_API_KEY` as a Cloudflare Worker secret** (`npx wrangler secret put ANTHROPIC_API_KEY`) to actually generate replies; without it the endpoint returns a clear 503 "not configured" error rather than failing silently or faking a response.
- AI actions (the webhook-calling "AI actions" builder) are still not actually invoked by real conversations — `testAction()` still just marks a canned "Passed" without calling the configured endpoint.
- **Real inbound phone calls are a separate, much bigger project**: they need a telephony provider account (e.g. Twilio) that you create yourself, a real phone number per workspace (provisioned via that provider's API), and webhook-driven call handling — none of that exists yet. The realistic path for customers to use their *existing* business number is call forwarding (conditional or always) to a number provisioned through that provider, not porting.

## Authentication and multi-tenancy

Real accounts replaced the single shared `default` workspace and the `x-qpy-setup-key` model:

- `worker/auth.ts` implements signup/login/logout, PBKDF2 password hashing, and bearer session tokens (`sessions` table, 30-day expiry). No new secret is required — session tokens are self-contained.
- New D1 tables: `users`, `workspaces`, `workspace_members`, `sessions`. `whatsapp_messages` gained a `workspace_id` column. All are created idempotently at request time (see `ensureAuthSchema` / `ensureMetaSchema`) the same way the existing WhatsApp tables are, so no manual migration step is required to deploy this.
- Every `/api/meta/*` endpoint (except `config`, which is server-level non-tenant config) now requires a valid `Authorization: Bearer <token>` session instead of the old shared setup key. Connecting/disconnecting WhatsApp requires the `Owner` or `Admin` role.
- `/api/state` is now namespaced per authenticated workspace (`${workspaceId}::${key}` internally) instead of being a single global keyspace anyone could read or write.
- **First-signup migration**: when the very first user account is created, if a legacy `whatsapp_connections` row still exists under the old hardcoded workspace id `"default"`, that workspace id (and any `whatsapp_messages` rows with a null `workspace_id`) are adopted by that user's new workspace, so the already-connected WhatsApp number keeps working under the first real account. Every signup after that gets its own fresh workspace.
- The frontend now gates the whole app behind login/signup (`app/page.tsx`'s `AuthGate`/`Home`/`Workspace` split). The bearer token lives in `localStorage` (`qpy-engage-auth-token`) and is attached via an `AuthTokenContext` used by `useStoredState`, `Channels`, `LiveInbox`, and the new `useWorkspaceMembers` hook (Team page — invite/role/remove now hit real `/api/workspace/members` endpoints instead of local mock state).
- Role gating so far is minimal: Team invite/role-change/remove and WhatsApp connect/disconnect require Owner/Admin (enforced server-side); other pages don't yet differentiate by role.

**Verified**: Node.js was set up in the building session (there wasn't any initially), `npm run build` / `npm run build:pages` / `npx tsc --noEmit` all pass, and this has been deployed to production and click-tested end to end (signup, WhatsApp connection carrying over, live Inbox). One migration-ordering bug was found and fixed in production (see commit history) — a first-signup's legacy-workspace-claim could run before the `whatsapp_messages.workspace_id` column existed; `auth.ts` now adds that column itself before using it, so it's no longer order-dependent.

**Not yet done**: there is no "forgot password," email verification, or workspace-switching UI (a user invited to a second workspace only gets attached to it in the database, with login always resolving to their `Owner` workspace first). The account that currently owns the live "default" workspace is a smoke-test account created during deploy verification (`smoketest+deploycheck@example.com`) — the real user chose to keep using it rather than have it cleaned up, so there's no admin UI yet to rename a workspace or change an account's email/password.

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
- `POST /api/assistant/respond`: real AI assistant reply via Anthropic Claude; requires a session and `ANTHROPIC_API_KEY`

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

Done: real authentication, per-workspace data isolation, role-based access for team/WhatsApp management, and real AI assistant replies (text + in-browser voice) via Anthropic Claude — see "Authentication and multi-tenancy" and "AI assistant" above.

1. Add `ANTHROPIC_API_KEY` as a Cloudflare secret if it isn't set yet — without it the assistant endpoint returns a clear "not configured" error.
2. Build real knowledge retrieval: actually extract and index content from connected sources (website/document/FAQ) and pass relevant chunks into the assistant's system prompt. Right now the model only ever sees source *names*, not content.
3. Wire "AI actions" (the webhook builder) to actually call the configured endpoint during a real conversation and during `testAction()`, instead of always reporting a canned "Passed."
4. Rotate the exposed Meta App Secret, then update the Cloudflare secret; delete the now-unused `META_SETUP_KEY` secret.
5. Add explicit token metadata/health monitoring and an admin-only credential rotation screen.
6. Add password reset, email verification, and a workspace-switching UI (a user invited to a second workspace is only attached to it in the database today; login always resolves to their Owner workspace). Also add a way to rename a workspace / change an account's email — needed right now since the live "default" workspace is owned by a smoke-test account.
7. Convert Inbox polling to realtime delivery now that the authentication model is in place.
8. Add database-backed contacts, conversation assignment, resolution, notes, and message attachments (currently only WhatsApp message history is D1-backed; contact metadata is still per-browser).
9. If real inbound phone calls are wanted: set up a telephony provider account (e.g. Twilio), then build per-workspace phone number provisioning and webhook-driven call handling into the same Anthropic-backed assistant endpoint.
10. Implement real Instagram OAuth/webhooks, campaign template management, audience consent records, and scheduled delivery workers (bulk campaign "sends" are still simulated — Meta also requires approved message templates for outbound marketing sends outside the 24-hour customer-service window).
11. Complete Meta Business Verification, App Review, Advanced Access, and Embedded Signup production onboarding.
12. Wire up real billing (e.g. Stripe) if/when this needs to charge real customers; today's billing UI is fully simulated by design.

## Definition of production readiness

Authenticated accounts and per-workspace data isolation now exist, but do not call the product production-ready until it also has: authorization audited on every customer-data endpoint, durable job processing, credential rotation, monitoring, backups, rate limiting, abuse controls, audit logs, password reset/email verification, and completed Meta approvals.
