import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface SegmentsEnv extends AuthEnv {
  DB: D1Database;
}

/* ================================================================================================
   Dynamic audience segmentation.

   A dynamic audience stores a *question*, not an answer: the rules are evaluated every time the
   audience is used, so a segment like "hot leads reachable on WhatsApp" is correct at send time
   rather than correct on the day someone built it.

   Static audiences keep working unchanged. audience_members remains the static mapping table under
   its existing name — renaming a table that already holds customer lists breaks every reader the
   moment it lands, and the spoke/hub migration set the precedent for elevating in place instead.
   ============================================================================================== */

export type RuleField =
  | "lead_stage" | "lead_priority" | "lead_segment" | "lead_source" | "lead_score"
  | "label" | "channel" | "opt_in" | "company" | "created_at";

export type RuleOperator =
  | "is" | "is_not" | "gte" | "lte" | "contains" | "has" | "not_has" | "within_days";

export interface SegmentRule { field: RuleField; op: RuleOperator; value: string }
export interface SegmentGroup { match: "all" | "any"; rules: SegmentRule[] }
export interface SegmentFilter { match: "all" | "any"; groups: SegmentGroup[] }

const MAX_GROUPS = 8;
const MAX_RULES_PER_GROUP = 12;
const PREVIEW_SAMPLE = 8;

let schemaReady = false;

