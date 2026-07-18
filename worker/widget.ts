import { callClaudeWithActions, sanitizeChatMessages, sanitizeActions } from "./shared";
import { getStoredKnowledgeContent } from "./knowledge";

export interface WidgetEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

const RATE_LIMIT_PER_MINUTE = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_KNOWLEDGE_LENGTH = 12000;

function widgetJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "vary": "origin", "cache-control": "no-store" } });
}

function widgetCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
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

  const body = await request.json() as { workspaceId?: string; message?: string; history?: unknown };
  const workspaceId = (body.workspaceId || "").trim();
  if (!workspaceId) return widgetJson({ error: "Missing workspace id." }, 400);

  const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(workspaceId).first();
  if (!workspace) return widgetJson({ error: "Unknown workspace." }, 404);

  await ensureWidgetSchema(env.DB);
  if (!(await withinRateLimit(env.DB, workspaceId))) return widgetJson({ error: "This chat is receiving too many messages right now. Please try again shortly." }, 429);

  const message = (body.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!message) return widgetJson({ error: "No message to respond to." }, 400);
  const history = sanitizeChatMessages(body.history).slice(-6);
  const messages = [...history, { role: "user" as const, content: message }];

  const systemPrompt = await buildSystemPrompt(env.DB, workspaceId);
  const storedActions = await readWorkspaceState<unknown[]>(env.DB, workspaceId, "qpy-engage-assistant-actions");
  const actions = sanitizeActions(storedActions || []);
  const result = await callClaudeWithActions(env.ANTHROPIC_API_KEY, systemPrompt, messages, actions);
  if (result.error) return widgetJson({ error: result.error }, result.status || 502);
  return widgetJson({ reply: result.reply });
}

export async function handleWidgetRequest(request: Request, env: WidgetEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/widget/")) return null;
  if (request.method === "OPTIONS") return widgetCorsPreflight();
  if (url.pathname === "/api/widget/respond" && request.method === "POST") return respond(request, env);
  return widgetJson({ error: "Not found" }, 404);
}
