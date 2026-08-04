import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";
import { decryptToken, hmacHex, graphVersion, metaError, type ConnectionRow, type MetaEnv } from "./meta";

export interface TemplatesEnv extends AuthEnv, MetaEnv {
  DB: D1Database;
}

/* ================================================================================================
   Message template authoring.

   Meta owns approval, and a rejection can take a day to come back with a reason like "INVALID_FORMAT"
   that says nothing about which rule was broken. So the whole point of this module is to enforce
   Meta's rules *locally*, at the moment of typing, and refuse to submit anything that will predictably
   bounce — the difference between a fixable mistake and a wasted day.

   Drafts live in their own table rather than in wa_templates. That one mirrors what Meta reports and
   is overwritten by every sync; a draft that has never been submitted has no counterpart there and
   would be erased by the first refresh.
   ============================================================================================== */

export type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type HeaderType = "" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type ButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";

export interface TemplateButton { type: ButtonType; text: string; url?: string; phone?: string }

export interface TemplateDraft {
  id?: string;
  name: string;
  language: string;
  category: TemplateCategory;
  headerType: HeaderType;
  headerText: string;
  body: string;
  footer: string;
  buttons: TemplateButton[];
  examples: string[];
}

// Meta's documented ceilings. Encoded as constants because a body that is one character over is
// rejected asynchronously, hours later, with no indication of which limit was hit.
const LIMITS = {
  name: 512, header: 60, body: 1024, footer: 60,
  buttonText: 25, url: 2000, quickReplies: 10, urlButtons: 2, phoneButtons: 1, totalButtons: 10,
};

let schemaReady = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_template_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en_US',
      category TEXT NOT NULL DEFAULT 'MARKETING',
      header_type TEXT NOT NULL DEFAULT '',
      header_text TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      footer_text TEXT NOT NULL DEFAULT '',
      buttons TEXT NOT NULL DEFAULT '[]',
      examples TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      meta_template_id TEXT NOT NULL DEFAULT '',
      reject_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // Meta identifies a template by name and language together, so the same name in two languages
    // is legitimate and must not collide.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_draft_name ON wa_template_drafts (workspace_id, name, language)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_draft_status ON wa_template_drafts (workspace_id, status)`),
  ]);
  schemaReady = true;
}

/* ------------------------------------------------------------------ validation */

export interface ValidationIssue { field: string; message: string }

/** Meta names a template with lowercase letters, digits and underscores — nothing else. */
export function toTemplateName(raw: string): string {
  return (raw || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, LIMITS.name);
}

