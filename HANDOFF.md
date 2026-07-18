# Qpy Engage engineering handoff

Updated: July 18, 2026

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

These product areas persist primarily in browser storage on GitHub Pages. They are interactive but are not yet backed by production services. Instagram is currently a sandbox/demo connection. AI responses are product simulations rather than calls to a production model.

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
- `META_SETUP_KEY`
- `META_WEBHOOK_VERIFY_TOKEN`
- Meta user or system-user access tokens

They are stored as Cloudflare Worker secrets. The Meta App Secret and workspace setup key were shared in the prior private development conversation. Rotate both before production. When rotating the app secret, update the Cloudflare secret immediately so webhook signature validation and `appsecret_proof` continue to work.

Expected Cloudflare values:

- Non-secret vars in `wrangler.jsonc`: `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION`
- Secrets: `META_APP_SECRET`, `META_TOKEN_ENCRYPTION_KEY`, `META_SETUP_KEY`, `META_WEBHOOK_VERIFY_TOKEN`

## Backend API map

- `GET /api/meta/config`: public non-secret Meta configuration
- `GET /api/meta/status`: public sanitized connection status
- `POST /api/meta/oauth/exchange`: Embedded Signup code exchange; protected by workspace key
- `POST /api/meta/manual/connect`: manual/system-user token connection; protected by workspace key
- `GET /api/meta/inbox`: live stored messages; protected by workspace key
- `POST /api/meta/inbox/messages`: send live WhatsApp reply; protected by workspace key
- `POST /api/meta/test-message`: send approved test template; protected by workspace key
- `DELETE /api/meta/connection`: disconnect; protected by workspace key
- `GET|POST /api/webhooks/whatsapp`: Meta challenge and signed webhook delivery

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

1. Create and install a permanent Meta System User Access Token; verify outbound Inbox replies.
2. Rotate the exposed Meta App Secret and Qpy workspace setup key, then update Cloudflare secrets.
3. Add explicit token metadata/health monitoring and an admin-only credential rotation screen.
4. Add real authentication and multi-tenant workspace isolation. The current backend uses a single `default` workspace.
5. Replace the shared workspace-key model with authenticated user sessions and role-based access.
6. Convert Inbox polling to realtime delivery when the authentication model is in place.
7. Add database-backed contacts, conversation assignment, resolution, notes, and message attachments.
8. Connect AI assistant execution to an approved model provider with retrieval, action security, audit logs, and human handoff.
9. Implement real Instagram OAuth/webhooks, campaign template management, audience consent records, and scheduled delivery workers.
10. Complete Meta Business Verification, App Review, Advanced Access, and Embedded Signup production onboarding.

## Definition of production readiness

Do not call the current product multi-tenant production-ready until it has authenticated accounts, per-workspace data isolation, authorization on every customer-data endpoint, durable job processing, credential rotation, monitoring, backups, rate limiting, abuse controls, audit logs, and completed Meta approvals.
