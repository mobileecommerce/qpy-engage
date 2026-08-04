import { requireSession, requireRole, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin, sha256, bytesToBase64 } from "./shared";
import { decryptToken, graphVersion, metaError, hmacHex, type MetaEnv, type ConnectionRow } from "./meta";
import { deductMessageBalance, incrementSentCount } from "./messageBalance";

export interface OtpEnv extends AuthEnv, MetaEnv {
  DB: D1Database;
}

let apiKeysSchemaEnsured = false;

async function ensureApiKeysSchema(db: D1Database): Promise<void> {
  if (apiKeysSchemaEnsured) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS workspace_api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON workspace_api_keys (key_hash)`).run();
  apiKeysSchemaEnsured = true;
}

async function hashKey(key: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await sha256(key)));
}

function generateApiKey(): { key: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `qpy_live_${body}`;
  return { key, prefix: key.slice(0, 16) };
}

// ── Dashboard-facing API-key management (session-authenticated, Owner/Admin only) ──

async function listApiKeys(request: Request, env: OtpEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureApiKeysSchema(env.DB);
  const result = await env.DB.prepare(`SELECT id, name, key_prefix as keyPrefix, created_at as createdAt, last_used_at as lastUsedAt
    FROM workspace_api_keys WHERE workspace_id = ? ORDER BY created_at DESC`).bind(session.workspaceId)
    .all<{ id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null }>();
  return json(request, { keys: result.results || [] });
}

async function createApiKey(request: Request, env: OtpEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const denied = requireRole(request, session, ["Owner", "Admin"]);
  if (denied) return denied;
  await ensureApiKeysSchema(env.DB);
  const body = await request.json() as { name?: string };
  const name = (body.name || "").trim().slice(0, 80) || "API key";
  const { key, prefix } = generateApiKey();
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO workspace_api_keys (id, workspace_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, session.workspaceId, name, await hashKey(key), prefix).run();
  // The full key is returned exactly once — only its hash is stored, so it can never be shown again.
  return json(request, { id, name, key, keyPrefix: prefix });
}

async function deleteApiKey(request: Request, env: OtpEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const denied = requireRole(request, session, ["Owner", "Admin"]);
  if (denied) return denied;
  await ensureApiKeysSchema(env.DB);
  await env.DB.prepare(`DELETE FROM workspace_api_keys WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).run();
  return json(request, { deleted: true });
}

// ── Machine-to-machine OTP send (API-key authenticated, called by the customer's own backend) ──

async function resolveApiKeyWorkspace(request: Request, env: OtpEnv): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = bearer || request.headers.get("x-api-key") || "";
  if (!key.startsWith("qpy_live_")) return null;
  await ensureApiKeysSchema(env.DB);
  const row = await env.DB.prepare(`SELECT id, workspace_id as workspaceId FROM workspace_api_keys WHERE key_hash = ?`)
    .bind(await hashKey(key)).first<{ id: string; workspaceId: string }>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE workspace_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
  return row.workspaceId;
}

async function sendOtp(request: Request, env: OtpEnv): Promise<Response> {
  if (!env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) return json(request, { error: "Meta server credentials are incomplete." }, 503);
  const workspaceId = await resolveApiKeyWorkspace(request, env);
  if (!workspaceId) return json(request, { error: "Invalid or missing API key." }, 401);

  const disabled = await env.DB.prepare("SELECT status FROM workspaces WHERE id = ?").bind(workspaceId).first<{ status: string | null }>();
  if (!disabled) return json(request, { error: "Workspace not found." }, 404);
  if (disabled.status === "disabled") return json(request, { error: "This workspace is disabled." }, 403);

  const body = await request.json() as { to?: string; code?: string; templateName?: string; templateLanguage?: string; copyCodeButton?: boolean };
  const to = (body.to || "").replace(/[^\d]/g, "");
  const code = (body.code || "").trim();
  const templateName = (body.templateName || "").trim();
  const templateLanguage = (body.templateLanguage || "en_US").trim();
  if (to.length < 8 || to.length > 15) return json(request, { error: "Provide a valid recipient phone number including country code." }, 400);
  if (!code || code.length > 15) return json(request, { error: "Provide the verification code (1–15 characters)." }, 400);
  if (!templateName) return json(request, { error: "Provide the name of your approved WhatsApp authentication template." }, 400);

  const connection = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(workspaceId).first<ConnectionRow>();
  if (!connection) return json(request, { error: "This workspace has no connected WhatsApp Business account." }, 409);

  // Reserve one Authentication credit up front so a failed send doesn't silently consume nothing
  // but also can't over-send beyond what's purchased. Refunded below if Meta rejects the message.
  const deduction = await deductMessageBalance(env.DB, workspaceId, "Authentication", 1);
  if (!deduction.ok) return json(request, { error: deduction.error }, 402);

  // WhatsApp authentication templates take the code as a body parameter; templates with a
  // one-tap "copy code" button also need it repeated as a URL-button parameter. Included by
  // default (Meta's standard authentication template has the button); pass copyCodeButton:false
  // to omit it for a body-only template.
  const components: unknown[] = [{ type: "body", parameters: [{ type: "text", text: code }] }];
  if (body.copyCodeButton !== false) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] });
  }

  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  const proof = await hmacHex(env.META_APP_SECRET, token);
  const response = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${connection.phone_number_id}/messages?appsecret_proof=${proof}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: templateLanguage }, components } }),
  });
  if (!response.ok) {
    // Refund the reserved credit — the message never went out.
    await env.DB.prepare(`UPDATE workspace_message_balance SET message_count = message_count + 1 WHERE workspace_id = ? AND category = 'Authentication'`).bind(workspaceId).run();
    return json(request, { error: await metaError(response) }, 400);
  }
  await incrementSentCount(env.DB, workspaceId, "Authentication", 1).catch(() => {});
  const payload = await response.json() as { messages?: Array<{ id: string }> };
  return json(request, { sent: true, messageId: payload.messages?.[0]?.id || null, authenticationCreditsRemaining: deduction.balances.Authentication });
}

export async function handleOtpRequest(request: Request, env: OtpEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/api-keys") && url.pathname !== "/api/whatsapp/send-otp") return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  // Server-to-server OTP send: authenticated purely by the secret API key, so it does not apply
  // the browser-origin allowlist (a customer's backend has no Origin header, and the key is the
  // security boundary — same reasoning as the public widget endpoints).
  if (url.pathname === "/api/whatsapp/send-otp" && request.method === "POST") return sendOtp(request, env);

  // Dashboard key-management endpoints keep the standard session + origin checks.
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (url.pathname === "/api/api-keys" && request.method === "GET") return listApiKeys(request, env);
  if (url.pathname === "/api/api-keys" && request.method === "POST") return createApiKey(request, env);
  const keyMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)$/);
  if (keyMatch && request.method === "DELETE") return deleteApiKey(request, env, keyMatch[1]);
  return json(request, { error: "Not found" }, 404);
}
