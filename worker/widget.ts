import { callClaudeWithActions, sanitizeChatMessages, sanitizeActions, json, corsPreflight, allowedOrigin } from "./shared";
import { getStoredKnowledgeContent } from "./knowledge";
import { saveSubmission } from "./leads";
import { requireSession, type AuthEnv } from "./auth";

export interface WidgetEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

const RATE_LIMIT_PER_MINUTE = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_KNOWLEDGE_LENGTH = 12000;

function sqliteNow(): string {
  // Matches SQLite's own CURRENT_TIMESTAMP format so an explicit value here sorts identically
  // to values inserted via the column default elsewhere.
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function widgetJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "vary": "origin", "cache-control": "no-store" } });
}

function widgetCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  } });
}

async function ensureWidgetSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS widget_rate_limits (
    workspace_id TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, window_start)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS widget_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_widget_messages_workspace ON widget_messages (workspace_id, created_at)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS widget_conversation_state (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ai_active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, session_id)
  )`).run();
}

async function isAiActive(db: D1Database, workspaceId: string, sessionId: string): Promise<boolean> {
  if (!sessionId) return true;
  const row = await db.prepare(`SELECT ai_active FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).first<{ ai_active: number }>();
  return row ? row.ai_active === 1 : true;
}

async function withinRateLimit(db: D1Database, workspaceId: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60000);
  await db.prepare(`INSERT INTO widget_rate_limits (workspace_id, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(workspace_id, window_start) DO UPDATE SET count = count + 1`).bind(workspaceId, windowStart).run();
  const row = await db.prepare("SELECT count FROM widget_rate_limits WHERE workspace_id = ? AND window_start = ?").bind(workspaceId, windowStart).first<{ count: number }>();
  return (row?.count || 0) <= RATE_LIMIT_PER_MINUTE;
}

