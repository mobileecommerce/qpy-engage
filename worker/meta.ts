const DEFAULT_GRAPH_VERSION = "v25.0";
const WORKSPACE_ID = "default";

export interface MetaEnv {
  DB: D1Database;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_EMBEDDED_SIGNUP_CONFIG_ID?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_TOKEN_ENCRYPTION_KEY?: string;
  META_SETUP_KEY?: string;
  META_GRAPH_VERSION?: string;
}

type ConnectionRow = {
  business_id: string | null;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  status: string | null;
  webhook_subscribed: number;
  connected_at: string;
  updated_at: string;
  token_ciphertext: string;
  token_iv: string;
};

const encoder = new TextEncoder();

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const host = new URL(origin).hostname;
  if (origin === "https://mobileecommerce.github.io" || host.endsWith(".chatgpt.site") || host === "localhost" || host === "127.0.0.1") return origin;
  return null;
}

function json(request: Request, body: unknown, status = 200): Response {
  const origin = allowedOrigin(request);
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function corsPreflight(request: Request): Response {
  const origin = allowedOrigin(request);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-qpy-setup-key",
    "access-control-max-age": "86400",
    "vary": "origin",
  } });
}

async function ensureMetaSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_connections (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      app_id TEXT NOT NULL,
      business_id TEXT,
      waba_id TEXT NOT NULL,
      phone_number_id TEXT NOT NULL,
      display_phone_number TEXT,
      verified_name TEXT,
      quality_rating TEXT,
      status TEXT,
      token_ciphertext TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      token_expires_at TEXT,
      webhook_subscribed INTEGER NOT NULL DEFAULT 0,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
      id TEXT PRIMARY KEY NOT NULL,
      object_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY NOT NULL,
      direction TEXT NOT NULL,
      wa_id TEXT,
      phone_number_id TEXT,
      message_type TEXT,
      message_text TEXT,
      status TEXT,
      message_timestamp TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_messages_wa_id_idx ON whatsapp_messages (wa_id)"),
  ]);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

async function hmacHex(secret: string, value: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, arrayBuffer(typeof value === "string" ? encoder.encode(value) : value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  const aa = new Uint8Array(a); const bb = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < aa.length; index++) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

async function requireSetupKey(request: Request, env: MetaEnv): Promise<Response | null> {
  if (!env.META_SETUP_KEY) return json(request, { error: "The secure workspace connection key has not been configured on the server." }, 503);
  const supplied = request.headers.get("x-qpy-setup-key") || "";
  if (!supplied || !(await safeEqual(supplied, env.META_SETUP_KEY))) return json(request, { error: "The workspace connection key is incorrect." }, 401);
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await sha256(secret);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: arrayBuffer(iv) }, await encryptionKey(secret), arrayBuffer(encoder.encode(token)));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptToken(ciphertext: string, iv: string, secret: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: arrayBuffer(base64ToBytes(iv)) }, await encryptionKey(secret), arrayBuffer(base64ToBytes(ciphertext)));
  return new TextDecoder().decode(decrypted);
}

function graphVersion(env: MetaEnv): string {
  return /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || "") ? env.META_GRAPH_VERSION! : DEFAULT_GRAPH_VERSION;
}

function publicConnection(row: ConnectionRow | null) {
  if (!row) return null;
  return {
    businessId: row.business_id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    qualityRating: row.quality_rating,
    status: row.status,
    webhookSubscribed: Boolean(row.webhook_subscribed),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

async function metaError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string; error_user_msg?: string } };
    return payload.error?.error_user_msg || payload.error?.message || `Meta returned HTTP ${response.status}`;
  } catch {
    return `Meta returned HTTP ${response.status}`;
  }
}

