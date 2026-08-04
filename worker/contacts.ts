import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface ContactsEnv extends AuthEnv {
  DB: D1Database;
}

function uid(): string {
  return crypto.randomUUID();
}

let contactsSchemaEnsured = false;

async function ensureContactsSchema(db: D1Database): Promise<void> {
  if (contactsSchemaEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      consent INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS contacts_workspace_idx ON contacts (workspace_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audiences (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS audiences_workspace_idx ON audiences (workspace_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audience_members (
      audience_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      PRIMARY KEY (audience_id, contact_id)
    )`),
  ]);
}

const MAX_TAGS = 10;
const MAX_NAME_LENGTH = 120;

function sanitizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "").slice(0, 20);
}

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, MAX_TAGS);
}

type ContactRow = { id: string; name: string; phone: string; consent: number; tags: string; created_at: string; updated_at: string };

function contactToJson(row: ContactRow) {
  return { id: row.id, name: row.name, phone: row.phone, consent: row.consent === 1, tags: JSON.parse(row.tags) as string[], createdAt: row.created_at, updatedAt: row.updated_at };
}

async function listContacts(request: Request, env: ContactsEnv): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM contacts WHERE workspace_id = ? ORDER BY name`).bind(session.workspaceId).all<ContactRow>();
  return json(request, { contacts: (result.results || []).map(contactToJson) });
}

async function createContact(request: Request, env: ContactsEnv): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const body = await request.json() as { name?: string; phone?: string; consent?: boolean; tags?: unknown };
  const name = (body.name || "").trim().slice(0, MAX_NAME_LENGTH);
  const phone = sanitizePhone(body.phone || "");
  if (!name) return json(request, { error: "A contact name is required." }, 400);
  if (phone.length < 8) return json(request, { error: "Enter a valid phone number including country code." }, 400);
  const id = uid();
  await env.DB.prepare(`INSERT INTO contacts (id, workspace_id, name, phone, consent, tags) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, session.workspaceId, name, phone, body.consent ? 1 : 0, JSON.stringify(sanitizeTags(body.tags))).run();
  const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?`).bind(id).first<ContactRow>();
  return json(request, { contact: row ? contactToJson(row) : null });
}

async function updateContact(request: Request, env: ContactsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<ContactRow>();
  if (!existing) return json(request, { error: "Contact not found." }, 404);
  const body = await request.json() as { name?: string; phone?: string; consent?: boolean; tags?: unknown };
  const name = body.name !== undefined ? body.name.trim().slice(0, MAX_NAME_LENGTH) : existing.name;
  if (!name) return json(request, { error: "A contact name is required." }, 400);
  const phone = body.phone !== undefined ? sanitizePhone(body.phone) : existing.phone;
  if (phone.length < 8) return json(request, { error: "Enter a valid phone number including country code." }, 400);
  const consent = body.consent !== undefined ? (body.consent ? 1 : 0) : existing.consent;
  const tags = body.tags !== undefined ? JSON.stringify(sanitizeTags(body.tags)) : existing.tags;
  await env.DB.prepare(`UPDATE contacts SET name = ?, phone = ?, consent = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, phone, consent, tags, id).run();
  const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?`).bind(id).first<ContactRow>();
  return json(request, { contact: row ? contactToJson(row) : null });
}

async function deleteContact(request: Request, env: ContactsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM contacts WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId),
    env.DB.prepare(`DELETE FROM audience_members WHERE contact_id = ?`).bind(id),
  ]);
  return json(request, { deleted: true });
}

const MAX_IMPORT_ROWS = 5000;

