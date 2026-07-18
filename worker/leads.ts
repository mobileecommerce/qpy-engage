import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface LeadsEnv extends AuthEnv {
  DB: D1Database;
}

const MAX_DATA_LENGTH = 4000;
const LIST_LIMIT = 200;

async function ensureLeadsSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS action_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_action_submissions_workspace ON action_submissions (workspace_id, created_at DESC)`).run();
}

export async function saveSubmission(db: D1Database, workspaceId: string, actionName: string, channel: string, data: Record<string, unknown>): Promise<void> {
  await ensureLeadsSchema(db);
  await db.prepare(`INSERT INTO action_submissions (workspace_id, action_name, channel, data) VALUES (?, ?, ?, ?)`)
    .bind(workspaceId, actionName.slice(0, 80), channel.slice(0, 40), JSON.stringify(data).slice(0, MAX_DATA_LENGTH)).run();
}

async function listSubmissions(request: Request, env: LeadsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureLeadsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT id, action_name, channel, data, created_at FROM action_submissions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(session.workspaceId, LIST_LIMIT).all<{ id: number; action_name: string; channel: string; data: string; created_at: string }>();
  const submissions = (result.results || []).map((row) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data); } catch { /* leave empty */ }
    return { id: row.id, actionName: row.action_name, channel: row.channel, data, createdAt: row.created_at };
  });
  return json(request, { submissions });
}

async function deleteSubmission(request: Request, env: LeadsEnv, id: number): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureLeadsSchema(env.DB);
  await env.DB.prepare(`DELETE FROM action_submissions WHERE workspace_id = ? AND id = ?`).bind(session.workspaceId, id).run();
  return json(request, { ok: true });
}

export async function handleLeadsRequest(request: Request, env: LeadsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/leads")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/leads" && request.method === "GET") return listSubmissions(request, env);
  const deleteMatch = url.pathname.match(/^\/api\/leads\/(\d+)$/);
  if (deleteMatch && request.method === "DELETE") return deleteSubmission(request, env, Number(deleteMatch[1]));
  return json(request, { error: "Not found" }, 404);
}