function variablesIn(text: string): number[] {
  return [...(text || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/**
 * Every rule Meta enforces on a template body, checked before submission.
 *
 * The placement rules are the ones that actually surprise people: a body may not begin or end with a
 * variable, and two variables may not sit next to each other with only whitespace between. Meta
 * rejects both — the template would render with nothing around the substituted value, which reads as
 * spam — and the rejection arrives hours later saying only that the format is invalid.
 */
export function validateDraft(draft: TemplateDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = (draft.body || "").trim();

  const name = (draft.name || "").trim();
  if (!name) issues.push({ field: "name", message: "Give the template a name." });
  else if (name !== toTemplateName(name)) {
    issues.push({ field: "name", message: "Meta only allows lowercase letters, numbers and underscores in a template name." });
  }
  if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(draft.category)) {
    issues.push({ field: "category", message: "Choose a category — it decides how Meta bills each send." });
  }

  if (!body) issues.push({ field: "body", message: "The message body is required." });
  if (body.length > LIMITS.body) issues.push({ field: "body", message: `Body is ${body.length} characters — Meta's limit is ${LIMITS.body}.` });

  const bodyVars = variablesIn(body);
  if (bodyVars.length) {
    // Sequential from 1 with no gaps: {{1}}, {{3}} is rejected.
    const unique = [...new Set(bodyVars)].sort((a, b) => a - b);
    const expected = unique.map((_, i) => i + 1);
    if (unique.join(",") !== expected.join(",")) {
      issues.push({ field: "body", message: `Variables must run in order from {{1}} with no gaps. Yours are ${unique.map((n) => `{{${n}}}`).join(", ")}.` });
    }
    if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) {
      issues.push({ field: "body", message: "The body cannot start with a variable — Meta needs some text before it." });
    }
    if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) {
      issues.push({ field: "body", message: "The body cannot end with a variable — Meta needs some text after it." });
    }
    if (/\}\}\s*\{\{/.test(body)) {
      issues.push({ field: "body", message: "Two variables cannot sit next to each other — put some words between them." });
    }
    // Meta requires a sample for each variable so a reviewer can see the rendered message.
    const provided = (draft.examples || []).filter((e) => (e || "").trim()).length;
    if (provided < unique.length) {
      issues.push({ field: "examples", message: `Add an example value for each variable — ${unique.length} needed, ${provided} filled in.` });
    }
  }

  const header = (draft.headerText || "").trim();
  if (draft.headerType === "TEXT") {
    if (!header) issues.push({ field: "header", message: "The header is set to text but is empty." });
    if (header.length > LIMITS.header) issues.push({ field: "header", message: `Header is ${header.length} characters — Meta's limit is ${LIMITS.header}.` });
    if (variablesIn(header).length > 1) issues.push({ field: "header", message: "A header can contain at most one variable." });
  }

  const footer = (draft.footer || "").trim();
  if (footer.length > LIMITS.footer) issues.push({ field: "footer", message: `Footer is ${footer.length} characters — Meta's limit is ${LIMITS.footer}.` });
  if (variablesIn(footer).length) issues.push({ field: "footer", message: "Footers cannot contain variables." });

  const buttons = draft.buttons || [];
  if (buttons.length > LIMITS.totalButtons) issues.push({ field: "buttons", message: `Meta allows at most ${LIMITS.totalButtons} buttons.` });
  const counts = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 };
  for (const [index, button] of buttons.entries()) {
    counts[button.type] = (counts[button.type] || 0) + 1;
    const text = (button.text || "").trim();
    if (!text) issues.push({ field: `button.${index}`, message: `Button ${index + 1} needs a label.` });
    if (text.length > LIMITS.buttonText) issues.push({ field: `button.${index}`, message: `Button ${index + 1} label is ${text.length} characters — the limit is ${LIMITS.buttonText}.` });
    if (button.type === "URL" && !(button.url || "").trim()) issues.push({ field: `button.${index}`, message: `Button ${index + 1} needs a URL.` });
    if (button.type === "URL" && (button.url || "").length > LIMITS.url) issues.push({ field: `button.${index}`, message: `Button ${index + 1} URL is too long.` });
    if (button.type === "PHONE_NUMBER" && !(button.phone || "").trim()) issues.push({ field: `button.${index}`, message: `Button ${index + 1} needs a phone number.` });
  }
  if (counts.URL > LIMITS.urlButtons) issues.push({ field: "buttons", message: `At most ${LIMITS.urlButtons} link buttons are allowed.` });
  if (counts.PHONE_NUMBER > LIMITS.phoneButtons) issues.push({ field: "buttons", message: "Only one call button is allowed." });
  if (counts.QUICK_REPLY > LIMITS.quickReplies) issues.push({ field: "buttons", message: `At most ${LIMITS.quickReplies} quick replies are allowed.` });
  // Meta requires quick replies to form one contiguous group; interleaving them with link or call
  // buttons is rejected.
  const kinds = buttons.map((b) => (b.type === "QUICK_REPLY" ? "q" : "c")).join("");
  if (/q+c+q/.test(kinds)) {
    issues.push({ field: "buttons", message: "Keep quick replies together — Meta rejects them when split by a link or call button." });
  }

  return issues;
}

/** The component array Meta's API expects. Only built once validation has passed. */
export function toMetaComponents(draft: TemplateDraft): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  const header = (draft.headerText || "").trim();

  if (draft.headerType === "TEXT" && header) {
    const component: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: header };
    const headerVars = variablesIn(header);
    if (headerVars.length) component.example = { header_text: [(draft.examples || [])[0] || "Sample"] };
    components.push(component);
  } else if (draft.headerType && draft.headerType !== "TEXT") {
    // Media headers carry a sample asset handle at submission; the operator supplies the real media
    // per send. Declared without an example so Meta treats it as a media placeholder.
    components.push({ type: "HEADER", format: draft.headerType });
  }

  const body: Record<string, unknown> = { type: "BODY", text: (draft.body || "").trim() };
  const bodyVars = [...new Set(variablesIn(draft.body || ""))];
  if (bodyVars.length) {
    body.example = { body_text: [bodyVars.map((_, i) => (draft.examples || [])[i] || "Sample")] };
  }
  components.push(body);

  const footer = (draft.footer || "").trim();
  if (footer) components.push({ type: "FOOTER", text: footer });

  if ((draft.buttons || []).length) {
    components.push({
      type: "BUTTONS",
      buttons: draft.buttons.map((button) => {
        if (button.type === "URL") return { type: "URL", text: button.text.trim(), url: (button.url || "").trim() };
        if (button.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: button.text.trim(), phone_number: (button.phone || "").trim() };
        return { type: "QUICK_REPLY", text: button.text.trim() };
      }),
    });
  }
  return components;
}

/* ------------------------------------------------------------------ persistence */

interface DraftRow {
  id: string; name: string; language: string; category: string; header_type: string; header_text: string;
  body_text: string; footer_text: string; buttons: string; examples: string; status: string;
  meta_template_id: string; reject_reason: string; updated_at: string;
}

