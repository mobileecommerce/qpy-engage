import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";
import { decryptToken, hmacHex, graphVersion, metaError, type ConnectionRow, type MetaEnv } from "./meta";

export interface WaFlowsEnv extends AuthEnv, MetaEnv {
  DB: D1Database;
}

/* ================================================================================================
   WhatsApp message templates and Flows.

   Two things Meta owns and we previously guessed at. Templates were sent blind by name, so a typo
   or an unapproved template burned a message credit to learn it was wrong. Flows — Meta's
   interactive in-chat forms — were not supported at all: a customer's submitted form arrived as an
   `interactive` webhook that the inbound handler ignored.

   Flows here are "no endpoint" flows: every screen is declared up front and the whole response
   comes back in one payload when the user submits. Endpoint flows, where Meta calls your server
   between screens, additionally require an RSA key exchange and a signed health-check endpoint —
   that is a separate piece of work, and half-implementing it would produce flows that hang.
   ============================================================================================== */

const TEMPLATE_CACHE_MINUTES = 30;
const MAX_SCREENS = 8;

let schemaReady = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    // A cache of what Meta says, not a source of truth. Refreshed on demand and used to fail a
    // send *before* it costs a credit, rather than after the API rejects it.
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_templates (
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      variable_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, name, language)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_flows (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      meta_flow_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      flow_json TEXT NOT NULL DEFAULT '',
      cta_label TEXT NOT NULL DEFAULT 'Open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_flows_ws ON wa_flows (workspace_id, status)`),
    // What a customer actually submitted. Kept verbatim alongside the parsed form so a change to
    // the parser never loses the original answer.
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_flow_responses (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      flow_id TEXT NOT NULL DEFAULT '',
      flow_token TEXT NOT NULL DEFAULT '',
      wa_id TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '',
      parsed_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_flow_responses ON wa_flow_responses (workspace_id, created_at DESC)`),
  ]);
  schemaReady = true;
}

async function connectionFor(db: D1Database, workspaceId: string): Promise<ConnectionRow | null> {
  return db.prepare(`SELECT * FROM whatsapp_connections WHERE workspace_id = ?`).bind(workspaceId).first<ConnectionRow>();
}

async function graphAuth(env: WaFlowsEnv, connection: ConnectionRow): Promise<{ token: string; proof: string } | null> {
  if (!env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) return null;
  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  return { token, proof: await hmacHex(env.META_APP_SECRET, token) };
}

/* ------------------------------------------------------------------ templates */

interface MetaTemplate {
  name?: string; language?: string; category?: string; status?: string;
  components?: Array<{ type?: string; text?: string }>;
}

/** Counts {{1}}, {{2}} … so a send can be rejected before Meta charges for a malformed one. */
function countVariables(body: string): number {
  const seen = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(match[1]);
  return seen.size;
}

async function syncTemplates(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const connection = await connectionFor(env.DB, session.workspaceId);
  if (!connection) return json(request, { error: "Connect WhatsApp Business in Channels first." }, 409);
  const auth = await graphAuth(env, connection);
  if (!auth) return json(request, { error: "Meta credentials are not configured on the server." }, 503);

  const url = `https://graph.facebook.com/${graphVersion(env)}/${connection.waba_id}/message_templates`
    + `?limit=200&fields=name,language,category,status,components&appsecret_proof=${auth.proof}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${auth.token}` } });
  if (!response.ok) return json(request, { error: await metaError(response) }, 502);
  const payload = await response.json() as { data?: MetaTemplate[] };
  const templates = payload.data || [];

  const writes = templates.filter((t) => t.name && t.language).map((t) => {
    const body = (t.components || []).find((c) => (c.type || "").toUpperCase() === "BODY")?.text || "";
    return env.DB.prepare(`INSERT INTO wa_templates (workspace_id, name, language, category, status, body_text, variable_count, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, name, language) DO UPDATE SET category = excluded.category,
        status = excluded.status, body_text = excluded.body_text,
        variable_count = excluded.variable_count, synced_at = CURRENT_TIMESTAMP`)
      .bind(session.workspaceId, t.name!, t.language!, (t.category || "").toUpperCase(), (t.status || "").toUpperCase(), body.slice(0, 1200), countVariables(body));
  });
  for (let i = 0; i < writes.length; i += 40) await env.DB.batch(writes.slice(i, i + 40));

  return json(request, { synced: templates.length, approved: templates.filter((t) => (t.status || "").toUpperCase() === "APPROVED").length });
}