async function importContacts(request: Request, env: ContactsEnv): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const body = await request.json() as { csvText?: string; audienceId?: string; consent?: boolean };
  const csvText = body.csvText || "";
  if (!csvText.trim()) return json(request, { error: "Paste or upload CSV content first." }, 400);
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return json(request, { error: "CSV needs a header row and at least one contact." }, 400);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  const phoneIdx = header.indexOf("phone");
  if (nameIdx === -1 || phoneIdx === -1) return json(request, { error: "CSV header must include 'name' and 'phone' columns." }, 400);
  if (body.audienceId) {
    const audience = await env.DB.prepare(`SELECT id FROM audiences WHERE id = ? AND workspace_id = ?`).bind(body.audienceId, session.workspaceId).first();
    if (!audience) return json(request, { error: "Audience not found." }, 404);
  }

  const rows = lines.slice(1, 1 + MAX_IMPORT_ROWS).map((line) => line.split(","));
  const statements = [];
  const ids: string[] = [];
  for (const cols of rows) {
    const name = (cols[nameIdx] || "").trim().slice(0, MAX_NAME_LENGTH);
    const phone = sanitizePhone(cols[phoneIdx] || "");
    if (!name || phone.length < 8) continue;
    const id = uid();
    ids.push(id);
    statements.push(env.DB.prepare(`INSERT INTO contacts (id, workspace_id, name, phone, consent, tags) VALUES (?, ?, ?, ?, ?, '[]')`)
      .bind(id, session.workspaceId, name, phone, body.consent ? 1 : 0));
  }
  if (!statements.length) return json(request, { error: "No valid rows found (need non-empty name + phone)." }, 400);
  await env.DB.batch(statements);
  if (body.audienceId) {
    await env.DB.batch(ids.map((contactId) => env.DB.prepare(`INSERT OR IGNORE INTO audience_members (audience_id, contact_id) VALUES (?, ?)`).bind(body.audienceId, contactId)));
  }
  return json(request, { imported: ids.length, skipped: rows.length - ids.length });
}

type AudienceRow = { id: string; name: string; created_at: string; updated_at: string };

async function listAudiences(request: Request, env: ContactsEnv): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM audiences WHERE workspace_id = ? ORDER BY name`).bind(session.workspaceId).all<AudienceRow>();
  const audiences = result.results || [];
  const ids = audiences.map((a) => a.id);
  const counts = new Map<string, { total: number; consented: number }>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const countResult = await env.DB.prepare(`SELECT am.audience_id as audienceId, COUNT(*) as total, SUM(CASE WHEN c.consent = 1 THEN 1 ELSE 0 END) as consented
      FROM audience_members am JOIN contacts c ON c.id = am.contact_id
      WHERE am.audience_id IN (${placeholders}) GROUP BY am.audience_id`).bind(...ids).all<{ audienceId: string; total: number; consented: number }>();
    for (const r of countResult.results || []) counts.set(r.audienceId, { total: r.total, consented: r.consented });
  }
  return json(request, {
    audiences: audiences.map((a) => ({
      id: a.id, name: a.name, createdAt: a.created_at,
      memberCount: counts.get(a.id)?.total || 0,
      consentedCount: counts.get(a.id)?.consented || 0,
    })),
  });
}

async function createAudience(request: Request, env: ContactsEnv): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const body = await request.json() as { name?: string };
  const name = (body.name || "").trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return json(request, { error: "An audience name is required." }, 400);
  const id = uid();
  await env.DB.prepare(`INSERT INTO audiences (id, workspace_id, name) VALUES (?, ?, ?)`).bind(id, session.workspaceId, name).run();
  return json(request, { audience: { id, name, createdAt: new Date().toISOString(), memberCount: 0, consentedCount: 0 } });
}

async function renameAudience(request: Request, env: ContactsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT id FROM audiences WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first();
  if (!existing) return json(request, { error: "Audience not found." }, 404);
  const body = await request.json() as { name?: string };
  const name = (body.name || "").trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return json(request, { error: "An audience name is required." }, 400);
  await env.DB.prepare(`UPDATE audiences SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(name, id).run();
  return json(request, { saved: true });
}

async function deleteAudience(request: Request, env: ContactsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM audiences WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId),
    env.DB.prepare(`DELETE FROM audience_members WHERE audience_id = ?`).bind(id),
  ]);
  return json(request, { deleted: true });
}