async function readWorkspaceState<T>(db: D1Database, workspaceId: string, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM workspace_state WHERE key = ?").bind(`${workspaceId}::${key}`).first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

async function buildSystemPrompt(db: D1Database, workspaceId: string): Promise<string> {
  const config = await readWorkspaceState<{ role?: string; tone?: string; language?: string; fallback?: string }>(db, workspaceId, "qpy-engage-assistant-config-v2");
  const policies = await readWorkspaceState<{ restricted?: string }>(db, workspaceId, "qpy-engage-assistant-policies");
  const selectedSources = (await readWorkspaceState<number[]>(db, workspaceId, "qpy-engage-assistant-sources")) || [];
  const sources = (await readWorkspaceState<Array<{ id: number; name: string }>>(db, workspaceId, "qpy-engage-sources")) || [];
  const sourceNames = sources.filter((s) => selectedSources.includes(s.id)).map((s) => s.name).join(", ") || "no connected sources yet";
  const knowledgeContent = await getStoredKnowledgeContent(db, workspaceId, selectedSources);
  const knowledgeText = Object.values(knowledgeContent).join("\n\n").slice(0, MAX_KNOWLEDGE_LENGTH);

  const role = config?.role || "You are a helpful customer support assistant for this business.";
  const tone = config?.tone || "Warm & helpful";
  const language = config?.language || "English";
  const fallback = config?.fallback || "If you are unsure or the request is sensitive, say so and offer to connect the customer with a human.";

  let prompt = `${role}\n\nTone: ${tone}. Preferred language: ${language}.\n\nFallback and human handoff policy: ${fallback}`;
  if (policies?.restricted) prompt += `\n\nRestricted topics you must never answer — offer human handoff instead: ${policies.restricted}`;
  prompt += `\n\nConnected knowledge sources: ${sourceNames}.`;
  prompt += knowledgeText
    ? `\n\nReference material from those sources — use this to answer factual questions, and do not state facts beyond what's here:\n${knowledgeText}`
    : " You were not given their actual content, so never claim a specific fact, price, or policy came from them.";
  prompt += "\n\nKeep replies concise and helpful. Never invent prices, availability, order details, or policies you were not given. You are chatting with a website visitor, not through WhatsApp.";
  return prompt;
}

async function respond(request: Request, env: WidgetEnv): Promise<Response> {
  if (!env.DB) return widgetJson({ error: "Workspace database is unavailable." }, 503);
  if (!env.ANTHROPIC_API_KEY) return widgetJson({ error: "This chat isn't configured yet." }, 503);

  const body = await request.json() as { workspaceId?: string; message?: string; history?: unknown; sessionId?: string };
  const workspaceId = (body.workspaceId || "").trim();
  const sessionId = (body.sessionId || "").trim().slice(0, 80);
  if (!workspaceId) return widgetJson({ error: "Missing workspace id." }, 400);

  const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(workspaceId).first();
  if (!workspace) return widgetJson({ error: "Unknown workspace." }, 404);

  await ensureWidgetSchema(env.DB);
  if (!(await withinRateLimit(env.DB, workspaceId))) return widgetJson({ error: "This chat is receiving too many messages right now. Please try again shortly." }, 429);

  const message = (body.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!message) return widgetJson({ error: "No message to respond to." }, 400);

  const receivedAt = sqliteNow();
  if (sessionId) {
    await env.DB.prepare(`INSERT INTO widget_messages (workspace_id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`).bind(workspaceId, sessionId, message, receivedAt).run();
  }

  // A human agent can take over a conversation from the dashboard — once they do, the AI
  // stops auto-replying so the visitor only hears from the person handling their chat.
  if (!(await isAiActive(env.DB, workspaceId, sessionId))) {
    return widgetJson({ reply: null, humanHandling: true, serverTime: receivedAt });
  }

  const history = sanitizeChatMessages(body.history).slice(-6);
  const messages = [...history, { role: "user" as const, content: message }];

  const systemPrompt = await buildSystemPrompt(env.DB, workspaceId);
  const storedActions = await readWorkspaceState<unknown[]>(env.DB, workspaceId, "qpy-engage-assistant-actions");
  const actions = sanitizeActions(storedActions || []);
  const recordSubmission = (actionName: string, data: Record<string, unknown>) => saveSubmission(env.DB, workspaceId, sessionId, actionName, "widget", data);
  const result = await callClaudeWithActions(env.ANTHROPIC_API_KEY, systemPrompt, messages, actions, recordSubmission);
  if (result.error) return widgetJson({ error: result.error }, result.status || 502);

  const repliedAt = sqliteNow();
  if (sessionId && result.reply) {
    await env.DB.prepare(`INSERT INTO widget_messages (workspace_id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`).bind(workspaceId, sessionId, result.reply, repliedAt).run();
  }

  return widgetJson({ reply: result.reply, serverTime: repliedAt });
}

async function pollMessages(request: Request, env: WidgetEnv): Promise<Response> {
  if (!env.DB) return widgetJson({ error: "Workspace database is unavailable." }, 503);
  const url = new URL(request.url);
  const workspaceId = (url.searchParams.get("workspaceId") || "").trim();
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  const after = (url.searchParams.get("after") || "").trim();
  if (!workspaceId || !sessionId) return widgetJson({ error: "Missing workspaceId or sessionId." }, 400);
  await ensureWidgetSchema(env.DB);
  const result = after
    ? await env.DB.prepare(`SELECT role, content, created_at FROM widget_messages WHERE workspace_id = ? AND session_id = ? AND role != 'user' AND created_at > ? ORDER BY created_at ASC LIMIT 50`)
      .bind(workspaceId, sessionId, after).all<{ role: string; content: string; created_at: string }>()
    : await env.DB.prepare(`SELECT role, content, created_at FROM widget_messages WHERE workspace_id = ? AND session_id = ? AND role != 'user' ORDER BY created_at ASC LIMIT 50`)
      .bind(workspaceId, sessionId).all<{ role: string; content: string; created_at: string }>();
  return widgetJson({ messages: (result.results || []).map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at })) });
}

async function getConfig(request: Request, env: WidgetEnv): Promise<Response> {
  if (!env.DB) return widgetJson({ error: "Workspace database is unavailable." }, 503);
  const url = new URL(request.url);
  const workspaceId = (url.searchParams.get("workspaceId") || "").trim();
  if (!workspaceId) return widgetJson({ error: "Missing workspace id." }, 400);
  const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(workspaceId).first();
  if (!workspace) return widgetJson({ error: "Unknown workspace." }, 404);
  const appearance = await readWorkspaceState(env.DB, workspaceId, "qpy-engage-widget-appearance");
  return widgetJson({ appearance: appearance || null });
}

