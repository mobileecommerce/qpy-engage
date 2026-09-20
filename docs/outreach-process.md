# Daily outreach process

A solo-founder routine that runs itself: every night the app pulls new local
businesses per sector from Google Maps, finds a contact email on their website,
and every morning it sends a short introduction to a capped number of them,
then a single follow-up a few days later. Replies and opt-outs stop the
automation for that business, so a person only ever hears from you a couple of
times, never every day.

```
 03:30 IST  discover ─▶ Google Places Text Search (per sector)
                        ├─ new place?  → insert lead (name, address, phone, website)
                        └─ enrich      → read website → email → status: ready / unreachable

 09:00 IST  send     ─▶ pick up to OUTREACH_DAILY_SEND_CAP leads that are due
                        ├─ first touch: WhatsApp template (if phone) else email
                        ├─ follow-up after OUTREACH_FOLLOW_UP_DAYS on the other channel
                        └─ stop after OUTREACH_MAX_TOUCHES, on reply, or on opt-out

 any time   inbound  ─▶ WhatsApp webhook: reply → status "replied" (you take over)
                                          "STOP" → opt-out list
                        Email: List-Unsubscribe header + signed unsubscribe link
```

## Why the API instead of scraping Google Maps

Scraping maps.google.com breaks Google's Terms of Service, gets your IP and
account blocked, and stops working whenever Google changes its HTML. The
official **Places API (New)** returns the same fields (name, address,
coordinates, phone, website, rating) as structured JSON, with a free monthly
credit that covers a few thousand lookups. Google never publishes email
addresses, so emails come from the business's own website instead.

## Why not message the same people every day

Messaging the same business daily is spam. WhatsApp measures quality on every
business number and will restrict, then ban, a number that gets blocked or
reported. Email providers do the same with your domain reputation. The
pipeline therefore contacts **new** businesses every morning and touches each
one at most `OUTREACH_MAX_TOUCHES` times (default 2), spaced
`OUTREACH_FOLLOW_UP_DAYS` apart (default 4). The daily volume comes from
discovering fresh leads, not from re-messaging old ones.

Legal notes to keep in mind (not legal advice):

- **WhatsApp**: business-initiated messages to numbers that never wrote to you
  must use a Meta-approved template in the *Marketing* category. Meta's
  Business Messaging Policy requires that you have a lawful basis to contact
  the person and honour opt-outs. Start with a low cap (25–50/day). New numbers
  are limited to 250 unique contacts per 24 hours and grow with good quality.
- **Email (B2B cold email)**: include your real identity, a working
  unsubscribe, and stop when asked. The pipeline adds a signed unsubscribe
  link and `List-Unsubscribe` headers to every email.
- **India**: TRAI's DND rules apply to SMS/voice telemarketing. WhatsApp is
  governed by Meta's policy rather than TRAI, but keep messaging strictly
  business-to-business and honour "STOP" immediately, which the webhook does.
- **EU/UK contacts**: GDPR/PECR apply; only use the pipeline for corporate
  addresses and keep the "legitimate interest" B2B framing.

## One-time setup

1. **Database.** `.openai/hosting.json` now declares the `DB` D1 binding.
   Apply `drizzle/0000_outreach.sql` to the database (the build copies the
   `drizzle/` folder into `dist/.openai/` for hosts that apply migrations
   automatically; otherwise run it with `wrangler d1 execute <db> --file
   drizzle/0000_outreach.sql`).
2. **Secrets.** Copy `.env.example` to `.env` locally and set the same names
   as secrets on your host. At minimum: `OUTREACH_ADMIN_TOKEN`,
   `OUTREACH_PUBLIC_ORIGIN`, `GOOGLE_MAPS_API_KEY`, and one channel.
3. **Google.** Google Cloud Console → enable *Places API (New)* → create an
   API key restricted to that API → `GOOGLE_MAPS_API_KEY`.
4. **WhatsApp.** Meta for Developers → create an app → WhatsApp → API Setup.
   Copy the permanent access token and Phone Number ID. In WhatsApp Manager
   create a *Marketing* template such as:

   > Hi {{1}} team 👋 I'm Praveen, founder of Wavely. We help local businesses
   > answer WhatsApp enquiries automatically so no customer waits after hours.
   > Would a 10-minute demo be useful? Reply YES and I'll send times, or STOP
   > to opt out.

   Set `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` and
   `WHATSAPP_TEMPLATE_PARAMS=business_name`. Then register the webhook URL
   `https://<your-origin>/api/webhooks/whatsapp` with the verify token from
   `WHATSAPP_VERIFY_TOKEN` and subscribe to the `messages` field.
