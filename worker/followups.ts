import { callClaude, json, corsPreflight, allowedOrigin, type ChatMessage } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface FollowupsEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

// How far back a conversation can be and still be worth chasing. Beyond this a "follow-up" is
// really a new outreach, and putting it on a daily to-do list just makes the list impossible.
const LOOKBACK_DAYS = 14;
// A visitor who wrote 20 minutes ago is mid-conversation, not abandoned. Anything older with no
// reply is genuinely someone left waiting.
const WAITING_MINUTES = 20;
const QUIET_HOURS = 20;
const HOT_SCORE = 70;
const WARM_SCORE = 40;
// The model is asked to phrase actions for at most this many, highest-signal first. Everything
// beyond it still appears on the list with its deterministic wording — nothing is silently dropped.
const MAX_MODEL_ITEMS = 15;
const TRANSCRIPT_TAIL = 6;

type ReasonCode = "waiting" | "escalation" | "hot_lead" | "promise" | "went_quiet";

const REASON_LABEL: Record<ReasonCode, string> = {
  waiting: "Waiting on a reply",
  escalation: "Asked for a human",
  hot_lead: "Hot lead, never contacted",
  promise: "We promised to follow up",
  went_quiet: "Went quiet after showing interest",
};

// Deterministic ranking so the same day's list is stable, and so the model's budget goes to the
// conversations that most need a human.
const REASON_RANK: Record<ReasonCode, number> = {
  escalation: 0, promise: 1, waiting: 2, hot_lead: 3, went_quiet: 4,
};

const PROMISE_PATTERNS = [
  /\bget back to you\b/i, /\bwill (?:be in touch|contact you|reach out|follow up)\b/i,
  /\bsomeone (?:will|from our team will)\b/i, /\bour team will\b/i,
  /\ba (?:specialist|colleague|team member) will\b/i, /\bnotified (?:our|the) team\b/i,
  /\bhas been (?:flagged|notified)\b/i,
];

let schemaReady = false;