export async function ensureSegmentSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  // Additive only: existing audiences keep working and are simply is_dynamic = 0.
  for (const statement of [
    `ALTER TABLE audiences ADD COLUMN is_dynamic INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE audiences ADD COLUMN filter_rules TEXT NOT NULL DEFAULT ''`,
    // Consent is per identifier, not per person: someone may be reachable on WhatsApp and have
    // unsubscribed from email, and one flag on the profile could not express that.
    `ALTER TABLE crm_identities ADD COLUMN opt_in_status TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE crm_identities ADD COLUMN opt_in_at TEXT`,
    `ALTER TABLE crm_identities ADD COLUMN opt_in_source TEXT NOT NULL DEFAULT ''`,
  ]) {
    try { await db.prepare(statement).run(); } catch { /* already applied */ }
  }
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_identity_optin ON crm_identities (workspace_id, kind, opt_in_status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_audiences_dynamic ON audiences (workspace_id, is_dynamic)`),
  ]);
  schemaReady = true;
}

/* ------------------------------------------------------------------ opt-in semantics */

/**
 * Whether an identity may be broadcast to.
 *
 * Explicit consent wins, and explicit refusal always wins over everything. Where nothing has been
 * recorded, an identity that arrived *inbound* over its own channel (is_verified) counts as
 * implicit opt-in for that channel — which is how WhatsApp and Instagram actually treat a customer
 * who messaged you first. Anything unverified with no recorded consent is not contactable: assuming
 * otherwise would manufacture permission the business never obtained.
 */
export const OPTED_IN_SQL = `(i.opt_in_status = 'in' OR (i.opt_in_status = 'unknown' AND i.is_verified = 1))`;
export const NOT_OPTED_OUT_SQL = `i.opt_in_status != 'out'`;

/* ------------------------------------------------------------------ rule parsing */

const CHANNEL_KIND: Record<string, string> = {
  whatsapp: "phone", instagram: "handle", webchat: "visitor", email: "email",
};

interface Fragment { sql: string; binds: unknown[] }

function sanitizeValue(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 120);
}

/**
 * One rule to one SQL fragment.
 *
 * Every value is bound, never interpolated — the field and operator are matched against closed
 * allow-lists and anything unrecognised returns null rather than being passed through. A rule
 * builder that writes SQL is an injection surface if the shape of that SQL is ever influenced by
 * user input, so nothing here is built from a string the user controls.
 */
function ruleToSql(rule: SegmentRule): Fragment | null {
  const value = sanitizeValue(rule.value);
  const p = "p"; // crm_people alias in the outer query

  switch (rule.field) {
    case "lead_stage":
    case "lead_priority":
    case "lead_segment":
    case "lead_source": {
      const column = { lead_stage: "stage", lead_priority: "priority", lead_segment: "segment", lead_source: "source" }[rule.field];
      if (!value) return null;
      if (rule.op === "is") return { sql: `EXISTS (SELECT 1 FROM crm_leads l WHERE l.workspace_id = ${p}.workspace_id AND l.person_id = ${p}.id AND l.${column} = ?)`, binds: [value] };
      if (rule.op === "is_not") return { sql: `NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.workspace_id = ${p}.workspace_id AND l.person_id = ${p}.id AND l.${column} = ?)`, binds: [value] };
      return null;
    }

    case "lead_score": {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      // The score lives on crm_contacts, keyed by conversation thread, so a profile matches if any
      // of its conversations carries a qualifying score.
      const join = `EXISTS (SELECT 1 FROM crm_conversations c JOIN crm_contacts s
        ON s.workspace_id = c.workspace_id AND s.session_id = c.thread_key
        WHERE c.workspace_id = ${p}.workspace_id AND c.person_id = ${p}.id AND s.score IS NOT NULL AND s.score %OP% ?)`;
      if (rule.op === "gte") return { sql: join.replace("%OP%", ">="), binds: [n] };
      if (rule.op === "lte") return { sql: join.replace("%OP%", "<="), binds: [n] };
      return null;
    }

    case "label": {
      if (!value) return null;
      // Labels are a JSON array on crm_contacts. Matching the quoted form avoids "VIP" matching
      // inside "VIP-lapsed", which a bare LIKE would do.
      const has = `EXISTS (SELECT 1 FROM crm_conversations c JOIN crm_contacts s
        ON s.workspace_id = c.workspace_id AND s.session_id = c.thread_key
        WHERE c.workspace_id = ${p}.workspace_id AND c.person_id = ${p}.id AND lower(s.labels) LIKE ?)`;
      const pattern = `%"${value.toLowerCase().replace(/["%_\\]/g, "")}"%`;
      if (rule.op === "has") return { sql: has, binds: [pattern] };
      if (rule.op === "not_has") return { sql: `NOT ${has}`, binds: [pattern] };
      return null;
    }

    case "channel": {
      const kind = CHANNEL_KIND[value];
      if (!kind) return null;
      // Presence means an identity of that channel's kind exists and is not opted out. A profile
      // that unsubscribed from WhatsApp is not "present on WhatsApp" for targeting purposes.
      const present = `EXISTS (SELECT 1 FROM crm_identities i WHERE i.workspace_id = ${p}.workspace_id
        AND i.profile_id = ${p}.id AND i.kind = ? AND ${NOT_OPTED_OUT_SQL})`;
      if (rule.op === "has") return { sql: present, binds: [kind] };
      if (rule.op === "not_has") return { sql: `NOT ${present}`, binds: [kind] };
      return null;
    }

    case "opt_in": {
      // "Reachable anywhere" vs "explicitly refused everywhere" — the two questions a marketer
      // actually asks before a broadcast.
      const anyOptedIn = `EXISTS (SELECT 1 FROM crm_identities i WHERE i.workspace_id = ${p}.workspace_id
        AND i.profile_id = ${p}.id AND ${OPTED_IN_SQL})`;
      if (rule.op === "is" && value === "in") return { sql: anyOptedIn, binds: [] };
      if (rule.op === "is" && value === "out") return { sql: `NOT ${anyOptedIn}`, binds: [] };
      return null;
    }

    case "company": {
      if (!value) return null;
      if (rule.op === "contains") return { sql: `lower(${p}.company) LIKE ?`, binds: [`%${value.toLowerCase()}%`] };
      if (rule.op === "is") return { sql: `lower(${p}.company) = ?`, binds: [value.toLowerCase()] };
      return null;
    }

    case "created_at": {
      const days = Number(value);
      if (!Number.isFinite(days) || days <= 0) return null;
      if (rule.op === "within_days") return { sql: `${p}.created_at >= datetime('now', ?)`, binds: [`-${Math.floor(days)} days`] };
      return null;
    }
  }
  return null;
}

function groupToSql(group: SegmentGroup): Fragment | null {
  const rules = (group.rules || []).slice(0, MAX_RULES_PER_GROUP);
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const rule of rules) {
    const fragment = ruleToSql(rule);
    if (!fragment) continue;
    parts.push(fragment.sql);
    binds.push(...fragment.binds);
  }
  if (!parts.length) return null;
  return { sql: `(${parts.join(group.match === "any" ? " OR " : " AND ")})`, binds };
}

/**
 * The whole filter to a single WHERE fragment. An empty or entirely unparseable filter returns
 * null, and callers treat that as "matches nobody" rather than "matches everybody" — a segment that
 * silently broadened to the entire database would be the worst possible failure mode for a
 * broadcast tool.
 */