async function listTemplates(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT name, language, category, status, body_text, variable_count, synced_at
    FROM wa_templates WHERE workspace_id = ? ORDER BY status = 'APPROVED' DESC, name ASC`)
    .bind(session.workspaceId).all<{ name: string; language: string; category: string; status: string; body_text: string; variable_count: number; synced_at: string }>();
  return json(request, {
    templates: (rows.results || []).map((r) => ({
      name: r.name, language: r.language, category: r.category, status: r.status,
      body: r.body_text, variableCount: r.variable_count, syncedAt: r.synced_at,
    })),
  });
}

export interface TemplateCheck { ok: boolean; reason?: string; category?: string; variableCount?: number; stale?: boolean }

/**
 * Pre-send validation.
 *
 * Deliberately permissive when nothing is known: a workspace that has never synced has no cached
 * templates, and refusing every send in that state would be a regression on behaviour that works
 * today. It refuses only on positive evidence of a problem — the template is cached and is not
 * approved, or the category does not match what the send is being billed as.
 */
export async function validateTemplate(
  db: D1Database, workspaceId: string, name: string, language: string, expectedCategory?: string,
): Promise<TemplateCheck> {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT category, status, variable_count, synced_at FROM wa_templates
    WHERE workspace_id = ? AND name = ? AND language = ?`)
    .bind(workspaceId, name, language).first<{ category: string; status: string; variable_count: number; synced_at: string }>();

  if (!row) {
    const anyCached = await db.prepare(`SELECT count(*) n FROM wa_templates WHERE workspace_id = ?`)
      .bind(workspaceId).first<{ n: number }>();
    if ((anyCached?.n ?? 0) === 0) return { ok: true, stale: true };
    // Templates are cached and this is not among them — a real signal, not an absence of data.
    return { ok: false, reason: `No template named "${name}" in ${language} exists on this WhatsApp account. Sync templates and check the name.` };
  }
  if (row.status !== "APPROVED") {
    return { ok: false, reason: `Template "${name}" is ${row.status || "not approved"} on Meta. Only approved templates can be sent.`, category: row.category };
  }
  if (expectedCategory && row.category && row.category !== expectedCategory.toUpperCase()) {
    // Category drives billing. Sending a MARKETING template billed as UTILITY is a compliance
    // problem, not a rounding error, so this is refused rather than silently corrected.
    return { ok: false, reason: `Template "${name}" is category ${row.category} on Meta but this campaign is set to ${expectedCategory.toUpperCase()}. They must match.`, category: row.category };
  }
  const stale = Date.parse(row.synced_at.replace(" ", "T") + "Z") < Date.now() - TEMPLATE_CACHE_MINUTES * 60_000;
  return { ok: true, category: row.category, variableCount: row.variable_count, stale };
}

/* ------------------------------------------------------------------ flows */

export interface FlowField { name: string; label: string; type: "text" | "email" | "phone" | "number" | "textarea" | "select" | "date"; required: boolean; options?: string[] }
export interface FlowScreen { id: string; title: string; fields: FlowField[] }

const COMPONENT_FOR: Record<FlowField["type"], string> = {
  text: "TextInput", email: "TextInput", phone: "TextInput", number: "TextInput",
  textarea: "TextArea", select: "Dropdown", date: "DatePicker",
};
const INPUT_TYPE_FOR: Record<string, string> = { text: "text", email: "email", phone: "phone", number: "number" };