async function exchangeEmbeddedSignup(request: Request, env: MetaEnv): Promise<Response> {
  const denied = await requireSetupKey(request, env); if (denied) return denied;
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_TOKEN_ENCRYPTION_KEY) return json(request, { error: "Meta server credentials are incomplete." }, 503);
  const body = await request.json() as { code?: string; wabaId?: string; phoneNumberId?: string; businessId?: string };
  if (!body.code || !body.wabaId || !body.phoneNumberId || !/^\d+$/.test(body.wabaId) || !/^\d+$/.test(body.phoneNumberId)) return json(request, { error: "Meta did not return a complete WhatsApp account selection." }, 400);

  const tokenResponse = await fetch(`https://graph.facebook.com/${graphVersion(env)}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code: body.code }),
  });
  if (!tokenResponse.ok) return json(request, { error: await metaError(tokenResponse) }, 400);
  const tokenPayload = await tokenResponse.json() as { access_token?: string; expires_in?: number };
  if (!tokenPayload.access_token) return json(request, { error: "Meta did not issue an access token." }, 400);

  const proof = await hmacHex(env.META_APP_SECRET, tokenPayload.access_token);
  const phoneResponse = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${body.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status&appsecret_proof=${proof}`, { headers: { authorization: `Bearer ${tokenPayload.access_token}` } });
  if (!phoneResponse.ok) return json(request, { error: await metaError(phoneResponse) }, 400);
  const phone = await phoneResponse.json() as { display_phone_number?: string; verified_name?: string; quality_rating?: string; status?: string };

  const subscribeResponse = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${body.wabaId}/subscribed_apps?appsecret_proof=${proof}`, { method: "POST", headers: { authorization: `Bearer ${tokenPayload.access_token}` } });
  if (!subscribeResponse.ok) return json(request, { error: `The account was authorized, but webhook subscription failed: ${await metaError(subscribeResponse)}` }, 400);

  await ensureMetaSchema(env.DB);
  const encrypted = await encryptToken(tokenPayload.access_token, env.META_TOKEN_ENCRYPTION_KEY);
  const expiresAt = tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString() : null;
  await env.DB.prepare(`INSERT INTO whatsapp_connections
    (workspace_id, app_id, business_id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, token_ciphertext, token_iv, token_expires_at, webhook_subscribed, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id) DO UPDATE SET app_id=excluded.app_id, business_id=excluded.business_id, waba_id=excluded.waba_id,
    phone_number_id=excluded.phone_number_id, display_phone_number=excluded.display_phone_number, verified_name=excluded.verified_name,
    quality_rating=excluded.quality_rating, status=excluded.status, token_ciphertext=excluded.token_ciphertext, token_iv=excluded.token_iv,
    token_expires_at=excluded.token_expires_at, webhook_subscribed=1, updated_at=CURRENT_TIMESTAMP`)
    .bind(WORKSPACE_ID, env.META_APP_ID, body.businessId || null, body.wabaId, body.phoneNumberId, phone.display_phone_number || null, phone.verified_name || null, phone.quality_rating || null, phone.status || null, encrypted.ciphertext, encrypted.iv, expiresAt).run();

  const row = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(WORKSPACE_ID).first<ConnectionRow>();
  return json(request, { connected: true, connection: publicConnection(row) });
}

async function connectManualAccount(request: Request, env: MetaEnv): Promise<Response> {
  const denied = await requireSetupKey(request, env); if (denied) return denied;
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_TOKEN_ENCRYPTION_KEY) return json(request, { error: "Meta server credentials are incomplete." }, 503);
  const body = await request.json() as { accessToken?: string; wabaId?: string; phoneNumberId?: string; businessId?: string };
  const accessToken = (body.accessToken || "").trim();
  const wabaId = (body.wabaId || "").trim();
  const phoneNumberId = (body.phoneNumberId || "").trim();
  const businessId = (body.businessId || "").trim();
  if (!/^\d+$/.test(wabaId) || !/^\d+$/.test(phoneNumberId) || (businessId && !/^\d+$/.test(businessId))) return json(request, { error: "Enter valid numeric WABA and Phone Number IDs." }, 400);
  if (accessToken.length < 20) return json(request, { error: "Enter the access token shown in Meta API Setup." }, 400);

  const proof = await hmacHex(env.META_APP_SECRET, accessToken);
  const authorization = { authorization: `Bearer ${accessToken}` };
  const [phoneResponse, wabaResponse] = await Promise.all([
    fetch(`https://graph.facebook.com/${graphVersion(env)}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status&appsecret_proof=${proof}`, { headers: authorization }),
    fetch(`https://graph.facebook.com/${graphVersion(env)}/${wabaId}?fields=id,name&appsecret_proof=${proof}`, { headers: authorization }),
  ]);
  if (!phoneResponse.ok) return json(request, { error: `Phone Number ID could not be verified: ${await metaError(phoneResponse)}` }, 400);
  if (!wabaResponse.ok) return json(request, { error: `WhatsApp Business Account ID could not be verified: ${await metaError(wabaResponse)}` }, 400);
  const phone = await phoneResponse.json() as { display_phone_number?: string; verified_name?: string; quality_rating?: string; status?: string };

  const subscribeResponse = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${wabaId}/subscribed_apps?appsecret_proof=${proof}`, { method: "POST", headers: authorization });
  if (!subscribeResponse.ok) return json(request, { error: `The credentials are valid, but webhook subscription failed: ${await metaError(subscribeResponse)}` }, 400);

  const encrypted = await encryptToken(accessToken, env.META_TOKEN_ENCRYPTION_KEY);
  await env.DB.prepare(`INSERT INTO whatsapp_connections
    (workspace_id, app_id, business_id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, token_ciphertext, token_iv, token_expires_at, webhook_subscribed, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id) DO UPDATE SET app_id=excluded.app_id, business_id=excluded.business_id, waba_id=excluded.waba_id,
    phone_number_id=excluded.phone_number_id, display_phone_number=excluded.display_phone_number, verified_name=excluded.verified_name,
    quality_rating=excluded.quality_rating, status=excluded.status, token_ciphertext=excluded.token_ciphertext, token_iv=excluded.token_iv,
    token_expires_at=NULL, webhook_subscribed=1, updated_at=CURRENT_TIMESTAMP`)
    .bind(WORKSPACE_ID, env.META_APP_ID, businessId || null, wabaId, phoneNumberId, phone.display_phone_number || null, phone.verified_name || null, phone.quality_rating || null, phone.status || null, encrypted.ciphertext, encrypted.iv).run();

  const row = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(WORKSPACE_ID).first<ConnectionRow>();
  return json(request, { connected: true, connection: publicConnection(row) });
}

async function sendTestMessage(request: Request, env: MetaEnv): Promise<Response> {
  const denied = await requireSetupKey(request, env); if (denied) return denied;
  if (!env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) return json(request, { error: "Meta server credentials are incomplete." }, 503);
  const body = await request.json() as { to?: string };
  const to = (body.to || "").replace(/[^\d]/g, "");
  if (to.length < 8 || to.length > 15) return json(request, { error: "Enter a valid recipient number including country code." }, 400);
  await ensureMetaSchema(env.DB);
  const connection = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(WORKSPACE_ID).first<ConnectionRow>();
  if (!connection) return json(request, { error: "Connect a WhatsApp account first." }, 409);
  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  const proof = await hmacHex(env.META_APP_SECRET, token);
  const response = await fetch(`https://graph.facebook.com/${graphVersion(env)}/${connection.phone_number_id}/messages?appsecret_proof=${proof}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }),
  });
  if (!response.ok) return json(request, { error: await metaError(response) }, 400);
  const payload = await response.json() as { messages?: Array<{ id: string }> };
  return json(request, { sent: true, messageId: payload.messages?.[0]?.id || null });
}

