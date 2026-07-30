import { callClaude, json, corsPreflight, allowedOrigin, type ChatMessage } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface CrmEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

export interface CrmContact {
  sessionId: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  labels: string[];
  score: number | null;
  scoreReasons: string[];
  scoredAt: string | null;
  updatedAt: string | null;
}

const MAX_LABELS = 12;
const MAX_LABEL_LENGTH = 28;
const MAX_FIELD_LENGTH = 120;
// Enough turns for intent to be obvious without paying for a whole long conversation on every
// rescore. The most recent messages carry the buying signal, so this takes from the end.
const SCORING_TURNS = 24;

let schemaReady = false;

async function ensureCrmSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_contacts (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      labels TEXT NOT NULL DEFAULT '[]',
      score INTEGER,
      score_reasons TEXT NOT NULL DEFAULT '[]',
      scored_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, session_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_score ON crm_contacts (workspace_id, score DESC)`),
  ]);
  schemaReady = true;
}

function cleanLabel(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
}

function parseLabels(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      const label = cleanLabel(item);
      // Case-insensitive de-dupe: "VIP" and "vip" are the same label to a human reading the panel.
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      out.push(label);
      if (out.length >= MAX_LABELS) break;
    }
    return out;
  } catch { return []; }
}

function parseReasons(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map((r) => String(r).slice(0, 140)).filter(Boolean).slice(0, 6) : [];
  } catch { return []; }
}

interface ContactRow {
  session_id: string; name: string; email: string; phone: string; company: string;
  labels: string; score: number | null; score_reasons: string; scored_at: string | null; updated_at: string;
}

function publicContact(sessionId: string, row: ContactRow | null): CrmContact {
  return {
    sessionId,
    name: row?.name || "",
    email: row?.email || "",
    phone: row?.phone || "",
    company: row?.company || "",
    labels: parseLabels(row?.labels),
    score: typeof row?.score === "number" ? row.score : null,
    scoreReasons: parseReasons(row?.score_reasons),
    scoredAt: row?.scored_at || null,
    updatedAt: row?.updated_at || null,
  };
}

// Details the conversation already surfaced elsewhere — the name the assistant learned, and any
// email/phone/company a lead form captured. Used only to fill blanks: anything an agent has typed
// into the CRM record by hand outranks a value guessed from chat.
async function discoverKnownFields(db: D1Database, workspaceId: string, sessionId: string): Promise<{ name: string; email: string; phone: string; company: string }> {
  const found = { name: "", email: "", phone: "", company: "" };
  const [stateRes, submissionRes] = await Promise.all([
    db.prepare(`SELECT customer_name FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`)
      .bind(workspaceId, sessionId).first<{ customer_name: string }>().catch(() => null),
    db.prepare(`SELECT data FROM action_submissions WHERE workspace_id = ? AND session_id = ? ORDER BY updated_at DESC`)
      .bind(workspaceId, sessionId).all<{ data: string }>().catch(() => null),
  ]);
  if (stateRes?.customer_name) found.name = stateRes.customer_name;
  for (const row of submissionRes?.results || []) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { continue; }
    for (const [key, value] of Object.entries(data)) {
      const text = String(value ?? "").trim();
      if (!text) continue;
      const k = key.toLowerCase();
      if (!found.email && (k.includes("email") || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text))) found.email = text;
      else if (!found.phone && (k.includes("phone") || k.includes("mobile") || k.includes("whatsapp"))) found.phone = text;
      else if (!found.company && (k.includes("company") || k.includes("organisation") || k.includes("organization"))) found.company = text;
      else if (!found.name && (k === "name" || k.includes("full name") || k.includes("customer name"))) found.name = text;
    }
  }
  return found;
}

async function readContact(db: D1Database, workspaceId: string, sessionId: string): Promise<CrmContact> {
  const row = await db.prepare(`SELECT session_id, name, email, phone, company, labels, score, score_reasons, scored_at, updated_at
    FROM crm_contacts WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).first<ContactRow>();
  const contact = publicContact(sessionId, row || null);
  const known = await discoverKnownFields(db, workspaceId, sessionId);
  // Blanks only — never overwrite what a person put there.
  if (!contact.name) contact.name = known.name;
  if (!contact.email) contact.email = known.email;
  if (!contact.phone) contact.phone = known.phone;
  if (!contact.company) contact.company = known.company;
  return contact;
}