function safeName(raw: string, fallback: string): string {
  const cleaned = (raw || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return cleaned || fallback;
}

/**
 * Screens to Meta's Flow JSON.
 *
 * The last screen must terminate and hand its data back, which is what produces the single
 * nfm_reply payload the webhook then parses. Every field name is sanitised because it becomes a
 * JSON key in that payload and, downstream, a lead field.
 */
export function buildFlowJson(screens: FlowScreen[], _flowName: string): Record<string, unknown> {
  const usable = screens.slice(0, MAX_SCREENS).filter((s) => s.fields.length);
  // Screen ids must be a single canonical form: the id and every navigate target that points at it
  // are generated from the same function, because a case mismatch between them is not a validation
  // error — Meta accepts the upload and the flow simply dead-ends at runtime.
  const screenId = (screen: FlowScreen, index: number) => safeName(screen.id, `screen_${index}`).toUpperCase();
  const fieldName = (field: FlowField, index: number) => safeName(field.name, `field_${index}`);

  const out = usable.map((screen, index) => {
    const isLast = index === usable.length - 1;
    const children: Record<string, unknown>[] = screen.fields.map((field, fieldIndex) => {
      const name = fieldName(field, fieldIndex);
      const base: Record<string, unknown> = { type: COMPONENT_FOR[field.type], name, label: field.label.slice(0, 80), required: field.required };
      if (COMPONENT_FOR[field.type] === "TextInput") base["input-type"] = INPUT_TYPE_FOR[field.type] || "text";
      if (field.type === "select") {
        base["data-source"] = (field.options || []).slice(0, 20).map((o, i) => ({ id: safeName(o, `opt_${i}`), title: o.slice(0, 60) }));
      }
      return base;
    });

    // Answers from earlier screens arrive as routing data and must be re-declared on every screen
    // that forwards them; a screen referencing ${data.x} without declaring x fails validation.
    const inherited: Record<string, unknown> = {};
    for (const prior of usable.slice(0, index)) {
      for (const [i, field] of prior.fields.entries()) {
        inherited[fieldName(field, i)] = { type: "string", __example__: "" };
      }
    }

    const payload: Record<string, string> = {};
    for (const key of Object.keys(inherited)) payload[key] = `\${data.${key}}`;
    for (const [i, field] of screen.fields.entries()) {
      const name = fieldName(field, i);
      payload[name] = `\${form.${name}}`;
    }

    children.push({
      type: "Footer",
      label: isLast ? "Submit" : "Continue",
      "on-click-action": isLast
        ? { name: "complete", payload }
        : { name: "navigate", next: { type: "screen", name: screenId(usable[index + 1], index + 1) }, payload },
    });

    const built: Record<string, unknown> = {
      id: screenId(screen, index),
      title: screen.title.slice(0, 60),
      layout: { type: "SingleColumnLayout", children: [{ type: "Form", name: "form", children }] },
    };
    if (isLast) built.terminal = true;
    if (Object.keys(inherited).length) built.data = inherited;
    return built;
  });

  // Only the keys Meta's schema defines. An unrecognised top-level property is a validation
  // failure, and the flow's display name is set through the API rather than in this document.
  return { version: "5.1", screens: out };
}

async function saveFlow(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string; name?: string; ctaLabel?: string; screens?: FlowScreen[] };
  const name = (body.name || "").trim().slice(0, 60);
  const screens = (body.screens || []).filter((s) => s && Array.isArray(s.fields));
  if (!name) return json(request, { error: "Name this flow." }, 400);
  if (!screens.some((s) => s.fields.length)) return json(request, { error: "Add at least one question." }, 400);
  await ensureSchema(env.DB);

  const id = (body.id || "").trim() || `flw_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const flowJson = buildFlowJson(screens, name);
  await env.DB.prepare(`INSERT INTO wa_flows (id, workspace_id, name, cta_label, flow_json, status)
    VALUES (?, ?, ?, ?, ?, 'DRAFT')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, cta_label = excluded.cta_label,
      flow_json = excluded.flow_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, session.workspaceId, name, (body.ctaLabel || "Open").slice(0, 20), JSON.stringify({ screens, flowJson })).run();
  return json(request, { ok: true, id, flowJson });
}

