import { callClaude, json, corsPreflight, allowedOrigin, type ChatMessage } from "./shared";
import { requireSession, type AuthEnv } from "./auth";
import { resolveIdentity, resolveTombstone, absorbProfile, type IdentityChannel, type ResolutionTier } from "./identity";
import { readVisitorContext, ONLINE_SQL } from "./visitor";
import { readEndedState } from "./chatlifecycle";

export interface ConversationsEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

export type Channel = "whatsapp" | "instagram" | "webchat";

export const PIPELINE_STAGES = ["New", "Contacted", "Qualified", "Proposal", "Closed Won", "Closed Lost"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const PRIORITIES = ["Hot", "Warm", "Cold"];
const SEGMENTS = ["Enterprise", "SMB", "Consumer"];
const SOURCES = ["Website", "WhatsApp", "Instagram", "Referral", "Event", "Campaign"];

const FEED_LIMIT = 300;
const MESSAGE_LIMIT = 200;

let schemaReady = false;

/* ------------------------------------------------------------------ schema */

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    // One person, however many channels they reach us on. Every dedup key is stored normalised so
    // a match is an index lookup rather than a scan with per-row cleanup.
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_people (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phone_key TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      email_key TEXT NOT NULL DEFAULT '',
      instagram_handle TEXT NOT NULL DEFAULT '',
      handle_key TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      avatar_tone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_people_phone ON crm_people (workspace_id, phone_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_people_email ON crm_people (workspace_id, email_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_people_handle ON crm_people (workspace_id, handle_key)`),

    // A conversation is the channel-specific thread. thread_key is the channel's own identifier
    // (widget session id, wa_id, instagram sender id) so an inbound message always finds its thread.
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_conversations (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      person_id TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      last_at TEXT NOT NULL DEFAULT '',
      last_role TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      ai_active INTEGER NOT NULL DEFAULT 1,
      needs_attention INTEGER NOT NULL DEFAULT 0,
      attention_reason TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_thread ON crm_conversations (workspace_id, channel, thread_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_recent ON crm_conversations (workspace_id, last_at DESC)`),

    // The sales record. A lead belongs to a person, never to a conversation — that is what lets one
    // customer message on WhatsApp and web chat without becoming two leads.
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_leads (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'New',
      priority TEXT NOT NULL DEFAULT '',
      segment TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      next_followup TEXT NOT NULL DEFAULT '',
      board_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_person ON crm_leads (workspace_id, person_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_lead_stage ON crm_leads (workspace_id, stage, board_order)`),

    // A monotonic log every client tails to learn what changed. This is the transport-independent
    // half of real-time: a websocket pushes these rows, polling pulls them, the payload is identical.
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_ws ON crm_events (workspace_id, seq)`),
  ]);
  schemaReady = true;
}

/* ------------------------------------------------------------------ identity + dedup */

// Phone numbers arrive as "+971 50 123 4567", "0501234567", "971501234567". Comparing the last 9
// significant digits matches all three without a full E.164 library, and is short enough to survive
// a missing country code but long enough not to collide across real customers.
export function phoneKey(raw: string): string {
  const digits = (raw || "").replace(/\D+/g, "");
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

export function emailKey(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

export function handleKey(raw: string): string {
  return (raw || "").trim().toLowerCase().replace(/^@/, "");
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export interface IdentityHints {
  name?: string; phone?: string; email?: string; instagramHandle?: string; company?: string;
}

function hasQualifyingInfo(hints: IdentityHints): boolean {
  // A name alone is not a lead — plenty of visitors say "I'm Sam" and vanish. A way to reach them
  // back is what makes the record worth creating.
  return Boolean((hints.phone && phoneKey(hints.phone)) || emailKey(hints.email || "") || handleKey(hints.instagramHandle || ""));
}

interface PersonRow {
  id: string; full_name: string; phone: string; email: string; instagram_handle: string; company: string; avatar_tone: number;
}

// Finds the existing person behind these details, or creates one. Any key that matches wins, and
// the surviving record absorbs whatever new detail this contact carried — so a WhatsApp number that
// later supplies an email becomes one richer person, not two thin ones.
export async function resolvePerson(db: D1Database, workspaceId: string, hints: IdentityHints): Promise<PersonRow | null> {
  await ensureSchema(db);
  const pk = phoneKey(hints.phone || "");
  const ek = emailKey(hints.email || "");
  const hk = handleKey(hints.instagramHandle || "");
  if (!pk && !ek && !hk) return null;

  const clauses: string[] = [];
  const binds: string[] = [workspaceId];
  if (pk) { clauses.push("phone_key = ?"); binds.push(pk); }
  if (ek) { clauses.push("email_key = ?"); binds.push(ek); }
  if (hk) { clauses.push("handle_key = ?"); binds.push(hk); }

  const existing = await db.prepare(`SELECT id, full_name, phone, email, instagram_handle, company, avatar_tone
    FROM crm_people WHERE workspace_id = ? AND (${clauses.join(" OR ")}) ORDER BY created_at ASC LIMIT 1`)
    .bind(...binds).first<PersonRow>();

  if (existing) {
    // Fill blanks only. A value already on the record was either entered by a human or seen first,
    // and neither should be overwritten by a later guess.
    const merged = {
      full_name: existing.full_name || (hints.name || "").trim(),
      phone: existing.phone || (hints.phone || "").trim(),
      email: existing.email || (hints.email || "").trim(),
      instagram_handle: existing.instagram_handle || (hints.instagramHandle || "").trim(),
      company: existing.company || (hints.company || "").trim(),
    };
    await db.prepare(`UPDATE crm_people SET full_name = ?, phone = ?, phone_key = ?, email = ?, email_key = ?,
      instagram_handle = ?, handle_key = ?, company = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(merged.full_name, merged.phone, phoneKey(merged.phone), merged.email, emailKey(merged.email),
        merged.instagram_handle, handleKey(merged.instagram_handle), merged.company, existing.id).run();
    return { ...existing, ...merged };
  }

  const id = newId("per");
  const tone = Math.abs([...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 6;
  await db.prepare(`INSERT INTO crm_people (id, workspace_id, full_name, phone, phone_key, email, email_key,
    instagram_handle, handle_key, company, avatar_tone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, workspaceId, (hints.name || "").trim(), (hints.phone || "").trim(), pk,
      (hints.email || "").trim(), ek, (hints.instagramHandle || "").trim(), hk, (hints.company || "").trim(), tone).run();
  return { id, full_name: (hints.name || "").trim(), phone: (hints.phone || "").trim(),
    email: (hints.email || "").trim(), instagram_handle: (hints.instagramHandle || "").trim(),
    company: (hints.company || "").trim(), avatar_tone: tone };
}

async function recordEvent(db: D1Database, workspaceId: string, kind: string, entityId: string): Promise<void> {
  await db.prepare(`INSERT INTO crm_events (workspace_id, kind, entity_id) VALUES (?, ?, ?)`)
    .bind(workspaceId, kind, entityId).run();
}

// The qualification lifecycle in one call. A conversation stays an anonymous thread until enough
// detail exists to reach the person back; at that moment it is linked to a person and a lead
// appears. Calling it again with the same details is a no-op, which is what keeps it duplicate-free.
export async function qualifyConversation(
  db: D1Database, workspaceId: string, channel: Channel, threadKey: string, hints: IdentityHints,
): Promise<{ personId: string; leadId: string; tier?: ResolutionTier } | null> {
  if (!hasQualifyingInfo(hints)) return null;

  // Every identifier this capture carried goes through the waterfall, strongest first. Running the
  // phone before the email matters: a phone is the identifier a WhatsApp thread is already keyed
  // on, so leading with it is what lets a web chat visitor collapse into an existing WhatsApp
  // customer instead of opening a second record for someone already in the pipeline.
  const attempts: Array<{ channel: IdentityChannel; raw: string }> = [];
  if (hints.phone) attempts.push({ channel: channel === "whatsapp" ? "whatsapp" : "manual", raw: hints.phone });
  if (hints.email) attempts.push({ channel: "email", raw: hints.email });
  if (hints.instagramHandle) attempts.push({ channel: "instagram", raw: hints.instagramHandle });

  let personId = "";
  let tier: ResolutionTier | undefined;
  for (const attempt of attempts) {
    const resolved = await resolveIdentity(db, workspaceId, attempt.channel, attempt.raw, {
      name: hints.name,
      company: hints.company,
      // Only a web chat thread carries a visitor token; for WhatsApp the thread key IS the phone.
      visitorId: channel === "webchat" ? threadKey : undefined,
      verified: true,
    });
    if (!resolved) continue;
    if (!personId) { personId = resolved.profileId; tier = resolved.tier; }
    // A later identifier resolving to a different existing profile means this capture just proved
    // the two are the same human — exactly the deterministic evidence a merge is allowed to act on.
    else if (resolved.profileId !== personId) {
      await absorbProfile(db, workspaceId, resolved.profileId, personId, "deterministic:shared-capture");
    }
  }
  if (!personId) {
    // Every identifier normalised to nothing usable — fall back rather than drop the capture.
    const person = await resolvePerson(db, workspaceId, hints);
    if (!person) return null;
    personId = person.id;
  }
  personId = await resolveTombstone(db, workspaceId, personId);

  const displayName = (hints.name || "").trim();
  await db.prepare(`UPDATE crm_conversations SET person_id = ?, display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
    updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND channel = ? AND thread_key = ?`)
    .bind(personId, displayName, displayName, workspaceId, channel, threadKey).run();

  const existingLead = await db.prepare(`SELECT id FROM crm_leads WHERE workspace_id = ? AND person_id = ?`)
    .bind(workspaceId, personId).first<{ id: string }>();
  let leadId = existingLead?.id || "";
  if (!leadId) {
    leadId = newId("lead");
    const sourceFor: Record<Channel, string> = { whatsapp: "WhatsApp", instagram: "Instagram", webchat: "Website" };
    await db.prepare(`INSERT INTO crm_leads (id, workspace_id, person_id, stage, source) VALUES (?, ?, ?, 'New', ?)`)
      .bind(leadId, workspaceId, personId, sourceFor[channel] || "Website").run();
  }
  await recordEvent(db, workspaceId, "lead", leadId);
  return { personId, leadId, tier };
}

/* ------------------------------------------------------------------ feed projection */

interface ThreadSeed {
  channel: Channel; threadKey: string; displayName: string;
  lastMessage: string; lastAt: string; lastRole: string; messageCount: number;
  aiActive: boolean; needsAttention: boolean; attentionReason: string;
}

// Web chat and WhatsApp each keep their own message tables, written by their own channel code.
// Rather than migrate that (and risk the live channels), the unified feed is projected from both on
// read and cached into crm_conversations, which is what every view then queries.
async function projectThreads(db: D1Database, workspaceId: string): Promise<ThreadSeed[]> {
  const [web, states, wa] = await Promise.all([
    db.prepare(`SELECT session_id, role, content, created_at FROM widget_messages
      WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 4000`)
      .bind(workspaceId).all<{ session_id: string; role: string; content: string; created_at: string }>().catch(() => null),
    db.prepare(`SELECT session_id, ai_active, needs_attention, attention_reason, customer_name
      FROM widget_conversation_state WHERE workspace_id = ?`)
      .bind(workspaceId).all<{ session_id: string; ai_active: number; needs_attention: number; attention_reason: string; customer_name: string }>().catch(() => null),
    db.prepare(`SELECT wa_id, direction, message_text, message_timestamp, created_at FROM whatsapp_messages
      WHERE workspace_id = ? AND wa_id IS NOT NULL ORDER BY created_at ASC LIMIT 4000`)
      .bind(workspaceId).all<{ wa_id: string; direction: string; message_text: string | null; message_timestamp: string | null; created_at: string }>().catch(() => null),
  ]);

  const stateBy = new Map((states?.results || []).map((r) => [r.session_id, r]));
  const seeds = new Map<string, ThreadSeed>();

  for (const row of web?.results || []) {
    const key = `webchat:${row.session_id}`;
    const seed = seeds.get(key);
    if (seed) { seed.lastMessage = row.content; seed.lastAt = row.created_at; seed.lastRole = row.role; seed.messageCount++; }
    else {
      const state = stateBy.get(row.session_id);
      seeds.set(key, {
        channel: "webchat", threadKey: row.session_id, displayName: state?.customer_name || "",
        lastMessage: row.content, lastAt: row.created_at, lastRole: row.role, messageCount: 1,
        aiActive: state?.ai_active !== 0, needsAttention: state?.needs_attention === 1,
        attentionReason: state?.attention_reason || "",
      });
    }
  }
  for (const row of wa?.results || []) {
    const key = `whatsapp:${row.wa_id}`;
    const seed = seeds.get(key);
    const role = row.direction === "inbound" ? "user" : "assistant";
    if (seed) { seed.lastMessage = row.message_text || "(attachment)"; seed.lastAt = row.created_at; seed.lastRole = role; seed.messageCount++; }
    else seeds.set(key, {
      channel: "whatsapp", threadKey: row.wa_id, displayName: `+${row.wa_id}`,
      lastMessage: row.message_text || "(attachment)", lastAt: row.created_at, lastRole: role,
      messageCount: 1, aiActive: true, needsAttention: false, attentionReason: "",
    });
  }
  return [...seeds.values()];
}

async function syncFeed(db: D1Database, workspaceId: string): Promise<void> {
  await ensureSchema(db);
  const seeds = await projectThreads(db, workspaceId);
  if (!seeds.length) return;
  const existing = await db.prepare(`SELECT channel, thread_key, message_count, state FROM crm_conversations WHERE workspace_id = ?`)
    .bind(workspaceId).all<{ channel: string; thread_key: string; message_count: number; state: string }>();
  const seen = new Map((existing.results || []).map((r) => [`${r.channel}:${r.thread_key}`, r]));

  const writes = seeds.map((s) => {
    const prior = seen.get(`${s.channel}:${s.threadKey}`);
    // Unread means "arrived since anyone looked", which is exactly: more messages than we last
    // recorded, and the newest one came from the customer.
    const unread = prior ? (s.messageCount > prior.message_count && s.lastRole === "user" ? 1 : 0) : (s.lastRole === "user" ? 1 : 0);
    return db.prepare(`INSERT INTO crm_conversations
      (id, workspace_id, channel, thread_key, display_name, last_message, last_at, last_role, message_count, unread, ai_active, needs_attention, attention_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel, thread_key) DO UPDATE SET
        display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE crm_conversations.display_name END,
        last_message = excluded.last_message, last_at = excluded.last_at, last_role = excluded.last_role,
        message_count = excluded.message_count,
        unread = CASE WHEN excluded.message_count > crm_conversations.message_count AND excluded.last_role = 'user' THEN 1 ELSE crm_conversations.unread END,
        ai_active = excluded.ai_active, needs_attention = excluded.needs_attention,
        attention_reason = excluded.attention_reason, updated_at = CURRENT_TIMESTAMP`)
      .bind(newId("conv"), workspaceId, s.channel, s.threadKey, s.displayName, s.lastMessage.slice(0, 300),
        s.lastAt, s.lastRole, s.messageCount, unread, s.aiActive ? 1 : 0, s.needsAttention ? 1 : 0, s.attentionReason);
  });
  for (let i = 0; i < writes.length; i += 40) await db.batch(writes.slice(i, i + 40));
}

/* ------------------------------------------------------------------ read models */

interface FeedRow {
  id: string; channel: string; thread_key: string; person_id: string | null; display_name: string;
  last_message: string; last_at: string; last_role: string; message_count: number; unread: number;
  ai_active: number; needs_attention: number; attention_reason: string; state: string;
  full_name: string | null; phone: string | null; email: string | null; instagram_handle: string | null;
  company: string | null; avatar_tone: number | null;
  lead_id: string | null; stage: string | null; priority: string | null; segment: string | null;
  source: string | null; owner: string | null; next_followup: string | null;
  score: number | null; score_reasons: string | null;
  is_online: number | null; visitor_last_seen: string | null;
}

function publicConversation(r: FeedRow) {
  return {
    id: r.id, channel: r.channel, threadKey: r.thread_key,
    name: r.full_name || r.display_name || (r.channel === "webchat" ? "Website visitor" : "Unknown"),
    lastMessage: r.last_message, lastAt: r.last_at, lastRole: r.last_role,
    messageCount: r.message_count, unread: r.unread === 1, aiActive: r.ai_active === 1,
    needsAttention: r.needs_attention === 1, attentionReason: r.attention_reason, state: r.state,
    online: r.is_online === 1, lastSeenAt: r.visitor_last_seen || "",
    person: r.person_id ? {
      id: r.person_id, name: r.full_name || "", phone: r.phone || "", email: r.email || "",
      instagramHandle: r.instagram_handle || "", company: r.company || "", avatarTone: r.avatar_tone || 0,
    } : null,
    lead: r.lead_id ? {
      id: r.lead_id, stage: r.stage || "New", priority: r.priority || "", segment: r.segment || "",
      source: r.source || "", owner: r.owner || "", nextFollowup: r.next_followup || "",
      score: typeof r.score === "number" ? r.score : null,
      scoreReasons: parseArray(r.score_reasons),
    } : null,
  };
}

function parseArray(raw: string | null | undefined): string[] {
  try { const p = JSON.parse(raw || "[]"); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
}

const FEED_SELECT = `SELECT c.id, c.channel, c.thread_key, c.person_id, c.display_name, c.last_message, c.last_at,
    c.last_role, c.message_count, c.unread, c.ai_active, c.needs_attention, c.attention_reason, c.state,
    p.full_name, p.phone, p.email, p.instagram_handle, p.company, p.avatar_tone,
    l.id AS lead_id, l.stage, l.priority, l.segment, l.source, l.owner, l.next_followup,
    s.score, s.score_reasons,
    -- Presence is decided in SQL rather than from a timestamp compared on the client, so every
    -- agent's screen agrees on who is online regardless of clock skew on their machine.
    CASE WHEN c.channel = 'webchat' AND ${ONLINE_SQL} THEN 1 ELSE 0 END AS is_online,
    v.last_seen AS visitor_last_seen
  FROM crm_conversations c
  LEFT JOIN crm_people p ON p.id = c.person_id
  LEFT JOIN crm_leads l ON l.person_id = c.person_id AND l.workspace_id = c.workspace_id
  LEFT JOIN crm_contacts s ON s.workspace_id = c.workspace_id AND s.session_id = c.thread_key
  LEFT JOIN widget_visitor_context v ON v.workspace_id = c.workspace_id AND v.session_id = c.thread_key`;

async function listConversations(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  if (new URL(request.url).searchParams.get("sync") !== "0") await syncFeed(env.DB, session.workspaceId);
  const rows = await env.DB.prepare(`${FEED_SELECT} WHERE c.workspace_id = ? ORDER BY c.last_at DESC LIMIT ?`)
    .bind(session.workspaceId, FEED_LIMIT).all<FeedRow>();
  const conversations = (rows.results || []).map(publicConversation);
  return json(request, {
    conversations,
    counts: {
      all: conversations.length,
      unread: conversations.filter((c) => c.unread).length,
      needsYou: conversations.filter((c) => c.needsAttention || !c.aiActive).length,
      newLeads: conversations.filter((c) => c.lead?.stage === "New").length,
      followUp: conversations.filter((c) => c.lead && !!c.lead.nextFollowup).length,
      closed: conversations.filter((c) => c.state === "closed").length,
    },
  });
}

async function getMessages(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
  const channel = (url.searchParams.get("channel") || "").trim();
  const threadKey = (url.searchParams.get("threadKey") || "").trim();
  if (!channel || !threadKey) return json(request, { error: "Missing channel or threadKey." }, 400);
  await ensureSchema(env.DB);

  let messages: Array<{ role: string; content: string; createdAt: string }> = [];
  if (channel === "webchat") {
    const rows = await env.DB.prepare(`SELECT role, content, created_at FROM widget_messages
      WHERE workspace_id = ? AND session_id = ? ORDER BY created_at ASC LIMIT ?`)
      .bind(session.workspaceId, threadKey, MESSAGE_LIMIT).all<{ role: string; content: string; created_at: string }>();
    messages = (rows.results || []).map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
  } else if (channel === "whatsapp") {
    const rows = await env.DB.prepare(`SELECT direction, message_text, created_at FROM whatsapp_messages
      WHERE workspace_id = ? AND wa_id = ? ORDER BY created_at ASC LIMIT ?`)
      .bind(session.workspaceId, threadKey, MESSAGE_LIMIT).all<{ direction: string; message_text: string | null; created_at: string }>();
    messages = (rows.results || []).map((r) => ({
      role: r.direction === "inbound" ? "user" : "assistant",
      content: r.message_text || "(attachment)", createdAt: r.created_at,
    }));
  }
  // Opening a thread is what clears its unread flag — the same rule a human would expect.
  await env.DB.prepare(`UPDATE crm_conversations SET unread = 0 WHERE workspace_id = ? AND channel = ? AND thread_key = ?`)
    .bind(session.workspaceId, channel, threadKey).run();
  await recordEvent(env.DB, session.workspaceId, "conversation", `${channel}:${threadKey}`);
  const stateRow = await env.DB.prepare(`SELECT handoff_summary FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`)
    .bind(session.workspaceId, threadKey).first<{ handoff_summary: string }>().catch(() => null);
  // Only web chat carries this — a WhatsApp thread arrives through Meta, not the visitor's browser.
  const visitor = channel === "webchat" ? await readVisitorContext(env.DB, session.workspaceId, threadKey) : null;
  const ended = channel === "webchat" ? await readEndedState(env.DB, session.workspaceId, threadKey) : null;
  return json(request, { messages, handoffSummary: parseHandoff(stateRow?.handoff_summary), visitor, ended });
}

/* ------------------------------------------------------------------ leads */

interface LeadRow extends FeedRow { lead_created: string; lead_updated: string; board_order: number }

const LEAD_SELECT = `SELECT l.id AS lead_id, l.stage, l.priority, l.segment, l.source, l.owner, l.next_followup,
    l.board_order, l.created_at AS lead_created, l.updated_at AS lead_updated,
    p.id AS person_id, p.full_name, p.phone, p.email, p.instagram_handle, p.company, p.avatar_tone,
    c.id, c.channel, c.thread_key, c.display_name, c.last_message, c.last_at, c.last_role,
    c.message_count, c.unread, c.ai_active, c.needs_attention, c.attention_reason, c.state,
    s.score, s.score_reasons
  FROM crm_leads l
  JOIN crm_people p ON p.id = l.person_id
  LEFT JOIN crm_conversations c ON c.person_id = p.id AND c.workspace_id = l.workspace_id
  LEFT JOIN crm_contacts s ON s.workspace_id = l.workspace_id AND s.session_id = c.thread_key`;

function publicLead(r: LeadRow) {
  return {
    id: r.lead_id!, stage: r.stage || "New", priority: r.priority || "", segment: r.segment || "",
    source: r.source || "", owner: r.owner || "", nextFollowup: r.next_followup || "",
    boardOrder: r.board_order, createdAt: r.lead_created, updatedAt: r.lead_updated,
    person: {
      id: r.person_id!, name: r.full_name || "Unnamed lead", phone: r.phone || "", email: r.email || "",
      instagramHandle: r.instagram_handle || "", company: r.company || "", avatarTone: r.avatar_tone || 0,
    },
    // A lead with no thread is the "No Conversation" case the table and board must render
    // differently — it is a real state, not missing data.
    conversation: r.thread_key ? {
      id: r.id, channel: r.channel, threadKey: r.thread_key, lastMessage: r.last_message,
      lastAt: r.last_at, unread: r.unread === 1, messageCount: r.message_count,
      aiActive: r.ai_active === 1, needsAttention: r.needs_attention === 1,
    } : null,
    score: typeof r.score === "number" ? r.score : null,
    scoreReasons: parseArray(r.score_reasons),
  };
}

async function listLeads(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`${LEAD_SELECT} WHERE l.workspace_id = ?
    ORDER BY l.updated_at DESC LIMIT ?`).bind(session.workspaceId, FEED_LIMIT).all<LeadRow>();
  // One lead can join several conversations; keep the most recent thread per lead.
  const byLead = new Map<string, LeadRow>();
  for (const row of rows.results || []) {
    const prior = byLead.get(row.lead_id!);
    if (!prior || (row.last_at || "") > (prior.last_at || "")) byLead.set(row.lead_id!, row);
  }
  return json(request, {
    leads: [...byLead.values()].map(publicLead),
    stages: PIPELINE_STAGES,
    options: { priorities: PRIORITIES, segments: SEGMENTS, sources: SOURCES },
  });
}

const EDITABLE = ["stage", "priority", "segment", "source", "owner", "next_followup", "board_order"] as const;

async function updateLead(request: Request, env: ConversationsEnv, leadId: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as Record<string, unknown>;
  await ensureSchema(env.DB);

  const sets: string[] = [];
  const binds: unknown[] = [];
  const incoming: Record<string, unknown> = {
    stage: body.stage, priority: body.priority, segment: body.segment, source: body.source,
    owner: body.owner, next_followup: body.nextFollowup, board_order: body.boardOrder,
  };
  for (const column of EDITABLE) {
    const value = incoming[column];
    if (value === undefined) continue;
    if (column === "stage" && !(PIPELINE_STAGES as readonly string[]).includes(String(value))) {
      return json(request, { error: "Unknown pipeline stage." }, 400);
    }
    sets.push(`${column} = ?`);
    binds.push(column === "board_order" ? Number(value) || 0 : String(value).slice(0, 120));
  }
  if (!sets.length) return json(request, { error: "Nothing to update." }, 400);

  await env.DB.prepare(`UPDATE crm_leads SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?`).bind(...binds, session.workspaceId, leadId).run();
  await recordEvent(env.DB, session.workspaceId, "lead", leadId);

  const row = await env.DB.prepare(`${LEAD_SELECT} WHERE l.workspace_id = ? AND l.id = ? ORDER BY c.last_at DESC LIMIT 1`)
    .bind(session.workspaceId, leadId).first<LeadRow>();
  return json(request, { lead: row ? publicLead(row) : null });
}

async function deleteLead(request: Request, env: ConversationsEnv, leadId: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  // The lead is the sales record; the person and their conversations outlive it. Deleting a lead
  // must never destroy the message history it was derived from.
  await env.DB.prepare(`DELETE FROM crm_leads WHERE workspace_id = ? AND id = ?`)
    .bind(session.workspaceId, leadId).run();
  await recordEvent(env.DB, session.workspaceId, "lead", leadId);
  return json(request, { ok: true });
}

// Manual qualification from the UI: an agent typing a phone number into the panel is the same
// lifecycle event as the AI capturing one, and goes through the same dedup path.
async function qualify(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { channel?: string; threadKey?: string } & IdentityHints;
  const channel = (body.channel || "") as Channel;
  const threadKey = (body.threadKey || "").trim();
  if (!channel || !threadKey) return json(request, { error: "Missing channel or threadKey." }, 400);
  await ensureSchema(env.DB);
  const result = await qualifyConversation(env.DB, session.workspaceId, channel, threadKey, body);
  if (!result) return json(request, { error: "Add a phone number, email or Instagram handle to create a lead." }, 400);
  const row = await env.DB.prepare(`${LEAD_SELECT} WHERE l.workspace_id = ? AND l.id = ? ORDER BY c.last_at DESC LIMIT 1`)
    .bind(session.workspaceId, result.leadId).first<LeadRow>();
  return json(request, { lead: row ? publicLead(row) : null });
}

/* ------------------------------------------------------------------ live sync */

// The delta endpoint both transports share. A client sends the highest seq it has seen and gets
// back only what changed since — so the Leads table and an open chat drawer converge without
// either re-fetching the world.
async function sync(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const since = Number(new URL(request.url).searchParams.get("since") || 0);
  const rows = await env.DB.prepare(`SELECT seq, kind, entity_id FROM crm_events
    WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200`)
    .bind(session.workspaceId, since).all<{ seq: number; kind: string; entity_id: string }>();
  const events = rows.results || [];
  const head = await env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM crm_events WHERE workspace_id = ?`)
    .bind(session.workspaceId).first<{ seq: number }>();
  return json(request, {
    cursor: head?.seq || since,
    events: events.map((e) => ({ seq: e.seq, kind: e.kind, entityId: e.entity_id })),
  });
}


// Whether a human has taken this thread over. widget_conversation_state was built for web chat but
// its (workspace, thread) shape is channel-agnostic, so WhatsApp reuses it rather than growing a
// second table that would have to be kept in step.

interface HandoffSummary { summary: string; focusOn: string; customerNotes: string }

function parseHandoff(raw: string | null | undefined): HandoffSummary | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as HandoffSummary; } catch { return null; }
}

async function readThreadHistory(db: D1Database, workspaceId: string, channel: Channel, threadKey: string): Promise<ChatMessage[]> {
  if (channel === "whatsapp") {
    const rows = await db.prepare(`SELECT direction, message_text FROM whatsapp_messages
      WHERE workspace_id = ? AND wa_id = ? AND message_text IS NOT NULL ORDER BY created_at ASC LIMIT 50`)
      .bind(workspaceId, threadKey).all<{ direction: string; message_text: string }>();
    return (rows.results || []).map((r) => ({ role: r.direction === "inbound" ? "user" as const : "assistant" as const, content: r.message_text }));
  }
  const rows = await db.prepare(`SELECT role, content FROM widget_messages
    WHERE workspace_id = ? AND session_id = ? ORDER BY created_at ASC LIMIT 50`)
    .bind(workspaceId, threadKey).all<{ role: string; content: string }>();
  return (rows.results || [])
    .filter((r) => r.role === "user" || r.role === "assistant" || r.role === "agent")
    .map((r) => ({ role: r.role === "user" ? "user" as const : "assistant" as const, content: r.content }));
}

// The note an agent reads the instant they take a conversation over — what it's about, what to do
// next, and anything worth knowing about this customer. web chat has generated this for a while;
// this is the same behaviour made to work for every channel rather than just one.
async function generateHandoffSummary(env: ConversationsEnv, workspaceId: string, channel: Channel, threadKey: string): Promise<void> {
  if (!threadKey || !env.ANTHROPIC_API_KEY) return;
  try {
    const history = await readThreadHistory(env.DB, workspaceId, channel, threadKey);
    if (!history.length) return;
    const transcript = history.map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`).join("\n");
    const prompt = `Here is a customer support conversation so far:\n\n${transcript}\n\nA human agent is now taking over this conversation. Write a brief handoff note for them. Respond with ONLY a JSON object, no markdown fences, in exactly this shape:\n{"summary": "1-2 sentences on what this conversation is about and where it left off", "focusOn": "1-2 sentences on what the agent should do or resolve next", "customerNotes": "1-2 sentences on anything worth knowing about this customer — tone, patience level, prior requests, anything already established (name, order, etc.) — or empty string if nothing notable"}`;
    const result = await callClaude(env.ANTHROPIC_API_KEY, "You write extremely concise, practical handoff notes for customer support agents. Respond with strict JSON only.", [{ role: "user", content: prompt }]);
    if (result.error || !result.reply) return;
    const cleaned = result.reply.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { summary?: string; focusOn?: string; customerNotes?: string };
    const summary: HandoffSummary = { summary: (parsed.summary || "").slice(0, 400), focusOn: (parsed.focusOn || "").slice(0, 400), customerNotes: (parsed.customerNotes || "").slice(0, 400) };
    await env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, handoff_summary) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, session_id) DO UPDATE SET handoff_summary = excluded.handoff_summary`)
      .bind(workspaceId, threadKey, JSON.stringify(summary)).run();
  } catch { /* a missing summary just means the agent reads the transcript themselves */ }
}

export async function isAiPaused(db: D1Database, workspaceId: string, threadKey: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ai_active FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`)
    .bind(workspaceId, threadKey).first<{ ai_active: number }>().catch(() => null);
  return row?.ai_active === 0;
}

// Takeover for channels other than web chat. Web chat keeps using /api/widget/takeover, which also
// writes a visible system line into the thread and generates a handoff brief — behaviour worth
// leaving exactly where it already works rather than reimplementing here.
async function setTakeover(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { threadKey?: string; active?: boolean };
  const threadKey = (body.threadKey || "").trim();
  if (!threadKey) return json(request, { error: "Missing threadKey." }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, ai_active) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET ai_active = excluded.ai_active`)
    .bind(session.workspaceId, threadKey, body.active ? 1 : 0).run();
  await env.DB.prepare(`UPDATE crm_conversations SET ai_active = ?, needs_attention = CASE WHEN ? = 0 THEN 0 ELSE needs_attention END,
    updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND thread_key = ?`)
    .bind(body.active ? 1 : 0, body.active ? 1 : 0, session.workspaceId, threadKey).run();
  await recordEvent(env.DB, session.workspaceId, "conversation", threadKey);
  if (!body.active) {
    const row = await env.DB.prepare(`SELECT channel FROM crm_conversations WHERE workspace_id = ? AND thread_key = ?`)
      .bind(session.workspaceId, threadKey).first<{ channel: Channel }>();
    if (row) await generateHandoffSummary(env, session.workspaceId, row.channel, threadKey);
  }
  return json(request, { ok: true, aiActive: Boolean(body.active) });
}


/* ------------------------------------------------------------------ profiles (hub view) */

interface ProfileListRow {
  id: string; full_name: string; company: string; avatar_tone: number; created_at: string;
  identity_count: number; conversation_count: number; channels: string | null;
  lead_id: string | null; stage: string | null; priority: string | null;
  last_at: string | null; unread_count: number;
}

// The hub as the customer sees it: one row per person, with everything they have ever used to
// reach the business folded in. Counting identities and conversations here rather than in the
// client is what keeps the list one query instead of one-per-profile.
async function listProfiles(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  if (new URL(request.url).searchParams.get("sync") !== "0") await syncFeed(env.DB, session.workspaceId);

  const rows = await env.DB.prepare(`SELECT p.id, p.full_name, p.company, p.avatar_tone, p.created_at,
      (SELECT count(*) FROM crm_identities i WHERE i.workspace_id = p.workspace_id AND i.profile_id = p.id) identity_count,
      (SELECT count(*) FROM crm_conversations c WHERE c.workspace_id = p.workspace_id AND c.person_id = p.id) conversation_count,
      (SELECT group_concat(DISTINCT c.channel) FROM crm_conversations c WHERE c.workspace_id = p.workspace_id AND c.person_id = p.id) channels,
      (SELECT max(c.last_at) FROM crm_conversations c WHERE c.workspace_id = p.workspace_id AND c.person_id = p.id) last_at,
      (SELECT count(*) FROM crm_conversations c WHERE c.workspace_id = p.workspace_id AND c.person_id = p.id AND c.unread = 1) unread_count,
      l.id lead_id, l.stage, l.priority
    FROM crm_people p
    LEFT JOIN crm_leads l ON l.person_id = p.id AND l.workspace_id = p.workspace_id
    WHERE p.workspace_id = ? AND p.is_active = 1
    ORDER BY last_at DESC NULLS LAST, p.created_at DESC LIMIT ?`)
    .bind(session.workspaceId, FEED_LIMIT).all<ProfileListRow>();

  return json(request, {
    profiles: (rows.results || []).map((r) => ({
      id: r.id, name: r.full_name || "Unnamed contact", company: r.company || "", avatarTone: r.avatar_tone || 0,
      identityCount: r.identity_count, conversationCount: r.conversation_count,
      channels: (r.channels || "").split(",").filter(Boolean),
      lastAt: r.last_at || "", unread: r.unread_count > 0,
      lead: r.lead_id ? { id: r.lead_id, stage: r.stage || "New", priority: r.priority || "" } : null,
    })),
  });
}

/**
 * One profile, everything about them — including the merged timeline.
 *
 * This is the payoff of the hub-and-spoke model: messages from every channel interleaved in true
 * chronological order and tagged with where each arrived, so a WhatsApp exchange and a web chat two
 * days later read as one conversation with one person rather than two unrelated threads.
 */
async function getProfile(request: Request, env: ConversationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const profileId = (new URL(request.url).searchParams.get("profileId") || "").trim();
  if (!profileId) return json(request, { error: "Missing profileId." }, 400);
  await ensureSchema(env.DB);

  const person = await env.DB.prepare(`SELECT id, full_name, company, phone, email, instagram_handle, avatar_tone, created_at, is_active, merged_into_id
    FROM crm_people WHERE workspace_id = ? AND id = ?`)
    .bind(session.workspaceId, profileId).first<{ id: string; full_name: string; company: string; phone: string; email: string; instagram_handle: string; avatar_tone: number; created_at: string; is_active: number; merged_into_id: string }>();
  if (!person) return json(request, { error: "Profile not found." }, 404);

  const [identities, conversations, lead] = await Promise.all([
    env.DB.prepare(`SELECT id, channel, kind, identifier_value, normalized_value, is_verified, created_at
      FROM crm_identities WHERE workspace_id = ? AND profile_id = ? ORDER BY created_at ASC`)
      .bind(session.workspaceId, profileId).all<{ id: string; channel: string; kind: string; identifier_value: string; normalized_value: string; is_verified: number; created_at: string }>()
      .catch(() => null),
    env.DB.prepare(`SELECT id, channel, thread_key, last_message, last_at, message_count, unread, ai_active
      FROM crm_conversations WHERE workspace_id = ? AND person_id = ? ORDER BY last_at DESC`)
      .bind(session.workspaceId, profileId).all<{ id: string; channel: string; thread_key: string; last_message: string; last_at: string; message_count: number; unread: number; ai_active: number }>(),
    env.DB.prepare(`SELECT id, stage, priority, segment, source, owner, next_followup FROM crm_leads
      WHERE workspace_id = ? AND person_id = ?`).bind(session.workspaceId, profileId)
      .first<{ id: string; stage: string; priority: string; segment: string; source: string; owner: string; next_followup: string }>(),
  ]);

  const threads = conversations.results || [];
  const timeline: Array<{ channel: string; threadKey: string; role: string; content: string; createdAt: string }> = [];
  // Bounded per thread rather than in total: a chatty web chat must not crowd out the WhatsApp
  // exchange that actually matters, which is precisely what a global LIMIT would do.
  const perThread = Math.max(20, Math.floor(MESSAGE_LIMIT / Math.max(1, threads.length)));
  for (const thread of threads) {
    if (thread.channel === "webchat") {
      const rows = await env.DB.prepare(`SELECT role, content, created_at FROM widget_messages
        WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(session.workspaceId, thread.thread_key, perThread).all<{ role: string; content: string; created_at: string }>();
      for (const m of rows.results || []) timeline.push({ channel: "webchat", threadKey: thread.thread_key, role: m.role, content: m.content, createdAt: m.created_at });
    } else if (thread.channel === "whatsapp") {
      const rows = await env.DB.prepare(`SELECT direction, message_text, created_at FROM whatsapp_messages
        WHERE workspace_id = ? AND wa_id = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(session.workspaceId, thread.thread_key, perThread).all<{ direction: string; message_text: string | null; created_at: string }>();
      for (const m of rows.results || []) timeline.push({
        channel: "whatsapp", threadKey: thread.thread_key,
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.message_text || "(attachment)", createdAt: m.created_at,
      });
    }
  }
  timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return json(request, {
    profile: {
      id: person.id, name: person.full_name || "Unnamed contact", company: person.company || "",
      avatarTone: person.avatar_tone || 0, createdAt: person.created_at,
      isActive: person.is_active === 1, mergedIntoId: person.merged_into_id || "",
    },
    // Falls back to the legacy hub columns when the backfill has not run yet, so this view is
    // never blank on a workspace that has not been migrated.
    identities: (identities?.results || []).length
      ? (identities!.results || []).map((r) => ({
          id: r.id, channel: r.channel, kind: r.kind, value: r.identifier_value,
          normalized: r.normalized_value, verified: r.is_verified === 1,
        }))
      : [
          person.phone ? { id: "legacy-phone", channel: "whatsapp", kind: "phone", value: person.phone, normalized: person.phone, verified: false } : null,
          person.email ? { id: "legacy-email", channel: "email", kind: "email", value: person.email, normalized: person.email, verified: false } : null,
          person.instagram_handle ? { id: "legacy-ig", channel: "instagram", kind: "handle", value: person.instagram_handle, normalized: person.instagram_handle, verified: false } : null,
        ].filter(Boolean),
    conversations: threads.map((t) => ({
      id: t.id, channel: t.channel, threadKey: t.thread_key, lastMessage: t.last_message,
      lastAt: t.last_at, messageCount: t.message_count, unread: t.unread === 1, aiActive: t.ai_active === 1,
    })),
    lead: lead ? {
      id: lead.id, stage: lead.stage || "New", priority: lead.priority || "", segment: lead.segment || "",
      source: lead.source || "", owner: lead.owner || "", nextFollowup: lead.next_followup || "",
    } : null,
    timeline,
  });
}

export async function handleConversationsRequest(request: Request, env: ConversationsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/cx/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/cx/conversations" && request.method === "GET") return listConversations(request, env);
  if (url.pathname === "/api/cx/messages" && request.method === "GET") return getMessages(request, env);
  if (url.pathname === "/api/cx/leads" && request.method === "GET") return listLeads(request, env);
  if (url.pathname === "/api/cx/profiles" && request.method === "GET") return listProfiles(request, env);
  if (url.pathname === "/api/cx/profile" && request.method === "GET") return getProfile(request, env);
  if (url.pathname === "/api/cx/qualify" && request.method === "POST") return qualify(request, env);
  if (url.pathname === "/api/cx/sync" && request.method === "GET") return sync(request, env);
  if (url.pathname === "/api/cx/takeover" && request.method === "POST") return setTakeover(request, env);
  const leadMatch = url.pathname.match(/^\/api\/cx\/leads\/([\w-]+)$/);
  if (leadMatch && request.method === "PATCH") return updateLead(request, env, leadMatch[1]);
  if (leadMatch && request.method === "DELETE") return deleteLead(request, env, leadMatch[1]);
  return null;
}
