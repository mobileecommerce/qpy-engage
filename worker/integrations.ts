import { json, corsPreflight, allowedOrigin, safeEqual } from "./shared";
import { requireSession, type AuthEnv } from "./auth";
import { encryptToken, decryptToken, hmacHex } from "./meta";

export interface IntegrationsEnv extends AuthEnv {
  DB: D1Database;
  META_TOKEN_ENCRYPTION_KEY?: string;
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  SALESFORCE_CLIENT_ID?: string;
  SALESFORCE_CLIENT_SECRET?: string;
  SALESFORCE_LOGIN_URL?: string;
}

export type Provider = "hubspot" | "salesforce";
const PROVIDERS: Provider[] = ["hubspot", "salesforce"];

// The OAuth state is signed rather than stored: it only has to prove "this callback belongs to the
// workspace that started the flow, recently". A table would need cleaning up; a signature doesn't.
const STATE_TTL_MS = 10 * 60 * 1000;

const HUBSPOT_SCOPES = "crm.objects.contacts.read crm.objects.contacts.write";
const SALESFORCE_SCOPES = "api refresh_token";
const SALESFORCE_API_VERSION = "v60.0";

let schemaReady = false;

async function ensureIntegrationsSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_integrations (
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      access_token_iv TEXT NOT NULL,
      refresh_token TEXT NOT NULL DEFAULT '',
      refresh_token_iv TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      instance_url TEXT NOT NULL DEFAULT '',
      account_label TEXT NOT NULL DEFAULT '',
      connected_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, provider)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_pushes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      remote_url TEXT NOT NULL DEFAULT '',
      pushed_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_crm_pushes_session ON crm_pushes (workspace_id, session_id, created_at DESC)`),
  ]);
  schemaReady = true;
}

interface IntegrationRow {
  provider: string; access_token: string; access_token_iv: string;
  refresh_token: string; refresh_token_iv: string; expires_at: string | null;
  instance_url: string; account_label: string; connected_by: string; updated_at: string;
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as string[]).includes(value);
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

async function signState(secret: string, workspaceId: string, provider: Provider): Promise<string> {
  const payload = base64Url(JSON.stringify({ w: workspaceId, p: provider, t: Date.now() }));
  return `${payload}.${await hmacHex(secret, payload)}`;
}

async function readState(secret: string, state: string): Promise<{ workspaceId: string; provider: Provider } | null> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  if (!(await safeEqual(signature, await hmacHex(secret, payload)))) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as { w?: string; p?: string; t?: number };
    if (!parsed.w || !parsed.p || !isProvider(parsed.p)) return null;
    if (!parsed.t || Date.now() - parsed.t > STATE_TTL_MS) return null;
    return { workspaceId: parsed.w, provider: parsed.p };
  } catch { return null; }
}

function credentials(env: IntegrationsEnv, provider: Provider): { id: string; secret: string } | null {
  const id = provider === "hubspot" ? env.HUBSPOT_CLIENT_ID : env.SALESFORCE_CLIENT_ID;
  const secret = provider === "hubspot" ? env.HUBSPOT_CLIENT_SECRET : env.SALESFORCE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/api/crm/oauth/callback`;
}

