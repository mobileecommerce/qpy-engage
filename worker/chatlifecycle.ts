import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface LifecycleEnv extends AuthEnv {
  DB: D1Database;
}

/* ================================================================================================
   Ending a web chat.

   A conversation an agent has finished with should leave the inbox, and a visitor who wandered off
   two hours ago should not still be sitting in it. Ending is therefore both automatic and manual,
   and once ended the visitor cannot add to that thread — but can always start a fresh one, because
   refusing to let a returning customer talk to you is never the behaviour anyone wants.

   Auto-end fires only when the business is waiting on the *customer*. A thread whose last message
   came from the visitor is one nobody answered, and quietly closing those would erase the evidence
   of exactly the failure the team most needs to see.
   ============================================================================================== */

export interface AutoEndSettings { enabled: boolean; minutes: number }

const DEFAULT_SETTINGS: AutoEndSettings = { enabled: false, minutes: 30 };
const MIN_MINUTES = 2;
const MAX_MINUTES = 1440;
const SWEEP_LIMIT = 200;

let schemaReady = false;

export async function ensureLifecycleSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  for (const statement of [
    `ALTER TABLE widget_conversation_state ADD COLUMN ended_at TEXT`,
    `ALTER TABLE widget_conversation_state ADD COLUMN ended_by TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widget_conversation_state ADD COLUMN ended_reason TEXT NOT NULL DEFAULT ''`,
  ]) {
    try { await db.prepare(statement).run(); } catch { /* already applied */ }
  }
  schemaReady = true;
}

export async function readAutoEndSettings(db: D1Database, workspaceId: string): Promise<AutoEndSettings> {
  const row = await db.prepare(`SELECT value FROM workspace_state WHERE key = ?`)
    .bind(`${workspaceId}::chat-auto-end`).first<{ value: string }>().catch(() => null);
  if (!row) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(row.value) as Partial<AutoEndSettings>;
    const minutes = Number(parsed.minutes);
    return {
      enabled: Boolean(parsed.enabled),
      // Clamped on read as well as on write: a value edited directly in the store should never be
      // able to close conversations seconds after they start.
      minutes: Number.isFinite(minutes) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes))) : DEFAULT_SETTINGS.minutes,
    };
  } catch { return DEFAULT_SETTINGS; }
}

export interface ChatEndedState { ended: boolean; endedAt: string; reason: string }

export async function readEndedState(db: D1Database, workspaceId: string, sessionId: string): Promise<ChatEndedState> {
  const row = await db.prepare(`SELECT ended_at, ended_reason FROM widget_conversation_state
    WHERE workspace_id = ? AND session_id = ?`)
    .bind(workspaceId, sessionId).first<{ ended_at: string | null; ended_reason: string }>().catch(() => null);
  return { ended: Boolean(row?.ended_at), endedAt: row?.ended_at || "", reason: row?.ended_reason || "" };
}

/**
 * Closes one conversation.
 *
 * The visible system line is written to the thread itself rather than only to a status column, so
 * the transcript explains its own ending — an agent reading it back six weeks later should not have
 * to infer why it stops.
 */
export async function endChat(
  db: D1Database, workspaceId: string, sessionId: string, by: string, note: string,
): Promise<void> {
  await ensureLifecycleSchema(db);
  await db.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, ended_at, ended_by, ended_reason)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET ended_at = CURRENT_TIMESTAMP,
      ended_by = excluded.ended_by, ended_reason = excluded.ended_reason`)
    .bind(workspaceId, sessionId, by.slice(0, 80), note.slice(0, 160)).run();
  await db.prepare(`INSERT INTO widget_messages (workspace_id, session_id, role, content) VALUES (?, ?, 'system', ?)`)
    .bind(workspaceId, sessionId, note.slice(0, 160)).run().catch(() => null);
  await db.prepare(`UPDATE crm_conversations SET state = 'closed', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND channel = 'webchat' AND thread_key = ?`)
    .bind(workspaceId, sessionId).run().catch(() => null);
}

async function reopenChat(db: D1Database, workspaceId: string, sessionId: string): Promise<void> {
  await ensureLifecycleSchema(db);
  await db.prepare(`UPDATE widget_conversation_state SET ended_at = NULL, ended_by = '', ended_reason = ''
    WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).run();
  await db.prepare(`UPDATE crm_conversations SET state = 'open', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND channel = 'webchat' AND thread_key = ?`)
    .bind(workspaceId, sessionId).run().catch(() => null);
}

