# Qpy Engage

Qpy Engage is a customer-engagement SaaS application for WhatsApp Cloud API, Instagram, web chat, AI assistants, campaigns, automations, knowledge sources, analytics, team management, and billing.

## Links

- Live application: https://mobileecommerce.github.io/qpy-engage/
- Repository: https://github.com/mobileecommerce/qpy-engage
- Active development branch: `agent/publish-github-pages`
- Cloudflare API: https://qpy-engage-api.qpy-engage.workers.dev
- WhatsApp webhook: https://qpy-engage-api.qpy-engage.workers.dev/api/webhooks/whatsapp

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Validation:

```bash
npm run build
NEXT_PUBLIC_BASE_PATH=/qpy-engage npm run build:pages
```

The first command validates the Cloudflare/vinext application. The second creates the static GitHub Pages output in `out/`.

## Architecture

- `app/page.tsx`: main Qpy Engage application and product workflows
- `app/globals.css`: shared application styles
- `app/live-inbox.css`: live WhatsApp Inbox styles
- `worker/meta.ts`: Meta OAuth, manual Cloud API connection, encrypted token storage, webhooks, Inbox, and message sending
- `worker/index.ts`: Cloudflare Worker entry point
- `db/schema.ts` and `drizzle/`: Cloudflare D1 schema and migrations
- `wrangler.jsonc`: production Worker and D1 configuration
- `app/privacy`, `app/terms`, `app/data-deletion`: public Meta compliance pages

Secrets are managed in Cloudflare and must never be committed. See [HANDOFF.md](HANDOFF.md) for current status, deployment instructions, and remaining work.
