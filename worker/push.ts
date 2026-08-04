import { json, corsPreflight, allowedOrigin, bytesToBase64, base64ToBytes, encoder, arrayBuffer } from "./shared";
import { requireSession, type AuthEnv } from "./auth";

export interface PushEnv extends AuthEnv {
  DB: D1Database;
  // Apple. The key is the .p8 contents; the other two identify which key and which team it is.
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_ENVIRONMENT?: string; // "sandbox" during TestFlight, "production" once live
  // Google. A service-account JSON's client_email and private_key, plus the project id.
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
}

/* ================================================================================================
   Push notifications.

   Built to sit dormant. Without credentials every send is a no-op that records why, so this can
   ship today and start delivering the moment the Apple account clears — rather than waiting on a
   developer enrolment to write any of it.

   Push is also what makes the store submission viable at all: Apple rejects apps that are a website
   in a wrapper under guideline 4.2, and a native capability the web cannot provide is the thing
   that answers that objection.
   ============================================================================================== */

export type Platform = "ios" | "android";

const MAX_TOKENS_PER_USER = 10;
const APNS_TOKEN_TTL_SECONDS = 45 * 60; // Apple rejects provider tokens older than an hour.

let schemaReady = false;

export async function ensurePushSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      -- Set when the platform tells us the token is dead. Kept rather than deleted so a device that
      -- re-registers is recognised as returning rather than treated as new.
      failed_at TEXT,
      fail_reason TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_workspace ON push_tokens (workspace_id, failed_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_tokens (user_id)`),
    // Every attempt, delivered or not. Without this a silent push failure is invisible, which is
    // the exact class of bug that has cost the most time on this codebase already.
    db.prepare(`CREATE TABLE IF NOT EXISTS push_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_log ON push_log (workspace_id, created_at DESC)`),
  ]);
  schemaReady = true;
}

/* ------------------------------------------------------------------ signing */

function b64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strips the PEM armour and returns the DER bytes inside. */
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(body);
}

/**
 * The provider token Apple requires on every push. It is an ES256 JWT signed with the .p8 key, and
 * is cached by the caller because Apple rate-limits token generation far more tightly than sends.
 */
async function apnsProviderToken(env: PushEnv): Promise<string | null> {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  const header = { alg: "ES256", kid: env.APNS_KEY_ID };
  const claims = { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claims)))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", arrayBuffer(pemToDer(env.APNS_KEY_P8)),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, arrayBuffer(encoder.encode(signingInput)));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Google requires an OAuth access token, obtained by signing a JWT with the service account key.
 * RS256 rather than ES256 — the two providers agree on almost nothing.
 */
async function fcmAccessToken(env: PushEnv): Promise<string | null> {
  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const signingInput = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", arrayBuffer(pemToDer(env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n"))),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, arrayBuffer(encoder.encode(signingInput)));
  const assertion = `${signingInput}.${b64url(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) return null;
  return (await response.json() as { access_token?: string }).access_token || null;
}

// One token per isolate lifetime is plenty and keeps us well inside Apple's generation limits.
let cachedApns: { token: string; expires: number } | null = null;

/* ------------------------------------------------------------------ sending */

export interface PushMessage { title: string; body: string; conversationId?: string; channel?: string }

interface TokenRow { token: string; platform: string }

async function sendApns(env: PushEnv, tokens: TokenRow[], message: PushMessage): Promise<{ sent: number; dead: string[]; error: string }> {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedApns || cachedApns.expires < now) {
    const token = await apnsProviderToken(env);
    if (!token) return { sent: 0, dead: [], error: "APNs credentials are not configured." };
    cachedApns = { token, expires: now + APNS_TOKEN_TTL_SECONDS };
  }
  const host = env.APNS_ENVIRONMENT === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const bundle = env.APNS_BUNDLE_ID || "";
  if (!bundle) return { sent: 0, dead: [], error: "APNS_BUNDLE_ID is not set." };

  let sent = 0; const dead: string[] = []; let error = "";
  for (const row of tokens) {
    const response = await fetch(`https://${host}/3/device/${row.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${cachedApns.token}`,
        "apns-topic": bundle,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify({
        aps: { alert: { title: message.title, body: message.body }, sound: "default", badge: 1 },
        conversationId: message.conversationId || "", channel: message.channel || "",
      }),
    }).catch(() => null);
    if (!response) { error ||= "Could not reach APNs."; continue; }
    if (response.ok) { sent++; continue; }
    const detail = await response.text().catch(() => "");
    // 410 means the app was uninstalled; 400 BadDeviceToken means it was never valid here.
    if (response.status === 410 || detail.includes("BadDeviceToken")) dead.push(row.token);
    else error ||= `APNs ${response.status}: ${detail.slice(0, 120)}`;
  }
  return { sent, dead, error };
}