async function getContact(request: Request, env: CrmEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const sessionId = (new URL(request.url).searchParams.get("sessionId") || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureCrmSchema(env.DB);
  return json(request, { contact: await readContact(env.DB, session.workspaceId, sessionId) });
}

async function updateContact(request: Request, env: CrmEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as Partial<Record<"sessionId" | "name" | "email" | "phone" | "company", string>> & { labels?: unknown };
  const sessionId = (body.sessionId || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureCrmSchema(env.DB);

  const existing = await env.DB.prepare(`SELECT session_id, name, email, phone, company, labels, score, score_reasons, scored_at, updated_at
    FROM crm_contacts WHERE workspace_id = ? AND session_id = ?`).bind(session.workspaceId, sessionId).first<ContactRow>();
  const current = publicContact(sessionId, existing || null);
  const text = (key: "name" | "email" | "phone" | "company") =>
    body[key] === undefined ? current[key] : String(body[key]).trim().slice(0, MAX_FIELD_LENGTH);
  const labels = body.labels === undefined ? current.labels : parseLabels(JSON.stringify(body.labels));

  await env.DB.prepare(`INSERT INTO crm_contacts (workspace_id, session_id, name, email, phone, company, labels, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET
      name = excluded.name, email = excluded.email, phone = excluded.phone,
      company = excluded.company, labels = excluded.labels, updated_at = CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, sessionId, text("name"), text("email"), text("phone"), text("company"), JSON.stringify(labels)).run();

  return json(request, { contact: await readContact(env.DB, session.workspaceId, sessionId) });
}

function parseScoreResponse(reply: string): { score: number; reasons: string[] } | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; reasons?: unknown };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (!Number.isFinite(score)) return null;
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.map((r) => String(r).trim().slice(0, 140)).filter(Boolean).slice(0, 4)
      : [];
    return { score, reasons };
  } catch { return null; }
}

// Scores intent from what the visitor actually said. Deliberately a separate, explicitly-triggered
// call rather than something that runs on every inbound message: it costs a model call per run, and
// a score is only worth refreshing once a conversation has moved on.
async function scoreContact(request: Request, env: CrmEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!env.ANTHROPIC_API_KEY) return json(request, { error: "AI is not configured for this workspace." }, 503);
  const body = await request.json() as { sessionId?: string };
  const sessionId = (body.sessionId || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureCrmSchema(env.DB);

  const history = await env.DB.prepare(`SELECT role, content FROM widget_messages
    WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(session.workspaceId, sessionId, SCORING_TURNS).all<{ role: string; content: string }>();
  const turns = (history.results || []).reverse();
  if (!turns.length) return json(request, { error: "This conversation has no messages to score yet." }, 400);

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.content}`)
    .join("\n")
    .slice(0, 6000);

  const systemPrompt = [
    "You score sales-lead intent from a customer support conversation.",
    "Return ONLY JSON: {\"score\": <0-100 integer>, \"reasons\": [\"short reason\", ...]}.",
    "Score what the visitor demonstrably said or asked for — never what they might want.",
    "0-30 browsing or a general question. 31-60 real interest but no commitment.",
    "61-85 clear need with specifics such as dates, budget, quantity or timeline.",
    "86-100 explicitly asking to buy, book, or speak to a person.",
    "Give 2-4 reasons, each under 12 words, each pointing at something in the conversation.",
    "If the visitor barely said anything, score low and say so — do not pad the score.",
  ].join(" ");

  const messages: ChatMessage[] = [{ role: "user", content: `Conversation:\n${transcript}` }];
  const result = await callClaude(env.ANTHROPIC_API_KEY, systemPrompt, messages, 400);
  if (result.error || !result.reply) return json(request, { error: result.error || "Could not score this conversation." }, result.status || 502);
  const parsed = parseScoreResponse(result.reply);
  if (!parsed) return json(request, { error: "Could not score this conversation." }, 502);

  await env.DB.prepare(`INSERT INTO crm_contacts (workspace_id, session_id, score, score_reasons, scored_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET
      score = excluded.score, score_reasons = excluded.score_reasons,
      scored_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, sessionId, parsed.score, JSON.stringify(parsed.reasons)).run();

  return json(request, { contact: await readContact(env.DB, session.workspaceId, sessionId) });
}

export async function handleCrmRequest(request: Request, env: CrmEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/crm/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/crm/contact" && request.method === "GET") return getContact(request, env);
  if (url.pathname === "/api/crm/contact" && request.method === "PATCH") return updateContact(request, env);
  if (url.pathname === "/api/crm/score" && request.method === "POST") return scoreContact(request, env);
  return null;
}