/**
 * Closes conversations the customer has stopped replying to. Run from the scheduled handler.
 *
 * The window is measured from the last message only when that message was *ours*. A thread the
 * visitor spoke in last is one waiting on the business, and auto-closing it would tidy away the
 * team's own unanswered messages.
 */
export async function sweepStaleChats(db: D1Database): Promise<number> {
  await ensureLifecycleSchema(db);
  const workspaces = await db.prepare(`SELECT DISTINCT substr(key, 1, instr(key, '::') - 1) AS workspace_id
    FROM workspace_state WHERE key LIKE '%::chat-auto-end'`).all<{ workspace_id: string }>().catch(() => null);

  let ended = 0;
  for (const row of workspaces?.results || []) {
    const workspaceId = row.workspace_id;
    if (!workspaceId) continue;
    const settings = await readAutoEndSettings(db, workspaceId);
    if (!settings.enabled) continue;

    const stale = await db.prepare(`
      WITH latest AS (
        SELECT session_id, max(created_at) AS last_at FROM widget_messages
        WHERE workspace_id = ? AND role != 'error' GROUP BY session_id
      )
      SELECT m.session_id, m.role FROM widget_messages m
      JOIN latest ON latest.session_id = m.session_id AND latest.last_at = m.created_at
      LEFT JOIN widget_conversation_state s ON s.workspace_id = ? AND s.session_id = m.session_id
      WHERE m.workspace_id = ?
        AND s.ended_at IS NULL
        AND m.role IN ('assistant','agent')
        AND latest.last_at < datetime('now', ?)
      LIMIT ?`)
      .bind(workspaceId, workspaceId, workspaceId, `-${settings.minutes} minutes`, SWEEP_LIMIT)
      .all<{ session_id: string }>().catch(() => null);

    for (const chat of stale?.results || []) {
      await endChat(db, workspaceId, chat.session_id, "auto",
        `Chat ended automatically after ${settings.minutes} minutes without a reply.`);
      ended++;
    }
  }
  return ended;
}

/* ------------------------------------------------------------------ HTTP */

async function getSettings(request: Request, env: LifecycleEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  return json(request, { settings: await readAutoEndSettings(env.DB, session.workspaceId) });
}

async function saveSettings(request: Request, env: LifecycleEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { enabled?: boolean; minutes?: number };
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(Number(body.minutes) || DEFAULT_SETTINGS.minutes)));
  const settings: AutoEndSettings = { enabled: Boolean(body.enabled), minutes };
  await env.DB.prepare(`INSERT INTO workspace_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(`${session.workspaceId}::chat-auto-end`, JSON.stringify(settings)).run();
  return json(request, { ok: true, settings });
}

async function endManually(request: Request, env: LifecycleEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sessionId?: string; reopen?: boolean };
  const sessionId = (body.sessionId || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);

  if (body.reopen) {
    await reopenChat(env.DB, session.workspaceId, sessionId);
    return json(request, { ok: true, ended: false });
  }
  await endChat(env.DB, session.workspaceId, sessionId, `agent:${session.email}`, "This chat was ended by the team.");
  return json(request, { ok: true, ended: true });
}

export async function handleLifecycleRequest(request: Request, env: LifecycleEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/chat/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/chat/auto-end" && request.method === "GET") return getSettings(request, env);
  if (url.pathname === "/api/chat/auto-end" && request.method === "POST") return saveSettings(request, env);
  if (url.pathname === "/api/chat/end" && request.method === "POST") return endManually(request, env);
  return null;
}