export function buildSegmentSql(filter: SegmentFilter | null): Fragment | null {
  if (!filter || !Array.isArray(filter.groups)) return null;
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const group of filter.groups.slice(0, MAX_GROUPS)) {
    const fragment = groupToSql(group);
    if (!fragment) continue;
    parts.push(fragment.sql);
    binds.push(...fragment.binds);
  }
  if (!parts.length) return null;
  return { sql: parts.join(filter.match === "any" ? " OR " : " AND "), binds };
}

export function parseFilter(raw: string | null | undefined): SegmentFilter | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SegmentFilter;
    return parsed && Array.isArray(parsed.groups) ? parsed : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ resolution */

export interface SegmentMember {
  profileId: string; name: string; company: string;
}

/** Profiles matching a dynamic filter. Tombstoned profiles are excluded — they are duplicates that
 *  were merged away, and sending to them would double-message the survivor. */
export async function resolveDynamicMembers(
  db: D1Database, workspaceId: string, filter: SegmentFilter | null, limit = 5000,
): Promise<SegmentMember[]> {
  await ensureSegmentSchema(db);
  const fragment = buildSegmentSql(filter);
  if (!fragment) return [];
  const rows = await db.prepare(`SELECT p.id, p.full_name, p.company FROM crm_people p
    WHERE p.workspace_id = ? AND p.is_active = 1 AND (${fragment.sql})
    ORDER BY p.updated_at DESC LIMIT ?`)
    .bind(workspaceId, ...fragment.binds, limit)
    .all<{ id: string; full_name: string; company: string }>();
  return (rows.results || []).map((r) => ({ profileId: r.id, name: r.full_name || "Unnamed contact", company: r.company || "" }));
}

export interface ChannelRecipient {
  profileId: string; name: string; identifier: string;
}

export interface AudienceResolution {
  channel: string;
  matched: number;
  reachable: ChannelRecipient[];
  excludedNoIdentifier: number;
  excludedOptedOut: number;
}

/**
 * Channel compliance, applied at send time.
 *
 * A segment describes people; a broadcast needs addresses. This narrows a matched audience to only
 * those holding an identifier of the right kind that is actually contactable, and reports what was
 * dropped and why — an operator about to spend message credits should see "40 matched, 12
 * reachable" before sending, not afterwards in a delivery report.
 */
export async function resolveForChannel(
  db: D1Database, workspaceId: string, filter: SegmentFilter | null, staticAudienceId: string, channel: string,
): Promise<AudienceResolution> {
  await ensureSegmentSchema(db);
  const kind = CHANNEL_KIND[channel];
  const empty: AudienceResolution = { channel, matched: 0, reachable: [], excludedNoIdentifier: 0, excludedOptedOut: 0 };
  if (!kind) return empty;

  if (filter) {
    const fragment = buildSegmentSql(filter);
    if (!fragment) return empty;
    const matchedRows = await db.prepare(`SELECT p.id, p.full_name FROM crm_people p
      WHERE p.workspace_id = ? AND p.is_active = 1 AND (${fragment.sql}) LIMIT 5000`)
      .bind(workspaceId, ...fragment.binds).all<{ id: string; full_name: string }>();
    const matched = matchedRows.results || [];
    if (!matched.length) return empty;

    const ids = matched.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const [reachableRows, optedOutRows] = await Promise.all([
      db.prepare(`SELECT i.profile_id, i.normalized_value FROM crm_identities i
        WHERE i.workspace_id = ? AND i.kind = ? AND i.profile_id IN (${placeholders}) AND ${OPTED_IN_SQL}
        GROUP BY i.profile_id`).bind(workspaceId, kind, ...ids).all<{ profile_id: string; normalized_value: string }>(),
      db.prepare(`SELECT DISTINCT i.profile_id FROM crm_identities i
        WHERE i.workspace_id = ? AND i.kind = ? AND i.profile_id IN (${placeholders}) AND i.opt_in_status = 'out'`)
        .bind(workspaceId, kind, ...ids).all<{ profile_id: string }>(),
    ]);
    const nameBy = new Map(matched.map((m) => [m.id, m.full_name || "Unnamed contact"]));
    const reachable = (reachableRows.results || []).map((r) => ({
      profileId: r.profile_id, name: nameBy.get(r.profile_id) || "Unnamed contact", identifier: r.normalized_value,
    }));
    const optedOut = (optedOutRows.results || []).length;
    return {
      channel, matched: matched.length, reachable,
      excludedOptedOut: optedOut,
      excludedNoIdentifier: Math.max(0, matched.length - reachable.length - optedOut),
    };
  }

  // Static audience: the legacy contacts list, which carries its own consent flag.
  const rows = await db.prepare(`SELECT c.id, c.name, c.phone, c.consent FROM contacts c
    JOIN audience_members am ON am.contact_id = c.id
    WHERE am.audience_id = ? AND c.workspace_id = ?`)
    .bind(staticAudienceId, workspaceId).all<{ id: string; name: string; phone: string; consent: number }>();
  const all = rows.results || [];
  const reachable = all.filter((r) => r.consent === 1 && r.phone)
    .map((r) => ({ profileId: r.id, name: r.name || "Unnamed contact", identifier: r.phone }));
  return {
    channel, matched: all.length, reachable,
    excludedOptedOut: all.filter((r) => r.consent !== 1).length,
    excludedNoIdentifier: all.filter((r) => r.consent === 1 && !r.phone).length,
  };
}