function salesforceLoginUrl(env: IntegrationsEnv): string {
  // Sandboxes live on test.salesforce.com; production on login.salesforce.com.
  return (env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com").replace(/\/+$/, "");
}

function tokenEndpoint(env: IntegrationsEnv, provider: Provider): string {
  return provider === "hubspot"
    ? "https://api.hubapi.com/oauth/v1/token"
    : `${salesforceLoginUrl(env)}/services/oauth2/token`;
}

interface TokenResponse {
  access_token?: string; refresh_token?: string; expires_in?: number;
  instance_url?: string; message?: string; error_description?: string; error?: string;
}

async function exchangeToken(env: IntegrationsEnv, provider: Provider, form: Record<string, string>): Promise<TokenResponse & { ok: boolean }> {
  const response = await fetch(tokenEndpoint(env, provider), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = await response.json().catch(() => ({})) as TokenResponse;
  return { ...data, ok: response.ok && Boolean(data.access_token) };
}

async function storeTokens(env: IntegrationsEnv, workspaceId: string, provider: Provider, tokens: TokenResponse, connectedBy: string, accountLabel: string): Promise<void> {
  const secret = env.META_TOKEN_ENCRYPTION_KEY!;
  const access = await encryptToken(tokens.access_token!, secret);
  const refresh = tokens.refresh_token ? await encryptToken(tokens.refresh_token, secret) : { ciphertext: "", iv: "" };
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  await env.DB.prepare(`INSERT INTO crm_integrations
      (workspace_id, provider, access_token, access_token_iv, refresh_token, refresh_token_iv, expires_at, instance_url, account_label, connected_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, provider) DO UPDATE SET
        access_token = excluded.access_token, access_token_iv = excluded.access_token_iv,
        refresh_token = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token ELSE crm_integrations.refresh_token END,
        refresh_token_iv = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token_iv ELSE crm_integrations.refresh_token_iv END,
        expires_at = excluded.expires_at, instance_url = excluded.instance_url,
        account_label = excluded.account_label, connected_by = excluded.connected_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(workspaceId, provider, access.ciphertext, access.iv, refresh.ciphertext, refresh.iv,
      expiresAt, tokens.instance_url || "", accountLabel, connectedBy).run();
}

// Returns a usable access token, refreshing first when the stored one is at or near expiry.
async function activeToken(env: IntegrationsEnv, workspaceId: string, provider: Provider): Promise<{ token: string; instanceUrl: string } | null> {
  const row = await env.DB.prepare(`SELECT * FROM crm_integrations WHERE workspace_id = ? AND provider = ?`)
    .bind(workspaceId, provider).first<IntegrationRow>();
  if (!row) return null;
  const secret = env.META_TOKEN_ENCRYPTION_KEY!;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : 0;
  const nearExpiry = expiresAt > 0 && expiresAt - Date.now() < 120_000;

  if (nearExpiry && row.refresh_token) {
    const creds = credentials(env, provider);
    if (creds) {
      const refreshToken = await decryptToken(row.refresh_token, row.refresh_token_iv, secret);
      const refreshed = await exchangeToken(env, provider, {
        grant_type: "refresh_token", client_id: creds.id, client_secret: creds.secret, refresh_token: refreshToken,
      });
      if (refreshed.ok) {
        await storeTokens(env, workspaceId, provider, { ...refreshed, instance_url: refreshed.instance_url || row.instance_url }, row.connected_by, row.account_label);
        return { token: refreshed.access_token!, instanceUrl: refreshed.instance_url || row.instance_url };
      }
    }
  }
  return { token: await decryptToken(row.access_token, row.access_token_iv, secret), instanceUrl: row.instance_url };
}

/* ------------------------------------------------------------------ endpoints */

async function listIntegrations(request: Request, env: IntegrationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureIntegrationsSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT provider, account_label, connected_by, updated_at, instance_url FROM crm_integrations WHERE workspace_id = ?`)
    .bind(session.workspaceId).all<IntegrationRow>();
  const connected = new Map((rows.results || []).map((r) => [r.provider, r]));
  return json(request, {
    integrations: PROVIDERS.map((provider) => {
      const row = connected.get(provider);
      return {
        provider,
        // "configured" is about the server having client credentials; "connected" is about this
        // workspace having authorised. The UI needs to tell those two apart to say anything useful.
        configured: Boolean(credentials(env, provider) && env.META_TOKEN_ENCRYPTION_KEY),
        connected: Boolean(row),
        accountLabel: row?.account_label || "",
        connectedBy: row?.connected_by || "",
        connectedAt: row?.updated_at || null,
      };
    }),
  });
}

async function startOauth(request: Request, env: IntegrationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const provider = (new URL(request.url).searchParams.get("provider") || "").trim();
  if (!isProvider(provider)) return json(request, { error: "Unknown CRM provider." }, 400);
  if (!env.META_TOKEN_ENCRYPTION_KEY) return json(request, { error: "Token encryption is not configured on the server." }, 503);
  const creds = credentials(env, provider);
  if (!creds) return json(request, { error: `${provider === "hubspot" ? "HubSpot" : "Salesforce"} client credentials are not configured on the server.` }, 503);
  await ensureIntegrationsSchema(env.DB);

  const state = await signState(env.META_TOKEN_ENCRYPTION_KEY, session.workspaceId, provider);
  const params = new URLSearchParams({
    client_id: creds.id,
    redirect_uri: redirectUri(request),
    scope: provider === "hubspot" ? HUBSPOT_SCOPES : SALESFORCE_SCOPES,
    state,
  });
  if (provider === "salesforce") params.set("response_type", "code");
  const authorizeUrl = provider === "hubspot"
    ? `https://app.hubspot.com/oauth/authorize?${params.toString()}`
    : `${salesforceLoginUrl(env)}/services/oauth2/authorize?${params.toString()}`;
  return json(request, { authorizeUrl });
}

function closingPage(message: string, ok: boolean): Response {
  // The OAuth window is opened by the dashboard, so it reports back to its opener and closes.
  const body = `<!doctype html><meta charset="utf-8"><title>${ok ? "Connected" : "Connection failed"}</title>
<style>body{font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#20232b}
div{text-align:center;max-width:340px;padding:20px}b{display:block;font-size:17px;margin-bottom:6px;color:${ok ? "#2f7d54" : "#c0503f"}}</style>
<div><b>${ok ? "Connected" : "Connection failed"}</b><p>${message}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:"qpy-crm-oauth",ok:${ok}},"*")}catch(e){}setTimeout(function(){window.close()},${ok ? 1200 : 4000});</script>`;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// No session cookie is required here — the signed state is the proof of who started the flow.
async function oauthCallback(request: Request, env: IntegrationsEnv): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (error) return closingPage(`The CRM returned: ${error}`, false);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) return closingPage("The CRM did not send an authorization code.", false);
  if (!env.META_TOKEN_ENCRYPTION_KEY) return closingPage("Token encryption is not configured on the server.", false);

  const verified = await readState(env.META_TOKEN_ENCRYPTION_KEY, state);
  if (!verified) return closingPage("This authorization link is invalid or has expired. Start the connection again.", false);
  const creds = credentials(env, verified.provider);
  if (!creds) return closingPage("Client credentials are not configured on the server.", false);
  await ensureIntegrationsSchema(env.DB);

  const tokens = await exchangeToken(env, verified.provider, {
    grant_type: "authorization_code", client_id: creds.id, client_secret: creds.secret,
    redirect_uri: redirectUri(request), code,
  });
  if (!tokens.ok) return closingPage(tokens.error_description || tokens.message || "The CRM rejected the authorization code.", false);

  const accountLabel = await describeAccount(env, verified.provider, tokens).catch(() => "");
  await storeTokens(env, verified.workspaceId, verified.provider, tokens, "", accountLabel);
  return closingPage(`${verified.provider === "hubspot" ? "HubSpot" : "Salesforce"} is connected. You can close this window.`, true);
}

// A human-readable name for the connected account, so the dashboard can show which portal or org
// the workspace is actually wired to rather than just "connected".
async function describeAccount(env: IntegrationsEnv, provider: Provider, tokens: TokenResponse): Promise<string> {
  if (provider === "hubspot") {
    const response = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${tokens.access_token}`);
    if (!response.ok) return "";
    const info = await response.json() as { hub_domain?: string; hub_id?: number };
    return info.hub_domain || (info.hub_id ? `Portal ${info.hub_id}` : "");
  }
  const instance = tokens.instance_url;
  if (!instance) return "";
  const response = await fetch(`${instance}/services/oauth2/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!response.ok) return new URL(instance).host;
  const info = await response.json() as { organization_id?: string; preferred_username?: string };
  return info.preferred_username || new URL(instance).host;
}

async function disconnect(request: Request, env: IntegrationsEnv, provider: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!isProvider(provider)) return json(request, { error: "Unknown CRM provider." }, 400);
  await ensureIntegrationsSchema(env.DB);
  await env.DB.prepare(`DELETE FROM crm_integrations WHERE workspace_id = ? AND provider = ?`)
    .bind(session.workspaceId, provider).run();
  return json(request, { ok: true });
}