async function verifyWebhook(request: Request, env: MetaEnv): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";
  if (mode === "subscribe" && env.META_WEBHOOK_VERIFY_TOKEN && await safeEqual(token, env.META_WEBHOOK_VERIFY_TOKEN)) return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  return new Response("Webhook verification failed", { status: 403 });
}

async function receiveWebhook(request: Request, env: MetaEnv): Promise<Response> {
  if (!env.META_APP_SECRET) return new Response("Webhook secret unavailable", { status: 503 });
  const raw = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("x-hub-signature-256") || "";
  const expected = `sha256=${await hmacHex(env.META_APP_SECRET, raw)}`;
  if (!signature || !(await safeEqual(signature, expected))) return new Response("Invalid webhook signature", { status: 401 });
  const payload = JSON.parse(new TextDecoder().decode(raw)) as { object?: string; entry?: Array<{ id?: string; changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>> } }> }> };
  await ensureMetaSchema(env.DB);
  const eventId = request.headers.get("x-hub-signature-256") || crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_webhook_events (id, object_type, payload) VALUES (?, ?, ?)").bind(eventId, payload.object || "unknown", JSON.stringify(payload)).run();
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {}; const phoneNumberId = value.metadata?.phone_number_id || null;
    for (const item of value.messages || []) {
      const id = String(item.id || crypto.randomUUID()); const text = (item.text as { body?: string } | undefined)?.body || null;
      await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_messages (id, direction, wa_id, phone_number_id, message_type, message_text, status, message_timestamp, payload) VALUES (?, 'inbound', ?, ?, ?, ?, 'received', ?, ?)")
        .bind(id, item.from ? String(item.from) : null, phoneNumberId, item.type ? String(item.type) : null, text, item.timestamp ? String(item.timestamp) : null, JSON.stringify(item)).run();
    }
    for (const item of value.statuses || []) {
      const id = String(item.id || crypto.randomUUID());
      await env.DB.prepare("INSERT INTO whatsapp_messages (id, direction, wa_id, phone_number_id, status, message_timestamp, payload) VALUES (?, 'outbound', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, message_timestamp=excluded.message_timestamp, payload=excluded.payload")
        .bind(id, item.recipient_id ? String(item.recipient_id) : null, phoneNumberId, item.status ? String(item.status) : null, item.timestamp ? String(item.timestamp) : null, JSON.stringify(item)).run();
    }
  }
  return new Response("EVENT_RECEIVED", { status: 200, headers: { "content-type": "text/plain" } });
}