async function listFlows(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT id, meta_flow_id, name, status, cta_label, flow_json, updated_at,
      (SELECT count(*) FROM wa_flow_responses r WHERE r.workspace_id = f.workspace_id AND r.flow_id = f.meta_flow_id) response_count
    FROM wa_flows f WHERE workspace_id = ? ORDER BY updated_at DESC`)
    .bind(session.workspaceId).all<{ id: string; meta_flow_id: string; name: string; status: string; cta_label: string; flow_json: string; updated_at: string; response_count: number }>();
  return json(request, {
    flows: (rows.results || []).map((r) => {
      let screens: FlowScreen[] = [];
      try { screens = (JSON.parse(r.flow_json) as { screens?: FlowScreen[] }).screens || []; } catch { /* keep empty */ }
      return {
        id: r.id, metaFlowId: r.meta_flow_id, name: r.name, status: r.status,
        ctaLabel: r.cta_label, screens, responseCount: r.response_count, updatedAt: r.updated_at,
      };
    }),
  });
}

/** Creates the flow on Meta and publishes it. Publishing is what makes it sendable. */
async function publishFlow(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing flow id." }, 400);
  await ensureSchema(env.DB);

  const flow = await env.DB.prepare(`SELECT id, meta_flow_id, name, flow_json FROM wa_flows WHERE workspace_id = ? AND id = ?`)
    .bind(session.workspaceId, id).first<{ id: string; meta_flow_id: string; name: string; flow_json: string }>();
  if (!flow) return json(request, { error: "Flow not found." }, 404);
  const connection = await connectionFor(env.DB, session.workspaceId);
  if (!connection) return json(request, { error: "Connect WhatsApp Business in Channels first." }, 409);
  const auth = await graphAuth(env, connection);
  if (!auth) return json(request, { error: "Meta credentials are not configured on the server." }, 503);

  let flowJson: unknown = {};
  try { flowJson = (JSON.parse(flow.flow_json) as { flowJson?: unknown }).flowJson || {}; } catch { /* empty */ }
  const version = graphVersion(env);
  let metaFlowId = flow.meta_flow_id;

  if (!metaFlowId) {
    const created = await fetch(`https://graph.facebook.com/${version}/${connection.waba_id}/flows?appsecret_proof=${auth.proof}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: flow.name, categories: ["LEAD_GENERATION"] }),
    });
    if (!created.ok) return json(request, { error: await metaError(created) }, 502);
    metaFlowId = String(((await created.json()) as { id?: string }).id || "");
    if (!metaFlowId) return json(request, { error: "Meta did not return a flow id." }, 502);
  }

  // The JSON asset is uploaded as multipart — Meta rejects it as a plain JSON body.
  const form = new FormData();
  form.append("name", "flow.json");
  form.append("asset_type", "FLOW_JSON");
  form.append("file", new Blob([JSON.stringify(flowJson)], { type: "application/json" }), "flow.json");
  const upload = await fetch(`https://graph.facebook.com/${version}/${metaFlowId}/assets?appsecret_proof=${auth.proof}`, {
    method: "POST", headers: { authorization: `Bearer ${auth.token}` }, body: form,
  });
  if (!upload.ok) {
    const detail = await metaError(upload);
    await env.DB.prepare(`UPDATE wa_flows SET meta_flow_id = ?, status = 'DRAFT' WHERE workspace_id = ? AND id = ?`)
      .bind(metaFlowId, session.workspaceId, id).run();
    return json(request, { error: `Meta rejected the flow layout: ${detail}` }, 502);
  }

  const published = await fetch(`https://graph.facebook.com/${version}/${metaFlowId}/publish?appsecret_proof=${auth.proof}`, {
    method: "POST", headers: { authorization: `Bearer ${auth.token}` },
  });
  const status = published.ok ? "PUBLISHED" : "DRAFT";
  await env.DB.prepare(`UPDATE wa_flows SET meta_flow_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?`).bind(metaFlowId, status, session.workspaceId, id).run();
  if (!published.ok) return json(request, { error: `Flow uploaded but not published: ${await metaError(published)}`, metaFlowId }, 502);
  return json(request, { ok: true, metaFlowId, status });
}