/* ------------------------------------------------------------------ contact push */

interface PushableContact {
  name: string; email: string; phone: string; company: string;
  labels: string[]; score: number | null; scoreReasons: string[];
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function ratingFor(score: number | null): string {
  if (score === null) return "";
  return score >= 70 ? "Hot" : score >= 40 ? "Warm" : "Cold";
}

function summaryText(contact: PushableContact): string {
  const lines = ["Captured by Qpy Engage from a chat conversation."];
  if (contact.score !== null) lines.push(`Lead score: ${contact.score} (${ratingFor(contact.score)}).`);
  if (contact.scoreReasons.length) lines.push(`Why: ${contact.scoreReasons.join("; ")}.`);
  if (contact.labels.length) lines.push(`Labels: ${contact.labels.join(", ")}.`);
  return lines.join("\n");
}

async function pushToHubspot(token: string, contact: PushableContact): Promise<{ id: string; url: string }> {
  const { first, last } = splitName(contact.name);
  const properties: Record<string, string> = {};
  if (contact.email) properties.email = contact.email;
  if (first) properties.firstname = first;
  if (last) properties.lastname = last;
  if (contact.phone) properties.phone = contact.phone;
  if (contact.company) properties.company = contact.company;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // HubSpot keys contacts on email. Without one there is nothing to match against, so a push would
  // silently create a duplicate on every click — better to refuse and say why.
  if (!contact.email) throw new Error("HubSpot needs an email address to identify the contact. Add one first.");

  const search = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST", headers,
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: contact.email }] }], properties: ["email"], limit: 1 }),
  });
  if (!search.ok) throw new Error(await hubspotError(search));
  const found = await search.json() as { results?: Array<{ id: string }> };
  const existingId = found.results?.[0]?.id;

  const write = await fetch(
    existingId ? `https://api.hubapi.com/crm/v3/objects/contacts/${existingId}` : "https://api.hubapi.com/crm/v3/objects/contacts",
    { method: existingId ? "PATCH" : "POST", headers, body: JSON.stringify({ properties }) },
  );
  if (!write.ok) throw new Error(await hubspotError(write));
  const saved = await write.json() as { id: string };

  // The score and labels have no standard contact property, so they go on a timeline note where a
  // salesperson will actually read them.
  await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST", headers,
    body: JSON.stringify({
      properties: { hs_note_body: summaryText(contact).replace(/\n/g, "<br>"), hs_timestamp: new Date().toISOString() },
      associations: [{ to: { id: saved.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
    }),
  }).catch(() => {});

  return { id: saved.id, url: `https://app.hubspot.com/contacts/objects/0-1/${saved.id}` };
}