async function ensureFollowupsSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS followups (
      workspace_id TEXT NOT NULL,
      day TEXT NOT NULL,
      session_id TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      why TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      score INTEGER,
      last_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, day, session_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_followups_day ON followups (workspace_id, day, status)`),
  ]);
  schemaReady = true;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Candidate {
  sessionId: string;
  customerName: string;
  reason: ReasonCode;
  lastAt: string;
  lastRole: string;
  score: number | null;
  tail: Array<{ role: string; content: string }>;
  fallbackAction: string;
}

// Everything that decides "this needs a human tomorrow morning" is a rule, not a judgement call —
// so it runs for free, always, and the same inputs always produce the same list. The model is only
// asked to phrase what to do about it.
async function findCandidates(db: D1Database, workspaceId: string): Promise<Candidate[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const [messages, states, contacts, pushes] = await Promise.all([
    db.prepare(`SELECT session_id, role, content, created_at FROM widget_messages
      WHERE workspace_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 4000`)
      .bind(workspaceId, since).all<{ session_id: string; role: string; content: string; created_at: string }>(),
    db.prepare(`SELECT session_id, ai_active, needs_attention, attention_reason, customer_name
      FROM widget_conversation_state WHERE workspace_id = ?`)
      .bind(workspaceId).all<{ session_id: string; ai_active: number; needs_attention: number; attention_reason: string; customer_name: string }>()
      .catch(() => null),
    db.prepare(`SELECT session_id, name, score FROM crm_contacts WHERE workspace_id = ?`)
      .bind(workspaceId).all<{ session_id: string; name: string; score: number | null }>().catch(() => null),
    db.prepare(`SELECT DISTINCT session_id FROM crm_pushes WHERE workspace_id = ?`)
      .bind(workspaceId).all<{ session_id: string }>().catch(() => null),
  ]);

  const bySession = new Map<string, Array<{ role: string; content: string; created_at: string }>>();
  for (const row of messages.results || []) {
    const list = bySession.get(row.session_id) || [];
    list.push({ role: row.role, content: row.content, created_at: row.created_at });
    bySession.set(row.session_id, list);
  }

  const stateBy = new Map((states?.results || []).map((r) => [r.session_id, r]));
  const contactBy = new Map((contacts?.results || []).map((r) => [r.session_id, r]));
  const pushed = new Set((pushes?.results || []).map((r) => r.session_id));

  const now = Date.now();
  const candidates: Candidate[] = [];

  for (const [sessionId, turns] of bySession) {
    if (!turns.length) continue;
    const last = turns[turns.length - 1];
    const lastAtMs = Date.parse(last.created_at.replace(" ", "T") + "Z");
    const minutesSince = Number.isFinite(lastAtMs) ? (now - lastAtMs) / 60000 : 0;
    const state = stateBy.get(sessionId);
    const contact = contactBy.get(sessionId);
    const score = typeof contact?.score === "number" ? contact.score : null;
    const customerName = contact?.name || state?.customer_name || "";
    const agentReplied = turns.some((t) => t.role === "agent");

    // An agent already handled it and the visitor hasn't come back — nothing outstanding.
    const visitorSpokeLast = last.role === "user";

    let reason: ReasonCode | null = null;
    let fallbackAction = "";

    if (state?.needs_attention === 1) {
      reason = "escalation";
      fallbackAction = `Reply to ${customerName || "this visitor"} — they asked for a person${state.attention_reason ? ` (${state.attention_reason})` : ""}.`;
    } else if (visitorSpokeLast && state?.ai_active === 0 && minutesSince >= WAITING_MINUTES) {
      // The AI was switched off for this conversation, so nobody is answering unless a human does.
      reason = "waiting";
      fallbackAction = `Reply to ${customerName || "this visitor"} — you took over and they're still waiting.`;
    } else if (!agentReplied && turns.slice(-4).some((t) => t.role === "assistant" && PROMISE_PATTERNS.some((p) => p.test(t.content)))) {
      reason = "promise";
      fallbackAction = `Follow up with ${customerName || "this visitor"} — the assistant promised someone would get back to them.`;
    } else if (score !== null && score >= HOT_SCORE && !pushed.has(sessionId)) {
      reason = "hot_lead";
      fallbackAction = `Contact ${customerName || "this lead"} — scored ${score} and nobody has picked it up.`;
    } else if (score !== null && score >= WARM_SCORE && visitorSpokeLast === false && minutesSince >= QUIET_HOURS * 60) {
      reason = "went_quiet";
      fallbackAction = `Check back in with ${customerName || "this visitor"} — they showed interest then went quiet.`;
    }

    if (!reason) continue;
    candidates.push({
      sessionId, customerName, reason, lastAt: last.created_at, lastRole: last.role, score,
      tail: turns.slice(-TRANSCRIPT_TAIL).map((t) => ({ role: t.role, content: t.content.slice(0, 400) })),
      fallbackAction,
    });
  }

  candidates.sort((a, b) =>
    REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
    (b.score ?? -1) - (a.score ?? -1) ||
    a.lastAt.localeCompare(b.lastAt));
  return candidates;
}

interface PhrasedItem { action: string; why: string; priority: string }

async function phraseActions(apiKey: string, candidates: Candidate[]): Promise<Map<string, PhrasedItem>> {
  const out = new Map<string, PhrasedItem>();
  const batch = candidates.slice(0, MAX_MODEL_ITEMS);
  if (!batch.length) return out;

  const brief = batch.map((c, i) => {
    const transcript = c.tail.map((t) => `${t.role === "user" ? "Visitor" : t.role === "agent" ? "Agent" : "Assistant"}: ${t.content}`).join("\n");
    return `[${i}] reason=${c.reason}${c.score !== null ? ` score=${c.score}` : ""} name=${c.customerName || "unknown"}\n${transcript}`;
  }).join("\n\n---\n\n");

  const systemPrompt = [
    "You turn stalled customer conversations into a to-do list for a support team.",
    "Return ONLY a JSON array, one object per input item, in the same order:",
    '[{"i":0,"action":"...","why":"...","priority":"high|medium|low"}]',
    "action: what a person should do next, imperative, under 14 words, naming the specific thing (\"Send Joel the Arabic menu pricing\", not \"Follow up\").",
    "why: the evidence from the conversation, under 12 words.",
    "priority: high if the customer is waiting or asked for a person; medium if there is real buying intent; low otherwise.",
    "Never invent facts that are not in the conversation. If a conversation shows nothing actionable, still return an entry with priority low.",
  ].join(" ");

  const messages: ChatMessage[] = [{ role: "user", content: brief }];
  const result = await callClaude(apiKey, systemPrompt, messages, 1600);
  if (result.error || !result.reply) return out;
  const match = result.reply.match(/\[[\s\S]*\]/);
  if (!match) return out;
  try {
    const parsed = JSON.parse(match[0]) as Array<{ i?: number; action?: string; why?: string; priority?: string }>;
    for (const row of parsed) {
      const candidate = typeof row.i === "number" ? batch[row.i] : undefined;
      if (!candidate || !row.action) continue;
      const priority = ["high", "medium", "low"].includes(String(row.priority)) ? String(row.priority) : "medium";
      out.set(candidate.sessionId, { action: String(row.action).slice(0, 160), why: String(row.why || "").slice(0, 160), priority });
    }
  } catch { /* fall through to the deterministic wording */ }
  return out;
}