async function listConversations(request: Request, env: WidgetEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureWidgetSchema(env.DB);
  const result = await env.DB.prepare(`SELECT session_id, role, content, created_at FROM widget_messages WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 3000`)
    .bind(session.workspaceId).all<{ session_id: string; role: string; content: string; created_at: string }>();

  const bySession = new Map<string, { sessionId: string; messageCount: number; lastMessage: string; lastRole: string; firstAt: string; lastAt: string }>();
  for (const row of result.results || []) {
    const existing = bySession.get(row.session_id);
    if (existing) {
      existing.messageCount++;
      existing.lastMessage = row.content;
      existing.lastRole = row.role;
      existing.lastAt = row.created_at;
    } else {
      bySession.set(row.session_id, { sessionId: row.session_id, messageCount: 1, lastMessage: row.content, lastRole: row.role, firstAt: row.created_at, lastAt: row.created_at });
    }
  }
  const stateResult = await env.DB.prepare(`SELECT session_id, ai_active FROM widget_conversation_state WHERE workspace_id = ?`)
    .bind(session.workspaceId).all<{ session_id: string; ai_active: number }>();
  const aiActiveBySession = new Map((stateResult.results || []).map((r) => [r.session_id, r.ai_active === 1]));

  const conversations = [...bySession.values()]
    .map((c) => ({ ...c, aiActive: aiActiveBySession.get(c.sessionId) ?? true }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return json(request, { conversations });
}

async function getMessages(request: Request, env: WidgetEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureWidgetSchema(env.DB);
  const result = await env.DB.prepare(`SELECT role, content, created_at FROM widget_messages WHERE workspace_id = ? AND session_id = ? ORDER BY created_at ASC LIMIT 500`)
    .bind(session.workspaceId, sessionId).all<{ role: string; content: string; created_at: string }>();
  const aiActive = await isAiActive(env.DB, session.workspaceId, sessionId);
  return json(request, { messages: (result.results || []).map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at })), aiActive });
}

async function setTakeover(request: Request, env: WidgetEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sessionId?: string; active?: boolean };
  const sessionId = (body.sessionId || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureWidgetSchema(env.DB);
  await env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, ai_active) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET ai_active = excluded.ai_active`)
    .bind(session.workspaceId, sessionId, body.active ? 1 : 0).run();
  return json(request, { ok: true, aiActive: Boolean(body.active) });
}

async function sendAgentReply(request: Request, env: WidgetEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sessionId?: string; message?: string };
  const sessionId = (body.sessionId || "").trim();
  const message = (body.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  if (!message) return json(request, { error: "Write a reply before sending." }, 400);
  await ensureWidgetSchema(env.DB);
  await env.DB.prepare(`INSERT INTO widget_messages (workspace_id, session_id, role, content) VALUES (?, ?, 'agent', ?)`)
    .bind(session.workspaceId, sessionId, message).run();
  return json(request, { ok: true });
}

export async function handleWidgetRequest(request: Request, env: WidgetEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/widget/")) return null;

  // Public, unauthenticated widget endpoints — wildcard CORS, since any customer site embeds these.
  if (url.pathname === "/api/widget/respond" || url.pathname === "/api/widget/config" || url.pathname === "/api/widget/poll") {
    if (request.method === "OPTIONS") return widgetCorsPreflight();
    if (url.pathname === "/api/widget/respond" && request.method === "POST") return respond(request, env);
    if (url.pathname === "/api/widget/config" && request.method === "GET") return getConfig(request, env);
    if (url.pathname === "/api/widget/poll" && request.method === "GET") return pollMessages(request, env);
    return widgetJson({ error: "Not found" }, 404);
  }

  // Authenticated dashboard endpoints for reviewing and taking over widget conversations.
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);
  if (url.pathname === "/api/widget/conversations" && request.method === "GET") return listConversations(request, env);
  if (url.pathname === "/api/widget/messages" && request.method === "GET") return getMessages(request, env);
  if (url.pathname === "/api/widget/takeover" && request.method === "POST") return setTakeover(request, env);
  if (url.pathname === "/api/widget/reply" && request.method === "POST") return sendAgentReply(request, env);
  return json(request, { error: "Not found" }, 404);
}