async function hubspotError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { message?: string };
  return body.message || `HubSpot returned ${response.status}.`;
}

async function pushToSalesforce(token: string, instanceUrl: string, contact: PushableContact): Promise<{ id: string; url: string }> {
  const { first, last } = splitName(contact.name);
  // Salesforce rejects a Lead without LastName and Company. Rather than inventing a name, refuse.
  if (!last) throw new Error("Salesforce needs a contact name to create a lead. Add one first.");
  const fields: Record<string, string> = {
    LastName: last,
    Company: contact.company || "(Unknown — from chat)",
    LeadSource: "Chat",
    Description: summaryText(contact),
  };
  if (first) fields.FirstName = first;
  if (contact.email) fields.Email = contact.email;
  if (contact.phone) fields.Phone = contact.phone;
  const rating = ratingFor(contact.score);
  if (rating) fields.Rating = rating;

  const response = await fetch(`${instanceUrl}/services/data/${SALESFORCE_API_VERSION}/sobjects/Lead`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => []) as Array<{ message?: string }>;
    throw new Error(body?.[0]?.message || `Salesforce returned ${response.status}.`);
  }
  const saved = await response.json() as { id: string };
  return { id: saved.id, url: `${instanceUrl}/lightning/r/Lead/${saved.id}/view` };
}