function rowToDraft(row: DraftRow): TemplateDraft & { status: string; metaTemplateId: string; rejectReason: string; updatedAt: string } {
  const parse = <T,>(raw: string, fallback: T): T => { try { return JSON.parse(raw) as T; } catch { return fallback; } };
  return {
    id: row.id, name: row.name, language: row.language, category: row.category as TemplateCategory,
    headerType: row.header_type as HeaderType, headerText: row.header_text, body: row.body_text,
    footer: row.footer_text, buttons: parse<TemplateButton[]>(row.buttons, []), examples: parse<string[]>(row.examples, []),
    status: row.status, metaTemplateId: row.meta_template_id, rejectReason: row.reject_reason, updatedAt: row.updated_at,
  };
}

async function listDrafts(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT * FROM wa_template_drafts WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 200`)
    .bind(session.workspaceId).all<DraftRow>();
  return json(request, { drafts: (rows.results || []).map(rowToDraft) });
}

function readDraft(body: Record<string, unknown>): TemplateDraft {
  const buttons = Array.isArray(body.buttons) ? (body.buttons as TemplateButton[]).slice(0, LIMITS.totalButtons) : [];
  return {
    id: String(body.id ?? "").trim(),
    name: String(body.name ?? "").trim(),
    language: String(body.language ?? "en_US").trim() || "en_US",
    category: (String(body.category ?? "MARKETING").toUpperCase() as TemplateCategory),
    headerType: (String(body.headerType ?? "") as HeaderType),
    headerText: String(body.headerText ?? ""),
    body: String(body.body ?? ""),
    footer: String(body.footer ?? ""),
    buttons: buttons.map((b) => ({
      type: (["QUICK_REPLY", "URL", "PHONE_NUMBER"].includes(String(b?.type)) ? b.type : "QUICK_REPLY") as ButtonType,
      text: String(b?.text ?? "").slice(0, 60),
      url: String(b?.url ?? "").slice(0, LIMITS.url),
      phone: String(b?.phone ?? "").slice(0, 30),
    })),
    examples: Array.isArray(body.examples) ? (body.examples as unknown[]).slice(0, 12).map((e) => String(e ?? "")) : [],
  };
}

/**
 * Saving is deliberately permissive: a half-written template is still worth keeping, and refusing to
 * save until it is perfect would lose work every time someone stepped away mid-edit. Validation runs
 * anyway and its findings come back with the response so the composer can show them live — it just
 * does not block. Submission is where the rules become binding.
 */
async function saveDraft(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const draft = readDraft(await request.json() as Record<string, unknown>);
  if (!draft.name) return json(request, { error: "Give the template a name before saving." }, 400);
  await ensureSchema(env.DB);

  const id = draft.id || `tpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const existing = draft.id
    ? await env.DB.prepare(`SELECT status FROM wa_template_drafts WHERE workspace_id = ? AND id = ?`)
        .bind(session.workspaceId, draft.id).first<{ status: string }>()
    : null;
  // Once Meta has it, the submitted copy is what governs — editing locally would show one thing and
  // send another. Meta has no update endpoint for an approved template's content either.
  if (existing && existing.status !== "DRAFT" && existing.status !== "REJECTED") {
    return json(request, { error: `This template is ${existing.status} on Meta and can no longer be edited. Duplicate it under a new name instead.` }, 409);
  }

  await env.DB.prepare(`INSERT INTO wa_template_drafts
      (id, workspace_id, name, language, category, header_type, header_text, body_text, footer_text, buttons, examples, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, language = excluded.language, category = excluded.category,
      header_type = excluded.header_type, header_text = excluded.header_text, body_text = excluded.body_text,
      footer_text = excluded.footer_text, buttons = excluded.buttons, examples = excluded.examples,
      status = 'DRAFT', reject_reason = '', updated_at = CURRENT_TIMESTAMP`)
    .bind(id, session.workspaceId, toTemplateName(draft.name), draft.language, draft.category,
      draft.headerType, draft.headerText.slice(0, 200), draft.body.slice(0, LIMITS.body + 200),
      draft.footer.slice(0, 200), JSON.stringify(draft.buttons), JSON.stringify(draft.examples))
    .run()
    .catch(() => { throw new Error("A template with that name and language already exists."); });

  return json(request, { ok: true, id, issues: validateDraft({ ...draft, name: toTemplateName(draft.name) }) });
}

async function deleteDraft(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing id." }, 400);
  await ensureSchema(env.DB);
  // Local only. Deleting on Meta is a separate, irreversible action and is not implied by tidying
  // up the draft list here.
  await env.DB.prepare(`DELETE FROM wa_template_drafts WHERE workspace_id = ? AND id = ?`)
    .bind(session.workspaceId, id).run();
  return json(request, { ok: true });
}