export async function handleMetaRequest(request: Request, env: MetaEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/webhooks/whatsapp") return request.method === "GET" ? verifyWebhook(request, env) : request.method === "POST" ? receiveWebhook(request, env) : new Response("Method not allowed", { status: 405 });
  if (!url.pathname.startsWith("/api/meta/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);
  await ensureMetaSchema(env.DB);

  if (url.pathname === "/api/meta/config" && request.method === "GET") return json(request, {
    appId: env.META_APP_ID || null,
    configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID || null,
    graphVersion: graphVersion(env),
    ready: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_EMBEDDED_SIGNUP_CONFIG_ID && env.META_TOKEN_ENCRYPTION_KEY && env.META_SETUP_KEY && env.META_WEBHOOK_VERIFY_TOKEN),
    webhookUrl: `${url.origin}/api/webhooks/whatsapp`,
    missing: [!env.META_APP_ID&&"META_APP_ID", !env.META_APP_SECRET&&"META_APP_SECRET", !env.META_EMBEDDED_SIGNUP_CONFIG_ID&&"META_EMBEDDED_SIGNUP_CONFIG_ID", !env.META_TOKEN_ENCRYPTION_KEY&&"META_TOKEN_ENCRYPTION_KEY", !env.META_SETUP_KEY&&"META_SETUP_KEY", !env.META_WEBHOOK_VERIFY_TOKEN&&"META_WEBHOOK_VERIFY_TOKEN"].filter(Boolean),
  });
  if (url.pathname === "/api/meta/status" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(WORKSPACE_ID).first<ConnectionRow>();
    return json(request, { connected: Boolean(row), connection: publicConnection(row) });
  }
  if (url.pathname === "/api/meta/oauth/exchange" && request.method === "POST") return exchangeEmbeddedSignup(request, env);
  if (url.pathname === "/api/meta/manual/connect" && request.method === "POST") return connectManualAccount(request, env);
  if (url.pathname === "/api/meta/test-message" && request.method === "POST") return sendTestMessage(request, env);
  if (url.pathname === "/api/meta/connection" && request.method === "DELETE") {
    const denied = await requireSetupKey(request, env); if (denied) return denied;
    await env.DB.prepare("DELETE FROM whatsapp_connections WHERE workspace_id = ?").bind(WORKSPACE_ID).run();
    return json(request, { disconnected: true });
  }
  return json(request, { error: "Not found" }, 404);
}
