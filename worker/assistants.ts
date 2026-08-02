import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface AssistantsEnv extends AuthEnv {
  DB: D1Database;
}

/* ================================================================================================
   Multiple assistants per workspace.

   Until now a workspace had exactly one assistant, stored as a handful of workspace_state keys, and
   every channel used it. This makes assistants first-class so a business can run support on
   WhatsApp and sales on its website without the two sharing a personality.

   Routing is by *binding* rather than by channel. Channel is the obvious axis and the one that was
   asked for, but it cannot express two WhatsApp numbers or two websites on one workspace — and a
   business with a restaurant line and a hotel line is not an exotic case. A binding is
   (channel, key), where an empty key means "everything on this channel", so the simple case stays
   simple and the harder one is possible without another migration.

   Exactly one assistant is always the default. That is what guarantees an inbound message can never
   arrive with nowhere to go, which is the failure this design most needs to rule out.
   ============================================================================================== */

export type BindChannel = "whatsapp" | "instagram" | "webchat";

export interface AssistantConfig {
  name?: string; purpose?: string; role?: string; tone?: string; language?: string;
  fallback?: string; signoff?: string; welcome?: string;
}

export interface AssistantRecord {
  id: string; name: string; isDefault: boolean; config: AssistantConfig;
  policies: Record<string, unknown>; sources: unknown[]; actions: unknown[];
  bindings: Array<{ channel: BindChannel; key: string }>;
  createdAt: string; updatedAt: string;
}

// The workspace_state keys the single-assistant build used. Migration reads these once and never
// writes them again; they are left in place so a rollback still finds a working assistant.
const LEGACY_KEYS = {
  config: "qpy-engage-assistant-config-v2",
  policies: "qpy-engage-assistant-policies",
  sources: "qpy-engage-assistant-sources",
  actions: "qpy-engage-assistant-actions",
};

let schemaReady = false;

export async function ensureAssistantSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS assistants (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Assistant',
      is_default INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      policies TEXT NOT NULL DEFAULT '{}',
      sources TEXT NOT NULL DEFAULT '[]',
      actions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistants_ws ON assistants (workspace_id)`),
    // Partial index: only one row per workspace may carry is_default = 1, enforced by the database
    // rather than by remembering to clear the old one at every call site.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_default
      ON assistants (workspace_id) WHERE is_default = 1`),

    db.prepare(`CREATE TABLE IF NOT EXISTS assistant_bindings (
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      bind_key TEXT NOT NULL DEFAULT '',
      assistant_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, channel, bind_key)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_bindings_assistant ON assistant_bindings (workspace_id, assistant_id)`),
  ]);
  schemaReady = true;
}