async function validateOnly(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const draft = readDraft(await request.json() as Record<string, unknown>);
  return json(request, { issues: validateDraft(draft), components: toMetaComponents(draft) });
}

/* ------------------------------------------------------------------ submission */

async function submitDraft(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { id?: string };
  const id = (body.id || "").trim();
  if (!id) return json(request, { error: "Missing id." }, 400);
  await ensureSchema(env.DB);

  const row = await env.DB.prepare(`SELECT * FROM wa_template_drafts WHERE workspace_id = ? AND id = ?`)
    .bind(session.workspaceId, id).first<DraftRow>();
  if (!row) return json(request, { error: "Template not found." }, 404);
  const draft = rowToDraft(row);

  // Binding here, unlike on save. Submitting something Meta will reject costs a day of waiting for
  // a message that will not say which rule was broken.
  const issues = validateDraft(draft);
  if (issues.length) return json(request, { error: "Fix the highlighted problems before submitting.", issues }, 400);

  const connection = await env.DB.prepare(`SELECT * FROM whatsapp_connections WHERE workspace_id = ?`)
    .bind(session.workspaceId).first<ConnectionRow>();
  if (!connection) return json(request, { error: "Connect WhatsApp Business in Channels first." }, 409);
  if (!env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) {
    return json(request, { error: "Meta credentials are not configured on the server." }, 503);
  }
  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  const proof = await hmacHex(env.META_APP_SECRET, token);

  const response = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${connection.waba_id}/message_templates?appsecret_proof=${proof}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: draft.name, language: draft.language, category: draft.category,
      components: toMetaComponents(draft),
    }),
  });

  if (!response.ok) {
    const detail = await metaError(response);
    await env.DB.prepare(`UPDATE wa_template_drafts SET status = 'REJECTED', reject_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`).bind(detail.slice(0, 400), session.workspaceId, id).run();
    return json(request, { error: detail }, 502);
  }

  const created = await response.json() as { id?: string; status?: string };
  const status = (created.status || "PENDING").toUpperCase();
  await env.DB.prepare(`UPDATE wa_template_drafts SET status = ?, meta_template_id = ?, reject_reason = '',
    updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
    .bind(status, String(created.id || ""), session.workspaceId, id).run();

  return json(request, { ok: true, status, metaTemplateId: created.id || "" });
}

/**
 * Pulls current approval status back from Meta for anything already submitted. Review is asynchronous
 * and can take up to a day, so a draft's status is only ever as fresh as the last refresh.
 */
async function refreshStatuses(request: Request, env: TemplatesEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureSchema(env.DB);
  const pending = await env.DB.prepare(`SELECT id, name, language FROM wa_template_drafts
    WHERE workspace_id = ? AND status NOT IN ('DRAFT')`).bind(session.workspaceId).all<{ id: string; name: string; language: string }>();
  const rows = pending.results || [];
  if (!rows.length) return json(request, { ok: true, updated: 0 });

  const connection = await env.DB.prepare(`SELECT * FROM whatsapp_connections WHERE workspace_id = ?`)
    .bind(session.workspaceId).first<ConnectionRow>();
  if (!connection || !env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) {
    return json(request, { error: "Connect WhatsApp Business in Channels first." }, 409);
  }
  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  const proof = await hmacHex(env.META_APP_SECRET, token);
  const response = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${connection.waba_id}/message_templates?limit=200&fields=name,language,status&appsecret_proof=${proof}`,
    { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return json(request, { error: await metaError(response) }, 502);

  const payload = await response.json() as { data?: Array<{ name?: string; language?: string; status?: string }> };
  const statusBy = new Map((payload.data || []).map((t) => [`${t.name}::${t.language}`, (t.status || "").toUpperCase()]));
  let updated = 0;
  for (const draftRow of rows) {
    const status = statusBy.get(`${draftRow.name}::${draftRow.language}`);
    if (!status) continue;
    updated++;
    await env.DB.prepare(`UPDATE wa_template_drafts SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`).bind(status, session.workspaceId, draftRow.id).run();
  }
  return json(request, { ok: true, updated });
}

export async function handleTemplatesRequest(request: Request, env: TemplatesEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/templates")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/templates" && request.method === "GET") return listDrafts(request, env);
  if (url.pathname === "/api/templates" && request.method === "POST") return saveDraft(request, env);
  if (url.pathname === "/api/templates/delete" && request.method === "POST") return deleteDraft(request, env);
  if (url.pathname === "/api/templates/validate" && request.method === "POST") return validateOnly(request, env);
  if (url.pathname === "/api/templates/submit" && request.method === "POST") return submitDraft(request, env);
  if (url.pathname === "/api/templates/refresh" && request.method === "POST") return refreshStatuses(request, env);
  return null;
}