async function sendFcm(env: PushEnv, tokens: TokenRow[], message: PushMessage): Promise<{ sent: number; dead: string[]; error: string }> {
  if (!env.FCM_PROJECT_ID) return { sent: 0, dead: [], error: "FCM_PROJECT_ID is not set." };
  const access = await fcmAccessToken(env);
  if (!access) return { sent: 0, dead: [], error: "FCM credentials are not configured." };

  let sent = 0; const dead: string[] = []; let error = "";
  for (const row of tokens) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: row.token,
          notification: { title: message.title, body: message.body },
          data: { conversationId: message.conversationId || "", channel: message.channel || "" },
          android: { priority: "HIGH" },
        },
      }),
    }).catch(() => null);
    if (!response) { error ||= "Could not reach FCM."; continue; }
    if (response.ok) { sent++; continue; }
    const detail = await response.text().catch(() => "");
    if (response.status === 404 || detail.includes("UNREGISTERED")) dead.push(row.token);
    else error ||= `FCM ${response.status}: ${detail.slice(0, 120)}`;
  }
  return { sent, dead, error };
}

/**
 * Notifies a workspace's registered devices.
 *
 * Never throws and never blocks the caller's real work — an inbound customer message must be stored
 * and answered whether or not anyone's phone can be reached.
 */
