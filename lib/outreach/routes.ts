import { and, desc, eq, inArray } from "drizzle-orm";
import { leads, outreachMessages, sectors, LEAD_STATUSES, type LeadStatus } from "../../db/schema";
import type { OutreachEnv } from "./config";
import { getOutreachDb, getStats, handleWhatsAppWebhook, recordOptOut, runDiscovery, runMorningSend, upsertSectors, validateSectorInput } from "./pipeline";
import { verifyLeadSignature } from "./signing";

/**
 * HTTP surface for the outreach pipeline.
 *
 *   POST /api/outreach/run?step=discover|send|all   (admin)  run a step now
 *   GET  /api/outreach/stats                         (admin)  counts and recent runs
 *   GET  /api/outreach/sectors                       (admin)
 *   POST /api/outreach/sectors                       (admin)  upsert an array of sectors
 *   GET  /api/outreach/leads?status=&sector=&limit=  (admin)
 *   GET  /api/outreach/leads/:id/messages            (admin)
 *   POST /api/outreach/opt-out  {identifier}         (admin)  manual opt-out
 *   GET  /api/outreach/unsubscribe?lead=&sig=        (public) one-click email unsubscribe
 *   GET  /api/webhooks/whatsapp                      (Meta)   verification handshake
 *   POST /api/webhooks/whatsapp                      (Meta)   replies + delivery statuses
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(request: Request, env: OutreachEnv): Response | null {
  if (!env.OUTREACH_ADMIN_TOKEN) return json({ error: "OUTREACH_ADMIN_TOKEN is not configured on the server." }, 503);
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !constantTimeEqual(token, env.OUTREACH_ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);
  return null;
}

export async function runStep(step: string, env: OutreachEnv) {
  switch (step) {
    case "discover":
      return { discover: await runDiscovery(env) };
    case "send":
      return { send: await runMorningSend(env) };
    case "all":
      return { discover: await runDiscovery(env), send: await runMorningSend(env) };
    default:
      throw new Error(`Unknown step "${step}". Use discover, send or all.`);
  }
}

/** Returns null when the request is not an outreach route. */
export async function handleOutreachRequest(request: Request, env: OutreachEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  /* ---- Public / provider-facing routes ---- */

  if (path === "/api/webhooks/whatsapp") {
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "POST") {
      const payload = await request.json().catch(() => null);
      try {
        const result = await handleWhatsAppWebhook(env, payload);
        return json({ ok: true, ...result });
      } catch (err) {
        // Always answer 200 so Meta does not retry endlessly; log the problem instead.
        console.error("whatsapp webhook error", err);
        return json({ ok: false, error: (err as Error).message });
      }
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/api/outreach/unsubscribe" && request.method === "GET") {
    const leadId = Number(url.searchParams.get("lead"));
    const sig = url.searchParams.get("sig") ?? "";
    const secret = env.OUTREACH_SIGNING_SECRET ?? env.OUTREACH_ADMIN_TOKEN ?? "";
    if (!Number.isInteger(leadId) || !sig || !secret || !(await verifyLeadSignature(leadId, sig, secret))) {
      return new Response("This unsubscribe link is invalid.", { status: 400 });
    }
    const db = getOutreachDb(env);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (lead?.email) await recordOptOut(db, lead.email, "email_unsubscribe");
    if (lead?.phoneE164) await recordOptOut(db, lead.phoneE164, "email_unsubscribe");
    return new Response("You have been unsubscribed. Sorry for the interruption, and thank you.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!path.startsWith("/api/outreach")) return null;

  /* ---- Admin routes ---- */

  const denied = authorize(request, env);
  if (denied) return denied;

  try {
    if (path === "/api/outreach/run" && request.method === "POST") {
      const step = url.searchParams.get("step") ?? "all";
      return json({ ok: true, step, ...(await runStep(step, env)) });
    }

    const db = getOutreachDb(env);

    if (path === "/api/outreach/stats" && request.method === "GET") {
      return json(await getStats(db));
    }

    if (path === "/api/outreach/sectors" && request.method === "GET") {
      return json(await db.select().from(sectors).orderBy(sectors.slug));
    }

    if (path === "/api/outreach/sectors" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const list = Array.isArray(body) ? body : Array.isArray((body as { sectors?: unknown })?.sectors) ? (body as { sectors: unknown[] }).sectors : null;
      if (!list) return json({ error: "Send a JSON array of sectors, or {\"sectors\": [...]}." }, 400);
      const inputs = list.map(validateSectorInput);
      return json({ ok: true, sectors: await upsertSectors(db, inputs) });
    }

    if (path === "/api/outreach/leads" && request.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const statusParam = url.searchParams.get("status");
      const sectorSlug = url.searchParams.get("sector");
      const filters = [];
      if (statusParam) {
        const wanted = statusParam.split(",").filter((s): s is LeadStatus => (LEAD_STATUSES as readonly string[]).includes(s));
        if (wanted.length === 0) return json({ error: `Unknown status. Use one of ${LEAD_STATUSES.join(", ")}.` }, 400);
        filters.push(inArray(leads.status, wanted));
      }
      if (sectorSlug) filters.push(eq(sectors.slug, sectorSlug));
      const rows = await db
        .select({ lead: leads, sector: sectors.slug })
        .from(leads)
        .innerJoin(sectors, eq(leads.sectorId, sectors.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(leads.id))
        .limit(limit);
      return json(rows.map((r) => ({ ...r.lead, sector: r.sector })));
    }

    const messagesMatch = path.match(/^\/api\/outreach\/leads\/(\d+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      const leadId = Number(messagesMatch[1]);
      return json(await db.select().from(outreachMessages).where(eq(outreachMessages.leadId, leadId)).orderBy(outreachMessages.id));
    }

    if (path === "/api/outreach/opt-out" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { identifier?: string };
      if (!body.identifier) return json({ error: "identifier (phone or email) is required" }, 400);
      await recordOptOut(db, body.identifier, "manual");
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("outreach route error", err);
    return json({ error: (err as Error).message }, 500);
  }
}

/** Which pipeline step a cron expression maps to. See vite.config.ts triggers. */
export const CRON_SCHEDULE: Record<string, "discover" | "send"> = {
  "0 22 * * *": "discover", // 22:00 UTC = 03:30 IST, the night before
  "30 3 * * *": "send", // 03:30 UTC = 09:00 IST, every morning
};
