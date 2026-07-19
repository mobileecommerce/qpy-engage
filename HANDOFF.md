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

**Do not skip step 1.** `wrangler.jsonc`'s `main` points at `dist/server/index.js` — a bundled build artifact, not the `worker/*.ts` source directly. `npx wrangler deploy` will happily deploy whatever is currently sitting in `dist/`, even if it predates your latest edits — `wrangler deploy` reports "success" either way, so a stale deploy is silent, not an error. `npx tsc --noEmit` on its own only type-checks; it does **not** regenerate `dist/`. A real incident on 2026-07-19: several worker/*.ts fixes in a row were deployed using only `tsc --noEmit` before `wrangler deploy`, so `dist/server/index.js` silently went stale — the fixes were never actually live for a while, even though each deploy "succeeded" and initial verification looked plausible (the underlying bugs were non-deterministic enough that testing stale code sometimes returned clean-looking results by chance). Always run the full `npm run build` immediately before `npx wrangler deploy` for any worker change, and prefer verifying post-deploy against a distinctive value (e.g. checking `grep -c '<function-name>' dist/server/index.js` matches, or checking the actual persisted/returned value in production) rather than trusting a "Deployed" message alone.

## Recommended next work

Done: real authentication, per-workspace data isolation, role-based access for team/WhatsApp management, real AI assistant replies (text + in-browser voice, with real voice selection, transcript toggle, max-duration auto-end, and interrupt/barge-in) via Anthropic Claude, real website knowledge ingestion (with real pasted-content sources for Document/FAQ, and a Browser Rendering fallback for JS-rendered sites — see below), a real public web chat widget with customizable icon/placement/effect/accent color (Channels > Web chat) plus a real configured assistant name/greeting shown in the widget header and "X is typing…" label, whose conversations are now persisted, viewable, and can be manually taken over by a human agent in Inbox > Web chat (AI pauses automatically once taken over, the visitor sees a system notice when handed off either direction, polling delivers the agent's replies back to the visitor's browser, with real typing indicators for both the AI and a typing human agent — dashboard also polls live so new visitor messages appear without a manual refresh, the AI automatically answers any message left unanswered when control is handed back to it, and automatically sends a brief holding message if a human hasn't replied within 5 minutes), real "AI Actions" execution (Claude tool-use actually calls the configured webhook, both in Test Studio and the public widget) with captured-lead storage that merges repeated captures within the same conversation into one progressively-completed record instead of duplicating (new "Leads" page), and an honest new-account experience — see "Authentication and multi-tenancy" and "AI assistant" above.

**Widget chat-window customization status:** icon (built-in or custom upload), launcher placement, launcher effect, accent color, assistant name, and greeting message are all real and configurable today (Channels > Web chat, plus Assistants > Profile for name/greeting). Not yet customizable: panel dimensions, fonts, header background color (separate from the accent color), or the "AI assistant"/"Type a message…" static label text — flagged as open follow-up, not yet built since scope wasn't confirmed.

**Widget session persistence:** `public/widget.js` keeps its `sessionId` in `sessionStorage` (per workspace), and a public `GET /api/widget/history` endpoint rebuilds the visible transcript on load — so a visitor refreshing the page (same tab) resumes their conversation instead of starting a new one. The session still resets if the visitor closes the tab or opens a new one (sessionStorage, not localStorage) — that's intentional, matching what was asked.

**Customer naming in Web chat inbox:** once a name is known for a session — either an AI Action explicitly capturing a `name`/`full_name`/`customer_name`/`first_name` field (`action_submissions`), or Claude passively noticing it in conversation via a built-in `record_customer_name` tool that's always available regardless of configured AI Actions (`callClaudeWithActions` in worker/shared.ts, stored on `widget_conversation_state.customer_name`) — `GET /api/widget/conversations` returns it as `customerName`, and the Web chat inbox list/detail header show it instead of "Website visitor". An explicit AI Action capture takes priority over the passively-learned name if both exist. Falls back to "Website visitor" until either fires.

**Internal notes on Web chat conversations:** Inbox > Web chat now has a notes panel beside the conversation (`widget_notes` table, `GET/POST /api/widget/notes`, session-authenticated) — team members can leave notes visible only to the dashboard (never the visitor), each tagged with the real author name/email from their session.

**Lead tagging (Source/Status/Priority/Segment):** the Leads page has a filter bar and per-lead dropdown editors for Source (Website/Referral/Event), Status (New/Contacted/Qualified/Nurture/Closed-Lost, defaults to "New" which also drives the "New" badge), Priority (Hot/Warm/Cold), and Segment (Enterprise/SMB) — new columns on `action_submissions`, updated via `PATCH /api/leads/:id` (worker/leads.ts), with server-side validation against the allowed values for each field. The same tags/badge are also surfaced in Inbox > Web chat: the conversation list shows the "New" badge next to a visitor's name when their associated lead's status is "New" (`GET /api/widget/conversations` joins lead status via `getLeadStatuses` in worker/widget.ts), and the conversation detail's right panel has a "Lead details" section (above Internal notes) showing the captured data plus the same four tag dropdowns, reusing `GET /api/leads?sessionId=` (new optional filter) and the existing `PATCH /api/leads/:id`.

**Human escalation, business hours, and honest sidebar/header state (2026-07-19):**
- **Business hours**: Channels > Web chat has a "Business hours" editor (disabled by default) — per-day open/closed + start/end time, plus a timezone select. Stored via `qpy-engage-working-hours` workspace state. `computeBusinessHoursStatus()` in worker/widget.ts computes real open/closed status server-side at request time (in the business's own timezone) and injects it into the system prompt, so the AI can honestly say it's outside business hours instead of implying an instant reply.
- **Human escalation**: a built-in `flag_for_human` tool (worker/shared.ts, parallel to `record_customer_name`) that's always available regardless of configured AI Actions. System prompt instructs the AI to try to help first when a customer asks for a human, and only call the tool if they explicitly insist afterward — not a keyword trigger, an actual two-step conversational judgment call by the model. Sets `widget_conversation_state.needs_attention` + a reason, surfaced as a red "Needs you" badge in the Web chat inbox list and detail header; taking over a flagged conversation clears it (that's the acknowledgment).
- **Widget header subtitle**: previously hardcoded "AI assistant" even after a human took over. `GET /api/widget/poll`, `/history`, and the takeover response now report `aiActive`; `public/widget.js` updates the header subtitle to "Our team" once a human has the conversation.
- **Sidebar Inbox badge**: was hardcoded/derived from stale legacy mock data (always showed "4"). Now a real count of conversations (WhatsApp + Web chat) whose last message is from the customer, i.e. awaiting a reply — computed by lifting the existing summary-polling hooks up to the `Workspace` component.

Verified end-to-end: a throwaway workspace with working hours forced to always-closed correctly got the AI to mention being outside business hours on the first "can I speak to a human" ask while still trying to help, then correctly called `flag_for_human` only on the third clearly-insistent turn (not the first or second) — confirmed via the `needs_attention`/`attention_reason` columns and the `/api/widget/conversations` response. Header subtitle change confirmed live on the real qpy.ai widget (simulated a takeover via a direct DB write, sent a message, watched "AI assistant" become "Our team" in the same poll cycle). Sidebar badge confirmed showing a real "1" instead of the old hardcoded "4" on the smoketest workspace.

**Widget duplicate replies and Markdown leakage (fixed 2026-07-19):** two separate real bugs reported by the user from a live qpy.ai conversation. (1) The AI's reply could appear twice in the widget: a poll tick could land in the window between the server saving the reply and the in-flight `respond()` call receiving it client-side, so both paths appended the same message. Fixed in `public/widget.js`'s `pollForReplies` by re-checking each incoming message's timestamp against the *current* `lastSeenAt` at processing time (not the value the request was sent with), which catches the race regardless of which side resolves first. (2) Claude's replies sometimes contained raw Markdown (`**bold**`, `- bullet`, `1. numbered`) since this widget only renders plain text — those showed up as literal asterisks/dashes to the customer. The system prompt now explicitly forbids Markdown with a right/wrong example, but that alone wasn't consistently followed (especially for prompts that invite a list-style answer), so `sanitizeWidgetReply()` in `worker/widget.ts` strips bold/italic/code/list/heading markers server-side before a reply is ever stored or returned — a guaranteed backstop rather than relying on the model's compliance. Deliberately scoped to the widget only: WhatsApp has its own real `*bold*`/`_italic_` syntax that must never be touched by this. `public/widget.js`'s message CSS also gained `white-space:pre-line` so paragraph breaks the model does write render as actual line breaks instead of collapsing.

**AI Actions never expose webhook failures to the customer (fixed 2026-07-19):** when a "submit"-type action's configured webhook fails (wrong/unreachable endpoint, timeout, non-2xx), `callClaudeWithActions` (worker/shared.ts) used to feed the raw diagnostic text ("Could not reach the business system for this action...") into the tool_result Claude sees — the model then improvised on top of it, e.g. telling a real qpy.ai customer "I'm having a technical hiccup... please also email praveen@qpy.ai". Fixed: since a submit action's data is already saved locally as a safety net regardless of webhook outcome (see "Leads" below), a failed submit is now reported to the model as a clean success with an explicit instruction not to mention any system/process/issue — genuinely true from the customer's perspective, since their info really was captured. A failed "request"-type action (no local fallback data exists, e.g. "Check order status") still reports failure, but only the business's own configured `defaultResponse` message, with an explicit instruction to add no technical detail or invented workaround. `testAction()`'s full diagnostic text is untouched and still shown on the dashboard's "Test" button — this fix only changes what reaches the model in a live customer conversation. Verified with several repeated live calls against a deliberately broken endpoint; the qpy.ai workspace's "Capture qualified lead" action itself is still pointed at the leftover fake `api.atelierhome.com/leads` placeholder from before this account existed — that's a separate, still-open item (see below), independent of this messaging fix.

**Known dashboard bug fixed 2026-07-19:** persisting the active section (`qpy-engage-last-section::ws:<id>` in localStorage, so a refresh stays on the tab you were viewing instead of bouncing to Overview) initially caused a real crash on refresh when the restored section was Inbox — `useStoredState("qpy-engage-whatsapp-connected", false)` always starts at its `false` default before its async fetch resolves, and restoring straight into Inbox let it briefly render the legacy mock inbox against that default, then flip to `LiveInbox` mid-mount when the real value resolved, which crashed. Fixed by having `useStoredState` also return a `loaded` flag and only restoring the persisted section once `connected` has actually resolved (`Workspace` in app/page.tsx) — always boots into Overview first, silently switches to the last-viewed section a moment later. Reproduced and confirmed fixed via repeated real refreshes on the live site before shipping.

**Unified Inbox tabs:** `InboxHub` now shows a dynamic tab set instead of a fixed WhatsApp/Web chat switcher — a channel's tab (WhatsApp, Instagram, Web chat) only appears once it has at least one real conversation, and an "All" tab (a merged, recency-sorted list across channels, each row tagged by channel) only appears once 2+ channels have conversations. Instagram has no real messaging backend yet, so its count is always 0 and its tab stays hidden until that's built — deliberately not faked.

1. Add `ANTHROPIC_API_KEY` as a Cloudflare secret if it isn't set yet — without it the assistant endpoint returns a clear "not configured" error.
1a. **To fully fix knowledge ingestion for JavaScript-rendered websites (e.g. qpy.ai itself — a Vite/React SPA)**, set `CLOUDFLARE_BROWSER_RENDERING_TOKEN` as a Cloudflare Worker secret:
   - Create a Cloudflare API Token at https://dash.cloudflare.com/profile/api-tokens with **Account > Browser Rendering > Edit** permission (scoped to account `e8c99985a9f6a0ea4388241d964db68d`, already set as `CLOUDFLARE_ACCOUNT_ID` in `wrangler.jsonc`).
   - Run `npx wrangler secret put CLOUDFLARE_BROWSER_RENDERING_TOKEN` (name only — wrangler prompts separately for the value; never paste the raw token in chat).
   - Without this secret, website fetching safely falls back to its existing title/meta-description-only behavior — no breakage, just thinner content for SPAs until this is set.
   - Until then (or as a same-day alternative that works for any site), you can add real content immediately via **Knowledge > Add source > Document or FAQ**, which now has a real paste-content textarea — reliable regardless of how the source site is built, since it doesn't depend on fetching/rendering anything.
2. **New-account demo-content issue — fixed 2026-07-19:**
   - `useStoredState`'s localStorage cache was global to the browser, not scoped per workspace — signing into a new account on a browser that had used another account would leak that account's cached settings into the new one, and then write them back to its real server state. Now scoped by `${key}::ws:${workspaceId}`.
   - New workspaces no longer inherit the hardcoded "Atelier Home" demo persona (fake conversations/automations/knowledge sources, 2 sample AI actions pointing at a fake `api.atelierhome.com` domain, an assistant addressed as "Atelier Home's concierge"). Defaults are now derived from the real signed-up workspace name, and start empty otherwise. Overview's setup checklist and greeting now reflect real state (real user/workspace name, real knowledge-source count, real assistant-published flag) instead of hardcoded fake copy shown as complete for every account. Metric cards show a real conversation count and honestly mark resolution rate/response time/revenue as "—" (no analytics pipeline exists yet to back those) instead of inventing numbers. Verified live with a fresh throwaway signup (`riley.honesttest+*@example.com` — safe to delete, no real data).
   - The deeper Analytics page (chart bars, resolution-mix donut, per-automation completion %) still has hardcoded illustrative numbers — out of scope for this pass, would need a real analytics/reporting backend.
   - Any account created **before** this fix may have real server-side state already polluted with another workspace's cached settings — check with the user which account(s) this affected if they report stale data on an existing account.
2b. **Still open**: the real qpy.ai workspace's "Capture qualified lead" AI Action is still configured with the leftover fake `https://api.atelierhome.com/leads` endpoint (predates this account, from before the honest-defaults fix above). Every real submission still fails at the webhook step — captured leads are safe (see the Leads section above, and the tool-result sanitization fix, which stops the AI from telling the customer about this), but the business never gets an external notification until this is pointed at a real endpoint (Assistants > AI actions > Edit) or the webhook call is disabled for that action.
3. Rotate the exposed Meta App Secret, then update the Cloudflare secret; delete the now-unused `META_SETUP_KEY` secret.
4. Add explicit token metadata/health monitoring and an admin-only credential rotation screen.
5. Add password reset, email verification, and a workspace-switching UI (a user invited to a second workspace is only attached to it in the database today; login always resolves to their Owner workspace). Also add a way to rename a workspace / change an account's email — needed right now since the live "default" workspace is owned by a smoke-test account.
6. Convert Inbox polling to realtime delivery now that the authentication model is in place.
7. Add database-backed contacts, conversation assignment, resolution, notes, and message attachments (currently only WhatsApp message history is D1-backed; contact metadata is still per-browser).
8. If real inbound phone calls are wanted: set up a telephony provider account (e.g. Twilio), then build per-workspace phone number provisioning and webhook-driven call handling into the same Anthropic-backed assistant endpoint.
9. Implement real Instagram OAuth/webhooks, campaign template management, audience consent records, and scheduled delivery workers (bulk campaign "sends" are still simulated — Meta also requires approved message templates for outbound marketing sends outside the 24-hour customer-service window).
10. Complete Meta Business Verification, App Review, Advanced Access, and Embedded Signup production onboarding.
11. Wire up real billing (e.g. Stripe) if/when this needs to charge real customers; today's billing UI is fully simulated by design.

## Definition of production readiness

Authenticated accounts and per-workspace data isolation now exist, but do not call the product production-ready until it also has: authorization audited on every customer-data endpoint, durable job processing, credential rotation, monitoring, backups, rate limiting, abuse controls, audit logs, password reset/email verification, and completed Meta approvals.