export async function notifyWorkspace(env: PushEnv, workspaceId: string, message: PushMessage): Promise<void> {
  try {
    await ensurePushSchema(env.DB);
    const rows = await env.DB.prepare(`SELECT token, platform FROM push_tokens
      WHERE workspace_id = ? AND failed_at IS NULL LIMIT 200`)
      .bind(workspaceId).all<TokenRow>();
    const tokens = rows.results || [];
    if (!tokens.length) return;

    const ios = tokens.filter((t) => t.platform === "ios");
    const android = tokens.filter((t) => t.platform === "android");
    const results = await Promise.all([
      ios.length ? sendApns(env, ios, message) : Promise.resolve({ sent: 0, dead: [], error: "" }),
      android.length ? sendFcm(env, android, message) : Promise.resolve({ sent: 0, dead: [], error: "" }),
    ]);

    const sent = results.reduce((n, r) => n + r.sent, 0);
    const dead = results.flatMap((r) => r.dead);
    const error = results.map((r) => r.error).filter(Boolean).join(" · ");

    // Retiring a dead token rather than deleting it means an uninstall-then-reinstall is visible
    // rather than looking like a device that never existed.
    for (const token of dead) {
      await env.DB.prepare(`UPDATE push_tokens SET failed_at = CURRENT_TIMESTAMP, fail_reason = 'unregistered' WHERE token = ?`)
        .bind(token).run().catch(() => null);
    }
    await env.DB.prepare(`INSERT INTO push_log (workspace_id, platform, title, body, status, detail)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(workspaceId, `${ios.length}ios/${android.length}android`, message.title.slice(0, 120), message.body.slice(0, 200),
        sent > 0 ? "sent" : error ? "error" : "no-devices",
        (error || (dead.length ? `${dead.length} token(s) retired` : "")).slice(0, 300))
      .run().catch(() => null);
  } catch { /* push is a courtesy; it must never break the path that called it */ }
}

/* ------------------------------------------------------------------ HTTP */

async function registerToken(request: Request, env: PushEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { token?: string; platform?: string; label?: string };
  const token = (body.token || "").trim();
  const platform = body.platform === "ios" ? "ios" : body.platform === "android" ? "android" : "";
  if (!token || !platform) return json(request, { error: "token and platform (ios or android) are required." }, 400);
  await ensurePushSchema(env.DB);

  // A token belongs to whoever most recently registered it. Reinstalling on a shared device, or
  // signing in as someone else, must move the notifications rather than send them to both people.
  await env.DB.prepare(`INSERT INTO push_tokens (token, workspace_id, user_id, platform, device_label, failed_at, fail_reason)
    VALUES (?, ?, ?, ?, ?, NULL, '')
    ON CONFLICT(token) DO UPDATE SET workspace_id = excluded.workspace_id, user_id = excluded.user_id,
      platform = excluded.platform, device_label = excluded.device_label, failed_at = NULL, fail_reason = ''`)
    .bind(token, session.workspaceId, session.userId, platform, (body.label || "").slice(0, 60)).run();

  const extra = await env.DB.prepare(`SELECT token FROM push_tokens WHERE user_id = ?
    ORDER BY created_at DESC LIMIT -1 OFFSET ?`).bind(session.userId, MAX_TOKENS_PER_USER).all<{ token: string }>();
  for (const row of extra.results || []) {
    await env.DB.prepare(`DELETE FROM push_tokens WHERE token = ?`).bind(row.token).run().catch(() => null);
  }
  return json(request, { ok: true });
}

async function unregisterToken(request: Request, env: PushEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { token?: string };
  const token = (body.token || "").trim();
  if (!token) return json(request, { error: "Missing token." }, 400);
  await ensurePushSchema(env.DB);
  await env.DB.prepare(`DELETE FROM push_tokens WHERE token = ? AND workspace_id = ?`)
    .bind(token, session.workspaceId).run();
  return json(request, { ok: true });
}

/** Configuration state and recent attempts — so "push isn't working" is answerable from the UI. */
async function status(request: Request, env: PushEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensurePushSchema(env.DB);
  const [devices, log] = await Promise.all([
    env.DB.prepare(`SELECT platform, count(*) n, sum(CASE WHEN failed_at IS NULL THEN 1 ELSE 0 END) live
      FROM push_tokens WHERE workspace_id = ? GROUP BY platform`).bind(session.workspaceId).all<{ platform: string; n: number; live: number }>(),
    env.DB.prepare(`SELECT title, status, detail, created_at FROM push_log WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 20`).bind(session.workspaceId).all<{ title: string; status: string; detail: string; created_at: string }>(),
  ]);
  return json(request, {
    configured: { apns: Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID), fcm: Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) },
    environment: env.APNS_ENVIRONMENT || "sandbox",
    devices: devices.results || [],
    recent: log.results || [],
  });
}

async function sendTest(request: Request, env: PushEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await notifyWorkspace(env, session.workspaceId, {
    title: "Qpy Engage", body: "Test notification — push is working.",
  });
  const row = await env.DB.prepare(`SELECT status, detail FROM push_log WHERE workspace_id = ?
    ORDER BY created_at DESC LIMIT 1`).bind(session.workspaceId).first<{ status: string; detail: string }>();
  return json(request, { ok: true, status: row?.status || "no-devices", detail: row?.detail || "" });
}

export async function handlePushRequest(request: Request, env: PushEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/push")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/push/register" && request.method === "POST") return registerToken(request, env);
  if (url.pathname === "/api/push/unregister" && request.method === "POST") return unregisterToken(request, env);
  if (url.pathname === "/api/push/status" && request.method === "GET") return status(request, env);
  if (url.pathname === "/api/push/test" && request.method === "POST") return sendTest(request, env);
  return null;
}
