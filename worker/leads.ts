import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface LeadsEnv extends AuthEnv {
  DB: D1Database;
}

const MAX_DATA_LENGTH = 4000;
const LIST_LIMIT = 200;

const SOURCES = ["Website", "Referral", "Event"] as const;
const STATUSES = ["New", "Contacted", "Qualified", "Nurture", "Closed-Lost"] as const;
const PRIORITIES = ["Hot", "Warm", "Cold"] as const;
const SEGMENTS = ["Enterprise", "SMB"] as const;

async function ensureLeadsSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS action_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    action_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_action_submissions_workspace ON action_submissions (workspace_id, created_at DESC)`).run();
  // Idempotent migration for tables created before session_id/updated_at existed.
  // SQLite disallows a non-constant default (e.g. CURRENT_TIMESTAMP) on ALTER TABLE ADD COLUMN,
  // so add with a constant default and backfill separately.
  try { await db.prepare(`ALTER TABLE action_submissions ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  try {
    await db.prepare(`ALTER TABLE action_submissions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`).run();
    await db.prepare(`UPDATE action_submissions SET updated_at = created_at WHERE updated_at = ''`).run();
  } catch { /* already exists */ }
  // Every new lead defaults to status "New" — that's also what drives the "New" badge in the UI,
  // so a fresh capture is automatically flagged until someone updates its status.
  try { await db.prepare(`ALTER TABLE action_submissions ADD COLUMN source TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE action_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'New'`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE action_submissions ADD COLUMN priority TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE action_submissions ADD COLUMN segment TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
}

export async function saveSubmission(db: D1Database, workspaceId: string, sessionId: string, actionName: string, channel: string, data: Record<string, unknown>): Promise<void> {
  await ensureLeadsSchema(db);
  const trimmedSession = (sessionId || "").slice(0, 80);
  const trimmedAction = actionName.slice(0, 80);

  // Within the same conversation, later captures merge into the same lead instead of
  // creating a duplicate row — a customer sharing their name after already sharing a phone
  // number should update one record, not create a second, partial one.
  if (trimmedSession) {
    const existing = await db.prepare(`SELECT id, data FROM action_submissions WHERE workspace_id = ? AND session_id = ? AND action_name = ?`)
      .bind(workspaceId, trimmedSession, trimmedAction).first<{ id: number; data: string }>();
    if (existing) {
      let merged = data;
      try { merged = { ...JSON.parse(existing.data), ...data }; } catch { /* keep just the new data */ }
      await db.prepare(`UPDATE action_submissions SET data = ?, channel = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(JSON.stringify(merged).slice(0, MAX_DATA_LENGTH), channel.slice(0, 40), existing.id).run();
      return;
    }
  }

  await db.prepare(`INSERT INTO action_submissions (workspace_id, session_id, action_name, channel, data) VALUES (?, ?, ?, ?, ?)`)
    .bind(workspaceId, trimmedSession, trimmedAction, channel.slice(0, 40), JSON.stringify(data).slice(0, MAX_DATA_LENGTH)).run();
}

async function listSubmissions(request: Request, env: LeadsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureLeadsSchema(env.DB);
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const result = sessionId
    ? await env.DB.prepare(`SELECT id, action_name, channel, data, created_at, updated_at, source, status, priority, segment FROM action_submissions WHERE workspace_id = ? AND session_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(session.workspaceId, sessionId, LIST_LIMIT).all<{ id: number; action_name: string; channel: string; data: string; created_at: string; updated_at: string; source: string; status: string; priority: string; segment: string }>()
    : await env.DB.prepare(`SELECT id, action_name, channel, data, created_at, updated_at, source, status, priority, segment FROM action_submissions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(session.workspaceId, LIST_LIMIT).all<{ id: number; action_name: string; channel: string; data: string; created_at: string; updated_at: string; source: string; status: string; priority: string; segment: string }>();
  const submissions = (result.results || []).map((row) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data); } catch { /* leave empty */ }
    return { id: row.id, actionName: row.action_name, channel: row.channel, data, createdAt: row.created_at, updatedAt: row.updated_at, source: row.source || "", status: row.status || "New", priority: row.priority || "", segment: row.segment || "" };
  });
  return json(request, { submissions });
}

async function updateTags(request: Request, env: LeadsEnv, id: number): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { source?: string; status?: string; priority?: string; segment?: string };
  await ensureLeadsSchema(env.DB);
  const updates: string[] = [];
  const values: string[] = [];
  if (body.source !== undefined) {
    if (body.source !== "" && !(SOURCES as readonly string[]).includes(body.source)) return json(request, { error: "Invalid source." }, 400);
    updates.push("source = ?"); values.push(body.source);
  }
  if (body.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(body.status)) return json(request, { error: "Invalid status." }, 400);
    updates.push("status = ?"); values.push(body.status);
  }
  if (body.priority !== undefined) {
    if (body.priority !== "" && !(PRIORITIES as readonly string[]).includes(body.priority)) return json(request, { error: "Invalid priority." }, 400);
    updates.push("priority = ?"); values.push(body.priority);
  }
  if (body.segment !== undefined) {
    if (body.segment !== "" && !(SEGMENTS as readonly string[]).includes(body.segment)) return json(request, { error: "Invalid segment." }, 400);
    updates.push("segment = ?"); values.push(body.segment);
  }
  if (!updates.length) return json(request, { error: "Nothing to update." }, 400);
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(`UPDATE action_submissions SET ${updates.join(", ")} WHERE workspace_id = ? AND id = ?`)
    .bind(...values, session.workspaceId, id).run();
  return json(request, { ok: true });
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
  if (deleteMatch && request.method === "PATCH") return updateTags(request, env, Number(deleteMatch[1]));
  return json(request, { error: "Not found" }, 404);
}