/** Sends a published flow to one number as an interactive message. */
export async function sendFlowMessage(
  env: WaFlowsEnv, connection: ConnectionRow, to: string, metaFlowId: string, ctaLabel: string, bodyText: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await graphAuth(env, connection);
  if (!auth) return { ok: false, error: "Meta credentials are not configured." };
  const response = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${connection.phone_number_id}/messages?appsecret_proof=${auth.proof}`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: to.replace(/[^\d]/g, ""), type: "interactive",
      interactive: {
        type: "flow",
        body: { text: bodyText.slice(0, 1024) },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            // Correlates the reply back to this send without trusting anything the client returns.
            flow_token: `qpy_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
            flow_id: metaFlowId,
            flow_cta: ctaLabel.slice(0, 20),
            flow_action: "navigate",
          },
        },
      },
    }),
  });
  return response.ok ? { ok: true } : { ok: false, error: await metaError(response) };
}

/* ------------------------------------------------------------------ inbound flow replies */

export interface FlowReplyOutcome { flowToken: string; fields: Record<string, string> }

/**
 * Parses an nfm_reply — what Meta sends when a customer submits a flow.
 *
 * The interesting payload is a JSON *string* inside response_json, so it needs decoding twice.
 * flow_token is echoed back untouched and is the only reliable link to the send that caused it.
 */
export function parseFlowReply(item: Record<string, unknown>): FlowReplyOutcome | null {
  const interactive = item.interactive as { type?: string; nfm_reply?: { response_json?: string } } | undefined;
  const raw = interactive?.nfm_reply?.response_json;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    let flowToken = "";
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "flow_token") { flowToken = String(value ?? ""); continue; }
      // Meta echoes internal keys back alongside the answers; they are not form data.
      if (key.startsWith("__")) continue;
      const text = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      if (text) fields[key] = text.slice(0, 400);
    }
    return Object.keys(fields).length ? { flowToken, fields } : null;
  } catch { return null; }
}

/** Stores a submitted flow. Returns the parsed fields so the caller can feed lead qualification. */
export async function recordFlowReply(
  db: D1Database, workspaceId: string, waId: string, item: Record<string, unknown>,
): Promise<FlowReplyOutcome | null> {
  const parsed = parseFlowReply(item);
  if (!parsed) return null;
  await ensureSchema(db);
  await db.prepare(`INSERT INTO wa_flow_responses (id, workspace_id, flow_id, flow_token, wa_id, raw_json, parsed_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(`fr_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`, workspaceId, "", parsed.flowToken, waId,
      JSON.stringify(item).slice(0, 6000), JSON.stringify(parsed.fields)).run();
  return parsed;
}

async function listResponses(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT id, wa_id, parsed_json, created_at FROM wa_flow_responses
    WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`)
    .bind(session.workspaceId).all<{ id: string; wa_id: string; parsed_json: string; created_at: string }>();
  return json(request, {
    responses: (rows.results || []).map((r) => {
      let fields: Record<string, string> = {};
      try { fields = JSON.parse(r.parsed_json) as Record<string, string>; } catch { /* keep empty */ }
      return { id: r.id, waId: r.wa_id, fields, createdAt: r.created_at };
    }),
  });
}

async function checkTemplate(request: Request, env: WaFlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { name?: string; language?: string; category?: string };
  if (!body.name || !body.language) return json(request, { error: "name and language are required." }, 400);
  return json(request, await validateTemplate(env.DB, session.workspaceId, body.name, body.language, body.category));
}

export async function handleWaFlowsRequest(request: Request, env: WaFlowsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/wa/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/wa/templates" && request.method === "GET") return listTemplates(request, env);
  if (url.pathname === "/api/wa/templates/sync" && request.method === "POST") return syncTemplates(request, env);
  if (url.pathname === "/api/wa/templates/check" && request.method === "POST") return checkTemplate(request, env);
  if (url.pathname === "/api/wa/flows" && request.method === "GET") return listFlows(request, env);
  if (url.pathname === "/api/wa/flows" && request.method === "POST") return saveFlow(request, env);
  if (url.pathname === "/api/wa/flows/publish" && request.method === "POST") return publishFlow(request, env);
  if (url.pathname === "/api/wa/flows/responses" && request.method === "GET") return listResponses(request, env);
  return null;
}
