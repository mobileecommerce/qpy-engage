import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { leads, optOuts, outreachMessages, runLogs, sectors, type Lead, type MessageChannel, type NewSector, type Sector } from "../../db/schema";
import { addDays, nowIso, readSettings, type OutreachEnv, type OutreachSettings } from "./config";
import { emailConfigured, sendEmail } from "./email";
import { findEmailOnWebsite } from "./enrich";
import { toE164Digits } from "./phone";
import { searchPlaces } from "./places";
import { unsubscribeUrl } from "./signing";
import { buildContext, isOptOutText, renderTemplate, templateParams } from "./template";
import { parseWebhook, sendWhatsAppTemplate, whatsappConfigured } from "./whatsapp";

export type OutreachDb = DrizzleD1Database<typeof schema>;

export function getOutreachDb(env: OutreachEnv): OutreachDb {
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable. Set `d1` to \"DB\" in .openai/hosting.json and run the migrations in ./drizzle.");
  }
  return drizzle(env.DB, { schema });
}

function signingSecret(env: OutreachEnv): string {
  const secret = env.OUTREACH_SIGNING_SECRET ?? env.OUTREACH_ADMIN_TOKEN;
  if (!secret) throw new Error("Set OUTREACH_SIGNING_SECRET (or OUTREACH_ADMIN_TOKEN) so unsubscribe links can be signed.");
  return secret;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* Sectors                                                              */
/* ------------------------------------------------------------------ */

export interface SectorInput {
  slug: string;
  name: string;
  searchQuery: string;
  city?: string | null;
  regionCode?: string | null;
  whatsappTemplate?: string | null;
  emailSubject?: string | null;
  emailBody?: string | null;
  enabled?: boolean;
  maxNewLeadsPerRun?: number;
}

export function validateSectorInput(input: unknown): SectorInput {
  const s = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string).trim() : "");
  const slug = str("slug").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error(`Invalid slug "${slug}": use lowercase letters, digits and dashes.`);
  if (!str("name")) throw new Error(`Sector ${slug}: name is required`);
  if (!str("searchQuery")) throw new Error(`Sector ${slug}: searchQuery is required`);
  const max = Number(s.maxNewLeadsPerRun ?? 40);
  return {
    slug,
    name: str("name"),
    searchQuery: str("searchQuery"),
    city: str("city") || null,
    regionCode: (str("regionCode") || "IN").toUpperCase(),
    whatsappTemplate: str("whatsappTemplate") || null,
    emailSubject: str("emailSubject") || null,
    emailBody: str("emailBody") || null,
    enabled: s.enabled === undefined ? true : Boolean(s.enabled),
    maxNewLeadsPerRun: Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), 60) : 40,
  };
}

export async function upsertSectors(db: OutreachDb, inputs: SectorInput[]): Promise<Sector[]> {
  const now = nowIso();
  const saved: Sector[] = [];
  for (const input of inputs) {
    const values: NewSector = { ...input, createdAt: now, updatedAt: now };
    const [row] = await db
      .insert(sectors)
      .values(values)
      .onConflictDoUpdate({
        target: sectors.slug,
        set: {
          name: values.name,
          searchQuery: values.searchQuery,
          city: values.city,
          regionCode: values.regionCode,
          whatsappTemplate: values.whatsappTemplate,
          emailSubject: values.emailSubject,
          emailBody: values.emailBody,
          enabled: values.enabled,
          maxNewLeadsPerRun: values.maxNewLeadsPerRun,
          updatedAt: now,
        },
      })
      .returning();
    saved.push(row);
  }
  return saved;
}

/* ------------------------------------------------------------------ */
/* Step 1: discover + enrich                                            */
/* ------------------------------------------------------------------ */

export interface DiscoverSummary {
  sectors: Array<{ slug: string; found: number; inserted: number; error?: string }>;
  enriched: number;
  ready: number;
  unreachable: number;
  errors: string[];
}