5. **Email.** Create a Resend account, verify your sending domain, set
   `RESEND_API_KEY` and `OUTREACH_FROM_EMAIL`. Send from a subdomain
   (e.g. `hello@mail.yourdomain.com`) so cold email never hurts your main
   domain's reputation.
6. **Sectors.** Edit `outreach/sectors.example.json` (copy to
   `outreach/sectors.json`, which you can commit or keep private) and upload:

   ```bash
   export OUTREACH_BASE_URL=https://your-app.example.com
   export OUTREACH_ADMIN_TOKEN=...
   node scripts/outreach-run.mjs sectors outreach/sectors.json
   ```

   Each sector is one Google search (`searchQuery`), a city, an optional
   WhatsApp template override, and the email subject/body with
   `{{business_name}}`, `{{city}}`, `{{sector}}` placeholders.

7. **Schedule.** Two options, use whichever your host supports:
   - **Cloudflare Cron Triggers** are declared in `vite.config.ts`
     (`triggers.crons`) and handled by `scheduled()` in `worker/index.ts`.
   - **GitHub Actions**: `.github/workflows/daily-outreach.yml` calls the
     admin API on the same schedule. Add `OUTREACH_BASE_URL` and
     `OUTREACH_ADMIN_TOKEN` as repository secrets. You can also trigger it by
     hand from the Actions tab with a chosen step.

   Times are 22:00 UTC (03:30 IST) for discovery and 03:30 UTC (09:00 IST)
   for sending. Change both places together if you want a different hour.

## First week: run it in dry-run mode

Set `OUTREACH_DRY_RUN=true`. Discovery runs for real (it only reads), but the
morning send records what it *would* have sent as `dry_run` messages and calls
no provider. Check the output, tune the sectors and copy, then switch the flag
off.

```bash
node scripts/outreach-run.mjs discover     # pull leads now
node scripts/outreach-run.mjs send         # dry-run the morning batch
node scripts/outreach-run.mjs stats        # counts by status, recent runs
node scripts/outreach-run.mjs leads "status=ready&limit=20"
node scripts/outreach-run.mjs opt-out 919876543210
```

## Your 10-minute morning routine

1. Open `stats`: how many sent today, how many replied.
2. Pull `leads "status=replied"` and answer each reply personally on WhatsApp
   or email. The pipeline has already stopped automation for them.
3. Glance at `errors` in the last run. A burst of WhatsApp `131026`
   (undeliverable) or `130472` (user not opted in / experiment) means the
   phone data for a sector is weak; a `131049`/quality error means slow down
   and lower `OUTREACH_DAILY_SEND_CAP`.
4. Once a week, add or pause sectors with another `sectors` upload
   (`"enabled": false` keeps the leads but skips the sector).

## Lead lifecycle

| status        | meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `new`         | Discovered, email lookup pending (at most 2 attempts)       |
| `ready`       | Has a phone and/or email, waiting for the next morning run  |
| `contacted`   | First message sent, follow-up scheduled                     |
| `replied`     | They answered. Automation stops, you take over              |
| `opted_out`   | They said STOP or unsubscribed. Never contacted again       |
| `exhausted`   | Max touches reached without a reply                         |
| `unreachable` | No phone and no email found, or 3 provider failures         |

## Files

- `db/schema.ts`, `drizzle/0000_outreach.sql`: tables `sectors`, `leads`,
  `outreach_messages`, `opt_outs`, `run_logs`.
- `lib/outreach/places.ts`: Google Places Text Search client.
- `lib/outreach/enrich.ts`: find an email on a business website.
- `lib/outreach/whatsapp.ts`, `lib/outreach/email.ts`: senders and webhook parsing.
- `lib/outreach/pipeline.ts`: the daily steps and reply/opt-out handling.
- `lib/outreach/routes.ts`: HTTP routes; `worker/index.ts`: cron entry point.
- `scripts/outreach-run.mjs`: CLI to trigger steps from anywhere.
- `tests/outreach/`: unit tests (`npm run test:outreach`).