async function pushContact(request: Request, env: IntegrationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sessionId?: string; provider?: string };
  const sessionId = (body.sessionId || "").trim();
  const provider = (body.provider || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  if (!isProvider(provider)) return json(request, { error: "Unknown CRM provider." }, 400);
  if (!env.META_TOKEN_ENCRYPTION_KEY) return json(request, { error: "Token encryption is not configured on the server." }, 503);
  await ensureIntegrationsSchema(env.DB);

  const row = await env.DB.prepare(`SELECT name, email, phone, company, labels, score, score_reasons
    FROM crm_contacts WHERE workspace_id = ? AND session_id = ?`)
    .bind(session.workspaceId, sessionId)
    .first<{ name: string; email: string; phone: string; company: string; labels: string; score: number | null; score_reasons: string }>();
  if (!row) return json(request, { error: "There is no contact record for this conversation yet." }, 400);

  const contact: PushableContact = {
    name: row.name || "", email: row.email || "", phone: row.phone || "", company: row.company || "",
    labels: safeParseArray(row.labels), score: typeof row.score === "number" ? row.score : null,
    scoreReasons: safeParseArray(row.score_reasons),
  };

  const auth = await activeToken(env, session.workspaceId, provider);
  if (!auth) return json(request, { error: `${provider === "hubspot" ? "HubSpot" : "Salesforce"} is not connected for this workspace.` }, 400);

  try {
    const saved = provider === "hubspot"
      ? await pushToHubspot(auth.token, contact)
      : await pushToSalesforce(auth.token, auth.instanceUrl, contact);
    await env.DB.prepare(`INSERT INTO crm_pushes (workspace_id, session_id, provider, remote_id, remote_url, pushed_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(session.workspaceId, sessionId, provider, saved.id, saved.url, session.name || session.email).run();
    return json(request, { ok: true, push: { provider, remoteId: saved.id, remoteUrl: saved.url } });
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "Could not send this contact to the CRM." }, 502);
  }
}

function safeParseArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

async function listPushes(request: Request, env: IntegrationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const sessionId = (new URL(request.url).searchParams.get("sessionId") || "").trim();
  if (!sessionId) return json(request, { error: "Missing sessionId." }, 400);
  await ensureIntegrationsSchema(env.DB);
  const rows = await env.DB.prepare(`SELECT provider, remote_id, remote_url, pushed_by, created_at
    FROM crm_pushes WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 10`)
    .bind(session.workspaceId, sessionId).all<{ provider: string; remote_id: string; remote_url: string; pushed_by: string; created_at: string }>();
  return json(request, {
    pushes: (rows.results || []).map((r) => ({
      provider: r.provider, remoteId: r.remote_id, remoteUrl: r.remote_url, pushedBy: r.pushed_by, createdAt: r.created_at,
    })),
  });
}

export async function handleIntegrationsRequest(request: Request, env: IntegrationsEnv): Promise<Response | null> {
  const url = new URL(request.url);

  // The callback is a top-level browser navigation from the CRM, so it must be handled before the
  // origin allow-list below — it carries no Origin header this worker would recognise.
  if (url.pathname === "/api/crm/oauth/callback" && request.method === "GET") {
    if (!env.DB) return closingPage("Workspace database is unavailable.", false);
    return oauthCallback(request, env);
  }

  if (!url.pathname.startsWith("/api/crm/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/crm/integrations" && request.method === "GET") return listIntegrations(request, env);
  if (url.pathname === "/api/crm/oauth/start" && request.method === "GET") return startOauth(request, env);
  if (url.pathname === "/api/crm/push" && request.method === "POST") return pushContact(request, env);
  if (url.pathname === "/api/crm/pushes" && request.method === "GET") return listPushes(request, env);
  const disconnectMatch = url.pathname.match(/^\/api\/crm\/integrations\/([a-z]+)$/);
  if (disconnectMatch && request.method === "DELETE") return disconnect(request, env, disconnectMatch[1]);
  return null;
}