/* ------------------------------------------------------------------ HTTP */

const FIELD_META = [
  { field: "lead_stage", label: "Lead status", ops: ["is", "is_not"], options: ["New", "Contacted", "Qualified", "Proposal", "Closed Won", "Closed Lost"] },
  { field: "lead_score", label: "Lead score", ops: ["gte", "lte"], input: "number" },
  { field: "lead_priority", label: "Priority", ops: ["is", "is_not"], options: ["Hot", "Warm", "Cold"] },
  { field: "lead_segment", label: "Segment", ops: ["is", "is_not"], options: ["Enterprise", "SMB", "Consumer"] },
  { field: "lead_source", label: "Source", ops: ["is", "is_not"], options: ["Website", "WhatsApp", "Instagram", "Referral", "Event", "Campaign"] },
  { field: "label", label: "Tag", ops: ["has", "not_has"], input: "text" },
  { field: "channel", label: "Channel presence", ops: ["has", "not_has"], options: ["whatsapp", "instagram", "webchat", "email"] },
  { field: "opt_in", label: "Opt-in", ops: ["is"], options: ["in", "out"] },
  { field: "company", label: "Company", ops: ["is", "contains"], input: "text" },
  { field: "created_at", label: "Added within", ops: ["within_days"], input: "number" },
];

async function describeFields(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  return json(request, { fields: FIELD_META });
}

/** Powers the live count badge. Deliberately cheap: a COUNT plus a handful of names, no payload. */
async function preview(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { filter?: SegmentFilter };
  await ensureSegmentSchema(env.DB);
  const fragment = buildSegmentSql(body.filter || null);
  if (!fragment) return json(request, { count: 0, sample: [], valid: false });

  const [countRow, sample] = await Promise.all([
    env.DB.prepare(`SELECT count(*) n FROM crm_people p WHERE p.workspace_id = ? AND p.is_active = 1 AND (${fragment.sql})`)
      .bind(session.workspaceId, ...fragment.binds).first<{ n: number }>(),
    env.DB.prepare(`SELECT p.full_name, p.company FROM crm_people p
      WHERE p.workspace_id = ? AND p.is_active = 1 AND (${fragment.sql}) ORDER BY p.updated_at DESC LIMIT ?`)
      .bind(session.workspaceId, ...fragment.binds, PREVIEW_SAMPLE).all<{ full_name: string; company: string }>(),
  ]);
  return json(request, {
    valid: true,
    count: countRow?.n ?? 0,
    sample: (sample.results || []).map((r) => ({ name: r.full_name || "Unnamed contact", company: r.company || "" })),
  });
}