function newId(): string {
  return `asst_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

async function readState<T>(db: D1Database, workspaceId: string, key: string, fallback: T): Promise<T> {
  const row = await db.prepare(`SELECT value FROM workspace_state WHERE key = ?`)
    .bind(`${workspaceId}::${key}`).first<{ value: string }>().catch(() => null);
  return parseJson<T>(row?.value, fallback);
}

/**
 * Guarantees the workspace has at least one assistant.
 *
 * The existing single-assistant configuration is adopted as that first record rather than replaced
 * by a blank one, so the assistant a business already tuned keeps answering exactly as it did the
 * moment this ships. It binds to nothing, because being the default is what makes it answer
 * everywhere — an explicit binding per channel would silently stop working the day a new channel is
 * connected.
 */
export async function ensureDefaultAssistant(db: D1Database, workspaceId: string): Promise<string> {
  await ensureAssistantSchema(db);
  const existing = await db.prepare(`SELECT id FROM assistants WHERE workspace_id = ? AND is_default = 1`)
    .bind(workspaceId).first<{ id: string }>();
  if (existing) return existing.id;

  const anyRow = await db.prepare(`SELECT id FROM assistants WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(workspaceId).first<{ id: string }>();
  if (anyRow) {
    await db.prepare(`UPDATE assistants SET is_default = 1 WHERE id = ?`).bind(anyRow.id).run();
    return anyRow.id;
  }

  const [config, policies, sources, actions] = await Promise.all([
    readState<AssistantConfig>(db, workspaceId, LEGACY_KEYS.config, {}),
    readState<Record<string, unknown>>(db, workspaceId, LEGACY_KEYS.policies, {}),
    readState<unknown[]>(db, workspaceId, LEGACY_KEYS.sources, []),
    readState<unknown[]>(db, workspaceId, LEGACY_KEYS.actions, []),
  ]);
  const id = newId();
  await db.prepare(`INSERT INTO assistants (id, workspace_id, name, is_default, config, policies, sources, actions)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
    .bind(id, workspaceId, (config.name || "Assistant").slice(0, 60),
      JSON.stringify(config), JSON.stringify(policies), JSON.stringify(sources), JSON.stringify(actions))
    .run();
  return id;
}

/**
 * Which assistant answers this message.
 *
 * Most specific binding first: an exact key beats a channel-wide binding, which beats the default.
 * The default is the last resort and always exists, so this never returns nothing for a workspace
 * that has ever been used.
 */
export async function resolveAssistantId(
  db: D1Database, workspaceId: string, channel: BindChannel, bindKey = "",
): Promise<string> {
  await ensureAssistantSchema(db);
  if (bindKey) {
    const exact = await db.prepare(`SELECT b.assistant_id FROM assistant_bindings b
      JOIN assistants a ON a.id = b.assistant_id
      WHERE b.workspace_id = ? AND b.channel = ? AND b.bind_key = ?`)
      .bind(workspaceId, channel, bindKey).first<{ assistant_id: string }>().catch(() => null);
    if (exact) return exact.assistant_id;
  }
  const channelWide = await db.prepare(`SELECT b.assistant_id FROM assistant_bindings b
    JOIN assistants a ON a.id = b.assistant_id
    WHERE b.workspace_id = ? AND b.channel = ? AND b.bind_key = ''`)
    .bind(workspaceId, channel).first<{ assistant_id: string }>().catch(() => null);
  if (channelWide) return channelWide.assistant_id;
  return ensureDefaultAssistant(db, workspaceId);
}

export interface ResolvedAssistant {
  id: string; name: string;
  config: AssistantConfig; policies: Record<string, unknown>; sources: unknown[]; actions: unknown[];
}

/**
 * The assistant's full settings, ready for prompt assembly.
 *
 * Falls back to the legacy workspace keys when a record somehow has none — a workspace mid-migration
 * must never lose its instructions and start answering from a blank prompt.
 */
export async function loadAssistant(
  db: D1Database, workspaceId: string, channel: BindChannel, bindKey = "",
): Promise<ResolvedAssistant> {
  const id = await resolveAssistantId(db, workspaceId, channel, bindKey);
  const row = await db.prepare(`SELECT id, name, config, policies, sources, actions FROM assistants WHERE id = ?`)
    .bind(id).first<{ id: string; name: string; config: string; policies: string; sources: string; actions: string }>();

  if (!row) {
    return {
      id, name: "Assistant",
      config: await readState<AssistantConfig>(db, workspaceId, LEGACY_KEYS.config, {}),
      policies: await readState<Record<string, unknown>>(db, workspaceId, LEGACY_KEYS.policies, {}),
      sources: await readState<unknown[]>(db, workspaceId, LEGACY_KEYS.sources, []),
      actions: await readState<unknown[]>(db, workspaceId, LEGACY_KEYS.actions, []),
    };
  }
  const config = parseJson<AssistantConfig>(row.config, {});
  return {
    id: row.id, name: row.name,
    // An assistant saved before a field existed should inherit the workspace answer rather than an
    // empty string, which would read as "deliberately blank" during prompt assembly.
    config: Object.keys(config).length ? config : await readState<AssistantConfig>(db, workspaceId, LEGACY_KEYS.config, {}),
    policies: parseJson<Record<string, unknown>>(row.policies, {}),
    sources: parseJson<unknown[]>(row.sources, []),
    actions: parseJson<unknown[]>(row.actions, []),
  };
}

/* ------------------------------------------------------------------ HTTP */

async function listAssistants(request: Request, env: AssistantsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureDefaultAssistant(env.DB, session.workspaceId);

  const [rows, bindings] = await Promise.all([
    env.DB.prepare(`SELECT id, name, is_default, config, policies, sources, actions, created_at, updated_at
      FROM assistants WHERE workspace_id = ? ORDER BY is_default DESC, created_at ASC`)
      .bind(session.workspaceId).all<{ id: string; name: string; is_default: number; config: string; policies: string; sources: string; actions: string; created_at: string; updated_at: string }>(),
    env.DB.prepare(`SELECT channel, bind_key, assistant_id FROM assistant_bindings WHERE workspace_id = ?`)
      .bind(session.workspaceId).all<{ channel: string; bind_key: string; assistant_id: string }>(),
  ]);

  const bindingsBy = new Map<string, Array<{ channel: BindChannel; key: string }>>();
  for (const b of bindings.results || []) {
    const list = bindingsBy.get(b.assistant_id) || [];
    list.push({ channel: b.channel as BindChannel, key: b.bind_key });
    bindingsBy.set(b.assistant_id, list);
  }

  return json(request, {
    assistants: (rows.results || []).map((r): AssistantRecord => ({
      id: r.id, name: r.name, isDefault: r.is_default === 1,
      config: parseJson<AssistantConfig>(r.config, {}),
      policies: parseJson<Record<string, unknown>>(r.policies, {}),
      sources: parseJson<unknown[]>(r.sources, []),
      actions: parseJson<unknown[]>(r.actions, []),
      bindings: bindingsBy.get(r.id) || [],
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}

async function saveAssistant(request: Request, env: AssistantsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as Partial<AssistantRecord> & { id?: string; copyFrom?: string };
  await ensureDefaultAssistant(env.DB, session.workspaceId);

  const name = (body.name || "").trim().slice(0, 60) || "Assistant";
  const id = (body.id || "").trim();
  const payload = [
    JSON.stringify(body.config ?? {}), JSON.stringify(body.policies ?? {}),
    JSON.stringify(body.sources ?? []), JSON.stringify(body.actions ?? []),
  ];

  if (id) {
    const owned = await env.DB.prepare(`SELECT id FROM assistants WHERE id = ? AND workspace_id = ?`)
      .bind(id, session.workspaceId).first<{ id: string }>();
    if (!owned) return json(request, { error: "Assistant not found." }, 404);
    await env.DB.prepare(`UPDATE assistants SET name = ?, config = ?, policies = ?, sources = ?, actions = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`)
      .bind(name, ...payload, id, session.workspaceId).run();
    return json(request, { ok: true, id });
  }

  const created = newId();
  // A new assistant starts as a copy of the one already tuned, unless the caller supplied its own
  // settings. Nobody creating a second assistant wants to rewrite the instructions, knowledge
  // selection and actions from nothing — they want the same thing with a different voice.
  const seedFrom = (body.copyFrom || "").trim();
  const wantsCopy = body.config === undefined;
  let seeded = payload;
  if (wantsCopy) {
    const sourceId = seedFrom || await ensureDefaultAssistant(env.DB, session.workspaceId);
    const source = await env.DB.prepare(`SELECT config, policies, sources, actions FROM assistants
      WHERE id = ? AND workspace_id = ?`).bind(sourceId, session.workspaceId)
      .first<{ config: string; policies: string; sources: string; actions: string }>();
    if (source) {
      // The name is the one thing never copied — two assistants sharing a name is unusable in a
      // routing list, which is the whole point of having more than one.
      const copiedConfig = parseJson<AssistantConfig>(source.config, {});
      copiedConfig.name = name;
      seeded = [JSON.stringify(copiedConfig), source.policies, source.sources, source.actions];
    }
  }
  await env.DB.prepare(`INSERT INTO assistants (id, workspace_id, name, is_default, config, policies, sources, actions)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)`).bind(created, session.workspaceId, name, ...seeded).run();
  return json(request, { ok: true, id: created, copiedFrom: wantsCopy ? (seedFrom || "default") : "" });
}

async function setDefault(request: Request, env: AssistantsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing id." }, 400);
  await ensureAssistantSchema(env.DB);

  const owned = await env.DB.prepare(`SELECT id FROM assistants WHERE id = ? AND workspace_id = ?`)
    .bind(id, session.workspaceId).first<{ id: string }>();
  if (!owned) return json(request, { error: "Assistant not found." }, 404);
  // Cleared then set in one batch: the unique index would reject the new default while the old one
  // still holds the flag, so these cannot be separate statements.
  await env.DB.batch([
    env.DB.prepare(`UPDATE assistants SET is_default = 0 WHERE workspace_id = ?`).bind(session.workspaceId),
    env.DB.prepare(`UPDATE assistants SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id),
  ]);
  return json(request, { ok: true });
}