async function listAudienceContacts(request: Request, env: ContactsEnv, audienceId: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const audience = await env.DB.prepare(`SELECT id FROM audiences WHERE id = ? AND workspace_id = ?`).bind(audienceId, session.workspaceId).first();
  if (!audience) return json(request, { error: "Audience not found." }, 404);
  const result = await env.DB.prepare(`SELECT c.* FROM contacts c JOIN audience_members am ON am.contact_id = c.id WHERE am.audience_id = ? ORDER BY c.name`)
    .bind(audienceId).all<ContactRow>();
  return json(request, { contacts: (result.results || []).map(contactToJson) });
}

async function addAudienceContacts(request: Request, env: ContactsEnv, audienceId: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const audience = await env.DB.prepare(`SELECT id FROM audiences WHERE id = ? AND workspace_id = ?`).bind(audienceId, session.workspaceId).first();
  if (!audience) return json(request, { error: "Audience not found." }, 404);
  const body = await request.json() as { contactIds?: unknown };
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter((x): x is string => typeof x === "string") : [];
  if (!contactIds.length) return json(request, { error: "Select at least one contact to add." }, 400);
  await env.DB.batch(contactIds.map((contactId) => env.DB.prepare(`INSERT OR IGNORE INTO audience_members (audience_id, contact_id) VALUES (?, ?)`).bind(audienceId, contactId)));
  return json(request, { added: contactIds.length });
}

async function removeAudienceContact(request: Request, env: ContactsEnv, audienceId: string, contactId: string): Promise<Response> {
  const session = await requireSession(request, env); if (session instanceof Response) return session;
  await ensureContactsSchema(env.DB);
  const audience = await env.DB.prepare(`SELECT id FROM audiences WHERE id = ? AND workspace_id = ?`).bind(audienceId, session.workspaceId).first();
  if (!audience) return json(request, { error: "Audience not found." }, 404);
  await env.DB.prepare(`DELETE FROM audience_members WHERE audience_id = ? AND contact_id = ?`).bind(audienceId, contactId).run();
  return json(request, { removed: true });
}

export async function handleContactsRequest(request: Request, env: ContactsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/contacts") && !url.pathname.startsWith("/api/audiences")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/contacts" && request.method === "GET") return listContacts(request, env);
  if (url.pathname === "/api/contacts" && request.method === "POST") return createContact(request, env);
  if (url.pathname === "/api/contacts/import" && request.method === "POST") return importContacts(request, env);
  const contactMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch && request.method === "PATCH") return updateContact(request, env, contactMatch[1]);
  if (contactMatch && request.method === "DELETE") return deleteContact(request, env, contactMatch[1]);

  if (url.pathname === "/api/audiences" && request.method === "GET") return listAudiences(request, env);
  if (url.pathname === "/api/audiences" && request.method === "POST") return createAudience(request, env);
  const audienceMatch = url.pathname.match(/^\/api\/audiences\/([^/]+)$/);
  if (audienceMatch && request.method === "PATCH") return renameAudience(request, env, audienceMatch[1]);
  if (audienceMatch && request.method === "DELETE") return deleteAudience(request, env, audienceMatch[1]);
  const audienceContactsMatch = url.pathname.match(/^\/api\/audiences\/([^/]+)\/contacts$/);
  if (audienceContactsMatch && request.method === "GET") return listAudienceContacts(request, env, audienceContactsMatch[1]);
  if (audienceContactsMatch && request.method === "POST") return addAudienceContacts(request, env, audienceContactsMatch[1]);
  const audienceContactMatch = url.pathname.match(/^\/api\/audiences\/([^/]+)\/contacts\/([^/]+)$/);
  if (audienceContactMatch && request.method === "DELETE") return removeAudienceContact(request, env, audienceContactMatch[1], audienceContactMatch[2]);

  return json(request, { error: "Not found" }, 404);
}