export async function runDiscovery(env: OutreachEnv, options: { fetchImpl?: typeof fetch; maxEnrichPerRun?: number } = {}): Promise<DiscoverSummary> {
  const db = getOutreachDb(env);
  const settings = readSettings(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = nowIso();
  const [log] = await db.insert(runLogs).values({ kind: "discover", startedAt: started }).returning();

  const summary: DiscoverSummary = { sectors: [], enriched: 0, ready: 0, unreachable: 0, errors: [] };

  const enabledSectors = await db.select().from(sectors).where(eq(sectors.enabled, true));
  if (!env.GOOGLE_MAPS_API_KEY) {
    summary.errors.push("GOOGLE_MAPS_API_KEY is not set; skipped Google Places search.");
  } else {
    for (const sector of enabledSectors) {
      const entry: DiscoverSummary["sectors"][number] = { slug: sector.slug, found: 0, inserted: 0 };
      summary.sectors.push(entry);
      try {
        const places = await searchPlaces({
          apiKey: env.GOOGLE_MAPS_API_KEY,
          query: sector.searchQuery,
          regionCode: sector.regionCode,
          maxResults: 60,
          fetchImpl,
        });
        entry.found = places.length;
        if (places.length === 0) continue;

        const existing = await db
          .select({ placeId: leads.placeId })
          .from(leads)
          .where(inArray(leads.placeId, places.map((p) => p.placeId)));
        const known = new Set(existing.map((e) => e.placeId));

        const fresh = places.filter((p) => !known.has(p.placeId)).slice(0, sector.maxNewLeadsPerRun);
        const now = nowIso();
        for (const p of fresh) {
          const phoneE164 = toE164Digits(p.internationalPhone ?? p.nationalPhone, settings.defaultCountryCode);
          await db
            .insert(leads)
            .values({
              sectorId: sector.id,
              placeId: p.placeId,
              name: p.name,
              address: p.address,
              city: sector.city,
              lat: p.lat,
              lng: p.lng,
              phoneRaw: p.internationalPhone ?? p.nationalPhone,
              phoneE164,
              website: p.website,
              googleMapsUrl: p.googleMapsUrl,
              rating: p.rating,
              ratingCount: p.ratingCount,
              status: "new",
              discoveredAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
          entry.inserted++;
        }
      } catch (err) {
        entry.error = (err as Error).message;
        summary.errors.push(`${sector.slug}: ${entry.error}`);
      }
    }
  }

  // Enrich: look for an email on the website, then decide if the lead is reachable.
  const toEnrich = await db
    .select()
    .from(leads)
    .where(and(eq(leads.status, "new"), lte(leads.enrichAttempts, 1)))
    .orderBy(asc(leads.discoveredAt))
    .limit(options.maxEnrichPerRun ?? 40);

  await mapWithConcurrency(toEnrich, 5, async (lead) => {
    let email = lead.email;
    if (!email && lead.website) {
      email = await findEmailOnWebsite(lead.website, { fetchImpl });
      if (email) summary.enriched++;
    }
    const reachable = Boolean(lead.phoneE164 || email);
    // Give a website one retry on a later run before giving up on it.
    const giveUp = !reachable && (!lead.website || lead.enrichAttempts >= 1);
    const status: Lead["status"] = reachable ? "ready" : giveUp ? "unreachable" : "new";
    if (status === "ready") summary.ready++;
    if (status === "unreachable") summary.unreachable++;
    const now = nowIso();
    await db
      .update(leads)
      .set({
        email,
        status,
        enrichAttempts: lead.enrichAttempts + 1,
        nextContactAt: status === "ready" ? now : null,
        updatedAt: now,
      })
      .where(eq(leads.id, lead.id));
  });

  await db.update(runLogs).set({ finishedAt: nowIso(), summary: JSON.stringify(summary) }).where(eq(runLogs.id, log.id));
  return summary;
}

/* ------------------------------------------------------------------ */
/* Step 2: morning send                                                 */
/* ------------------------------------------------------------------ */

export interface SendSummary {
  cap: number;
  alreadySentToday: number;
  attempted: number;
  sent: number;
  failed: number;
  skippedOptOut: number;
  dryRun: boolean;
  errors: string[];
}

function startOfUtcDay(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function isOptedOut(db: OutreachDb, lead: Lead): Promise<boolean> {
  const ids = [lead.phoneE164, lead.email?.toLowerCase()].filter((v): v is string => Boolean(v));
  if (ids.length === 0) return false;
  const rows = await db.select({ id: optOuts.id }).from(optOuts).where(inArray(optOuts.identifier, ids)).limit(1);
  return rows.length > 0;
}

function pickChannel(lead: Lead, env: OutreachEnv, settings: OutreachSettings, sector: Sector, lastChannel: MessageChannel | null): MessageChannel | null {
  const usable = settings.channels.filter((c) => {
    if (c === "whatsapp") return Boolean(lead.phoneE164) && !whatsappConfigured(env) && Boolean(sector.whatsappTemplate ?? env.WHATSAPP_TEMPLATE_NAME);
    return Boolean(lead.email) && !emailConfigured(env) && Boolean(sector.emailSubject && sector.emailBody);
  });
  if (usable.length === 0) return null;
  // For a follow-up, prefer a channel we have not tried yet.
  const untried = usable.find((c) => c !== lastChannel);
  return lastChannel && untried ? untried : usable[0];
}

export async function runMorningSend(env: OutreachEnv, options: { fetchImpl?: typeof fetch } = {}): Promise<SendSummary> {
  const db = getOutreachDb(env);
  const settings = readSettings(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = nowIso();
  const [log] = await db.insert(runLogs).values({ kind: "send", startedAt: started }).returning();

  const [{ value: sentToday }] = await db
    .select({ value: count() })
    .from(outreachMessages)
    .where(and(gte(outreachMessages.createdAt, startOfUtcDay()), ne(outreachMessages.status, "failed"), ne(outreachMessages.status, "received")));

  const summary: SendSummary = {
    cap: settings.dailySendCap,
    alreadySentToday: sentToday,
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedOptOut: 0,
    dryRun: settings.dryRun,
    errors: [],
  };

  const remaining = settings.dailySendCap - sentToday;
  if (remaining <= 0) {
    summary.errors.push("Daily send cap already reached.");
    await db.update(runLogs).set({ finishedAt: nowIso(), summary: JSON.stringify(summary) }).where(eq(runLogs.id, log.id));
    return summary;
  }

  const now = nowIso();
  const candidates = await db
    .select({ lead: leads, sector: sectors })
    .from(leads)
    .innerJoin(sectors, eq(leads.sectorId, sectors.id))
    .where(
      and(
        eq(sectors.enabled, true),
        inArray(leads.status, ["ready", "contacted"]),
        sql`${leads.touches} < ${settings.maxTouches}`,
        or(isNull(leads.nextContactAt), lte(leads.nextContactAt, now)),
      ),
    )
    // First touches before follow-ups, oldest leads first, spread across sectors.
    .orderBy(asc(leads.touches), asc(leads.sectorId), asc(leads.discoveredAt))
    .limit(remaining * 2);

  const origin = env.OUTREACH_PUBLIC_ORIGIN ?? "https://example.invalid";
  const secret = signingSecret(env);

  for (const { lead, sector } of candidates) {
    if (summary.sent + summary.failed >= remaining) break;

    if (await isOptedOut(db, lead)) {
      summary.skippedOptOut++;
      await db.update(leads).set({ status: "opted_out", nextContactAt: null, updatedAt: nowIso() }).where(eq(leads.id, lead.id));
      continue;
    }

    const [last] = await db
      .select({ channel: outreachMessages.channel })
      .from(outreachMessages)
      .where(and(eq(outreachMessages.leadId, lead.id), ne(outreachMessages.status, "received")))
      .orderBy(desc(outreachMessages.id))
      .limit(1);

    const channel = pickChannel(lead, env, settings, sector, last?.channel ?? null);
    if (!channel) {
      // Nothing we can send with the current configuration; look again tomorrow.
      await db.update(leads).set({ nextContactAt: addDays(nowIso(), 1), updatedAt: nowIso() }).where(eq(leads.id, lead.id));
      continue;
    }

    summary.attempted++;
    const unsub = await unsubscribeUrl(origin, lead.id, secret);
    const ctx = buildContext(lead, sector, unsub);

    let result: { ok: boolean; providerMessageId?: string; error?: string };
    let template: string | null = null;
    let body: string | null = null;

    if (channel === "whatsapp") {
      template = sector.whatsappTemplate ?? env.WHATSAPP_TEMPLATE_NAME!;
      const params = templateParams(env.WHATSAPP_TEMPLATE_PARAMS, ctx);
      body = params.join(" | ");
      result = settings.dryRun
        ? { ok: true, providerMessageId: `dry-run-${lead.id}` }
        : await sendWhatsAppTemplate(env, { to: lead.phoneE164!, templateName: template, languageCode: env.WHATSAPP_TEMPLATE_LANG ?? "en", bodyParams: params }, fetchImpl);
    } else {
      template = sector.emailSubject!;
      const subject = renderTemplate(sector.emailSubject!, ctx);
      body = renderTemplate(sector.emailBody!, ctx);
      result = settings.dryRun
        ? { ok: true, providerMessageId: `dry-run-${lead.id}` }
        : await sendEmail(env, { to: lead.email!, subject, text: body, unsubscribeUrl: unsub }, fetchImpl);
    }

    const stamp = nowIso();
    await db.insert(outreachMessages).values({
      leadId: lead.id,
      channel,
      providerMessageId: result.providerMessageId ?? null,
      status: result.ok ? (settings.dryRun ? "dry_run" : "sent") : "failed",
      template,
      body,
      error: result.error ?? null,
      createdAt: stamp,
      updatedAt: stamp,
    });

    if (result.ok) {
      summary.sent++;
      const touches = lead.touches + 1;
      await db
        .update(leads)
        .set({
          touches,
          status: touches >= settings.maxTouches ? "exhausted" : "contacted",
          lastContactedAt: stamp,
          nextContactAt: touches >= settings.maxTouches ? null : addDays(stamp, settings.followUpDays),
          updatedAt: stamp,
        })
        .where(eq(leads.id, lead.id));
    } else {
      summary.failed++;
      summary.errors.push(`${lead.name} (${channel}): ${result.error}`);
      const [{ value: failures }] = await db
        .select({ value: count() })
        .from(outreachMessages)
        .where(and(eq(outreachMessages.leadId, lead.id), eq(outreachMessages.status, "failed")));
      await db
        .update(leads)
        .set({
          // After repeated provider failures the contact details are probably wrong.
          status: failures >= 3 ? "unreachable" : lead.status,
          nextContactAt: failures >= 3 ? null : addDays(stamp, 1),
          updatedAt: stamp,
        })
        .where(eq(leads.id, lead.id));
    }
  }

  await db.update(runLogs).set({ finishedAt: nowIso(), summary: JSON.stringify(summary) }).where(eq(runLogs.id, log.id));
  return summary;
}

/* ------------------------------------------------------------------ */
/* Inbound: replies, opt-outs, delivery receipts                        */
/* ------------------------------------------------------------------ */

export async function recordOptOut(db: OutreachDb, identifier: string, source: string): Promise<void> {
  const id = identifier.includes("@") ? identifier.trim().toLowerCase() : identifier.replace(/\D/g, "");
  if (!id) return;
  await db.insert(optOuts).values({ identifier: id, source, createdAt: nowIso() }).onConflictDoNothing();
  await db
    .update(leads)
    .set({ status: "opted_out", nextContactAt: null, updatedAt: nowIso() })
    .where(id.includes("@") ? eq(leads.email, id) : eq(leads.phoneE164, id));
}

export async function handleWhatsAppWebhook(env: OutreachEnv, payload: unknown): Promise<{ replies: number; optOuts: number; statuses: number }> {
  const db = getOutreachDb(env);
  const { messages, statuses } = parseWebhook(payload);
  const result = { replies: 0, optOuts: 0, statuses: 0 };

  for (const m of messages) {
    const [lead] = await db.select().from(leads).where(eq(leads.phoneE164, m.from)).limit(1);
    const stamp = nowIso();
    if (lead) {
      await db.insert(outreachMessages).values({
        leadId: lead.id,
        channel: "whatsapp",
        providerMessageId: m.providerMessageId,
        status: "received",
        body: m.text ?? `[${m.type}]`,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    if (isOptOutText(m.text)) {
      await recordOptOut(db, m.from, "whatsapp_reply");
      result.optOuts++;
    } else if (lead && lead.status !== "opted_out") {
      // A human replied: hand the conversation to the founder, stop automation.
      await db.update(leads).set({ status: "replied", nextContactAt: null, updatedAt: stamp }).where(eq(leads.id, lead.id));
      result.replies++;
    }
  }

  for (const s of statuses) {
    await db
      .update(outreachMessages)
      .set({ status: s.status, error: s.error, updatedAt: nowIso() })
      .where(eq(outreachMessages.providerMessageId, s.providerMessageId));
    result.statuses++;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                            */
/* ------------------------------------------------------------------ */

export async function getStats(db: OutreachDb) {
  const byStatus = await db.select({ status: leads.status, value: count() }).from(leads).groupBy(leads.status);
  const bySector = await db
    .select({ slug: sectors.slug, name: sectors.name, leads: count(leads.id) })
    .from(sectors)
    .leftJoin(leads, eq(leads.sectorId, sectors.id))
    .groupBy(sectors.id);
  const [{ value: sentToday }] = await db
    .select({ value: count() })
    .from(outreachMessages)
    .where(and(gte(outreachMessages.createdAt, startOfUtcDay()), ne(outreachMessages.status, "failed"), ne(outreachMessages.status, "received")));
  const recentRuns = await db.select().from(runLogs).orderBy(desc(runLogs.id)).limit(10);
  return {
    leadsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.value])),
    sectors: bySector,
    sentToday,
    recentRuns: recentRuns.map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })),
  };
}