async function deleteAssistant(request: Request, env: AssistantsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing id." }, 400);
  await ensureAssistantSchema(env.DB);

  const row = await env.DB.prepare(`SELECT is_default FROM assistants WHERE id = ? AND workspace_id = ?`)
    .bind(id, session.workspaceId).first<{ is_default: number }>();
  if (!row) return json(request, { error: "Assistant not found." }, 404);
  // Refusing is friendlier than silently promoting another one: the operator should choose who
  // answers everything, not discover it afterwards.
  if (row.is_default === 1) {
    return json(request, { error: "This is the default assistant. Make another one the default before deleting it." }, 409);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM assistant_bindings WHERE workspace_id = ? AND assistant_id = ?`).bind(session.workspaceId, id),
    env.DB.prepare(`DELETE FROM assistants WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId),
  ]);
  return json(request, { ok: true });
}

async function saveBindings(request: Request, env: AssistantsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string; bindings?: Array<{ channel?: string; key?: string }> };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing id." }, 400);
  await ensureAssistantSchema(env.DB);

  const owned = await env.DB.prepare(`SELECT id FROM assistants WHERE id = ? AND workspace_id = ?`)
    .bind(id, session.workspaceId).first<{ id: string }>();
  if (!owned) return json(request, { error: "Assistant not found." }, 404);

  const valid = (body.bindings || [])
    .filter((b) => ["whatsapp", "instagram", "webchat"].includes(String(b.channel)))
    .slice(0, 24)
    .map((b) => ({ channel: String(b.channel), key: String(b.key || "").trim().slice(0, 80) }));

  const statements = [
    env.DB.prepare(`DELETE FROM assistant_bindings WHERE workspace_id = ? AND assistant_id = ?`).bind(session.workspaceId, id),
    // A binding moves rather than duplicates: claiming a channel another assistant holds takes it,
    // because two assistants answering the same inbound message is never what was meant.
    ...valid.map((b) => env.DB.prepare(`INSERT INTO assistant_bindings (workspace_id, channel, bind_key, assistant_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, channel, bind_key) DO UPDATE SET assistant_id = excluded.assistant_id`)
      .bind(session.workspaceId, b.channel, b.key, id)),
  ];
  await env.DB.batch(statements);
  return json(request, { ok: true, bindings: valid });
}

export async function handleAssistantsRequest(request: Request, env: AssistantsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/assistants")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/assistants" && request.method === "GET") return listAssistants(request, env);
  if (url.pathname === "/api/assistants" && request.method === "POST") return saveAssistant(request, env);
  if (url.pathname === "/api/assistants/default" && request.method === "POST") return setDefault(request, env);
  if (url.pathname === "/api/assistants/delete" && request.method === "POST") return deleteAssistant(request, env);
  if (url.pathname === "/api/assistants/bindings" && request.method === "POST") return saveBindings(request, env);
  return null;
}