/** What a broadcast on this channel would actually reach, before any credits are spent. */
async function previewChannel(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { audienceId?: string; channel?: string };
  const audienceId = (body.audienceId || "").trim();
  const channel = (body.channel || "whatsapp").trim();
  if (!audienceId) return json(request, { error: "Missing audienceId." }, 400);
  await ensureSegmentSchema(env.DB);

  const audience = await env.DB.prepare(`SELECT id, name, is_dynamic, filter_rules FROM audiences WHERE id = ? AND workspace_id = ?`)
    .bind(audienceId, session.workspaceId).first<{ id: string; name: string; is_dynamic: number; filter_rules: string }>();
  if (!audience) return json(request, { error: "Audience not found." }, 404);

  const resolution = await resolveForChannel(
    env.DB, session.workspaceId,
    audience.is_dynamic === 1 ? parseFilter(audience.filter_rules) : null,
    audienceId, channel,
  );
  return json(request, {
    audience: { id: audience.id, name: audience.name, isDynamic: audience.is_dynamic === 1 },
    channel,
    matched: resolution.matched,
    reachable: resolution.reachable.length,
    excludedOptedOut: resolution.excludedOptedOut,
    excludedNoIdentifier: resolution.excludedNoIdentifier,
    sample: resolution.reachable.slice(0, PREVIEW_SAMPLE).map((r) => ({ name: r.name, identifier: r.identifier })),
  });
}

async function saveAudience(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string; name?: string; isDynamic?: boolean; filter?: SegmentFilter };
  const name = (body.name || "").trim().slice(0, 80);
  if (!name) return json(request, { error: "Name this audience." }, 400);
  await ensureSegmentSchema(env.DB);

  const isDynamic = body.isDynamic ? 1 : 0;
  const rules = isDynamic && body.filter ? JSON.stringify(body.filter).slice(0, 8000) : "";
  if (isDynamic && !buildSegmentSql(body.filter || null)) {
    return json(request, { error: "Add at least one complete rule before saving a dynamic audience." }, 400);
  }

  const id = (body.id || "").trim() || `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  await env.DB.prepare(`INSERT INTO audiences (id, workspace_id, name, is_dynamic, filter_rules)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_dynamic = excluded.is_dynamic,
      filter_rules = excluded.filter_rules, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, session.workspaceId, name, isDynamic, rules).run();
  return json(request, { ok: true, id });
}

async function listAudiences(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSegmentSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT a.id, a.name, a.is_dynamic, a.filter_rules, a.created_at,
      (SELECT count(*) FROM audience_members am WHERE am.audience_id = a.id) static_count
    FROM audiences a WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 200`)
    .bind(session.workspaceId).all<{ id: string; name: string; is_dynamic: number; filter_rules: string; created_at: string; static_count: number }>();

  const audiences = [];
  for (const row of rows.results || []) {
    const filter = row.is_dynamic === 1 ? parseFilter(row.filter_rules) : null;
    let count = row.static_count;
    if (filter) {
      const fragment = buildSegmentSql(filter);
      const countRow = fragment
        ? await env.DB.prepare(`SELECT count(*) n FROM crm_people p WHERE p.workspace_id = ? AND p.is_active = 1 AND (${fragment.sql})`)
            .bind(session.workspaceId, ...fragment.binds).first<{ n: number }>()
        : null;
      count = countRow?.n ?? 0;
    }
    audiences.push({
      id: row.id, name: row.name, isDynamic: row.is_dynamic === 1,
      filter, count, createdAt: row.created_at,
    });
  }
  return json(request, { audiences });
}

/** Records consent for one identifier. An explicit opt-out is permanent until explicitly reversed. */
async function setOptIn(request: Request, env: SegmentsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { identityId?: string; status?: string };
  const identityId = (body.identityId || "").trim();
  const status = (body.status || "").trim();
  if (!identityId || !["in", "out", "unknown"].includes(status)) {
    return json(request, { error: "identityId and a status of in, out or unknown are required." }, 400);
  }
  await ensureSegmentSchema(env.DB);
  await env.DB.prepare(`UPDATE crm_identities SET opt_in_status = ?, opt_in_at = CURRENT_TIMESTAMP,
    opt_in_source = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
    .bind(status, `agent:${session.email}`, session.workspaceId, identityId).run();
  return json(request, { ok: true });
}

export async function handleSegmentsRequest(request: Request, env: SegmentsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/segments")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/segments/fields" && request.method === "GET") return describeFields(request, env);
  if (url.pathname === "/api/segments/preview" && request.method === "POST") return preview(request, env);
  if (url.pathname === "/api/segments/channel-preview" && request.method === "POST") return previewChannel(request, env);
  if (url.pathname === "/api/segments/audiences" && request.method === "GET") return listAudiences(request, env);
  if (url.pathname === "/api/segments/audiences" && request.method === "POST") return saveAudience(request, env);
  if (url.pathname === "/api/segments/opt-in" && request.method === "POST") return setOptIn(request, env);
  return null;
}