async function refresh(request: Request, env: FollowupsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFollowupsSchema(env.DB);
  const day = today();

  const candidates = await findCandidates(env.DB, session.workspaceId);
  const phrased = env.ANTHROPIC_API_KEY ? await phraseActions(env.ANTHROPIC_API_KEY, candidates) : new Map<string, PhrasedItem>();

  if (candidates.length) {
    // Re-running the day keeps whatever the team already ticked off, so a refresh never resurrects
    // completed work.
    await env.DB.batch(candidates.map((c) => {
      const item = phrased.get(c.sessionId);
      const priority = item?.priority || (c.reason === "escalation" || c.reason === "waiting" ? "high" : c.reason === "hot_lead" ? "medium" : "low");
      return env.DB.prepare(`INSERT INTO followups
        (workspace_id, day, session_id, reason_code, customer_name, action, why, priority, score, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, day, session_id) DO UPDATE SET
          reason_code = excluded.reason_code, customer_name = excluded.customer_name,
          action = excluded.action, why = excluded.why, priority = excluded.priority,
          score = excluded.score, last_at = excluded.last_at`)
        .bind(session.workspaceId, day, c.sessionId, c.reason, c.customerName,
          item?.action || c.fallbackAction, item?.why || REASON_LABEL[c.reason], priority, c.score, c.lastAt);
    }));
  }
  // Anything that cleared itself since the last run (the visitor got a reply) should leave the list.
  const keep = new Set(candidates.map((c) => c.sessionId));
  const existing = await env.DB.prepare(`SELECT session_id FROM followups WHERE workspace_id = ? AND day = ? AND status = 'open'`)
    .bind(session.workspaceId, day).all<{ session_id: string }>();
  const stale = (existing.results || []).map((r) => r.session_id).filter((id) => !keep.has(id));
  if (stale.length) {
    await env.DB.prepare(`DELETE FROM followups WHERE workspace_id = ? AND day = ? AND status = 'open'
      AND session_id IN (${stale.map(() => "?").join(",")})`)
      .bind(session.workspaceId, day, ...stale).run();
  }

  return listFor(request, env, session.workspaceId, day);
}

async function listFor(request: Request, env: FollowupsEnv, workspaceId: string, day: string): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT session_id, reason_code, customer_name, action, why, priority, score, last_at, status
    FROM followups WHERE workspace_id = ? AND day = ?
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_at ASC`)
    .bind(workspaceId, day).all<{ session_id: string; reason_code: string; customer_name: string; action: string; why: string; priority: string; score: number | null; last_at: string; status: string }>();
  return json(request, {
    day,
    followups: (rows.results || []).map((r) => ({
      sessionId: r.session_id, reason: r.reason_code,
      reasonLabel: REASON_LABEL[r.reason_code as ReasonCode] || r.reason_code,
      customerName: r.customer_name, action: r.action, why: r.why,
      priority: r.priority, score: r.score, lastAt: r.last_at, done: r.status === "done",
    })),
  });
}

async function list(request: Request, env: FollowupsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFollowupsSchema(env.DB);
  const day = (new URL(request.url).searchParams.get("date") || "").trim() || today();
  return listFor(request, env, session.workspaceId, day);
}

async function setStatus(request: Request, env: FollowupsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sessionId?: string; day?: string; done?: boolean };
  const sessionId = (body.sessionId || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureFollowupsSchema(env.DB);
  const day = (body.day || "").trim() || today();
  await env.DB.prepare(`UPDATE followups SET status = ? WHERE workspace_id = ? AND day = ? AND session_id = ?`)
    .bind(body.done ? "done" : "open", session.workspaceId, day, sessionId).run();
  return listFor(request, env, session.workspaceId, day);
}

export async function handleFollowupsRequest(request: Request, env: FollowupsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/followups")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/followups" && request.method === "GET") return list(request, env);
  if (url.pathname === "/api/followups/refresh" && request.method === "POST") return refresh(request, env);
  if (url.pathname === "/api/followups/status" && request.method === "PATCH") return setStatus(request, env);
  return null;
}
