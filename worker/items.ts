import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface ItemsEnv extends AuthEnv {
  DB: D1Database;
}

function uid(): string {
  return crypto.randomUUID();
}

let itemsSchemaEnsured = false;

async function ensureItemsSchema(db: D1Database): Promise<void> {
  if (itemsSchemaEnsured) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'AED',
    image_url TEXT NOT NULL DEFAULT '',
    external_link TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_catalog_items_workspace ON catalog_items (workspace_id, created_at DESC)`).run();
  itemsSchemaEnsured = true;
}

type ItemRow = {
  id: string; workspace_id: string; name: string; title: string; description: string;
  price: number; currency: string; image_url: string; external_link: string;
  created_at: string; updated_at: string;
};

function itemToJson(row: ItemRow) {
  return {
    id: row.id, name: row.name, title: row.title, description: row.description,
    price: row.price, currency: row.currency, imageUrl: row.image_url, externalLink: row.external_link,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function listItems(request: Request, env: ItemsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureItemsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM catalog_items WHERE workspace_id = ? ORDER BY created_at DESC`)
    .bind(session.workspaceId).all<ItemRow>();
  return json(request, { items: (result.results || []).map(itemToJson) });
}

function sanitizeItemInput(body: Record<string, unknown>) {
  const name = String(body.name || "").trim().slice(0, 120);
  const title = String(body.title || "").trim().slice(0, 200);
  const description = String(body.description || "").trim().slice(0, 2000);
  const price = Math.max(0, Number(body.price) || 0);
  const currency = String(body.currency || "AED").trim().slice(0, 8).toUpperCase() || "AED";
  const imageUrl = String(body.imageUrl || "").trim().slice(0, 2000);
  const externalLink = String(body.externalLink || "").trim().slice(0, 2000);
  return { name, title, description, price, currency, imageUrl, externalLink };
}

async function createItem(request: Request, env: ItemsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureItemsSchema(env.DB);
  const body = await request.json() as Record<string, unknown>;
  const input = sanitizeItemInput(body);
  if (!input.name) return json(request, { error: "An item name is required." }, 400);
  const id = uid();
  await env.DB.prepare(`INSERT INTO catalog_items (id, workspace_id, name, title, description, price, currency, image_url, external_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, session.workspaceId, input.name, input.title, input.description, input.price, input.currency, input.imageUrl, input.externalLink).run();
  const row = await env.DB.prepare(`SELECT * FROM catalog_items WHERE id = ?`).bind(id).first<ItemRow>();
  return json(request, { item: row ? itemToJson(row) : null });
}

async function updateItem(request: Request, env: ItemsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureItemsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM catalog_items WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<ItemRow>();
  if (!existing) return json(request, { error: "Item not found." }, 404);
  const body = await request.json() as Record<string, unknown>;
  const input = sanitizeItemInput({ ...existing, name: existing.name, title: existing.title, description: existing.description, price: existing.price, currency: existing.currency, imageUrl: existing.image_url, externalLink: existing.external_link, ...body });
  if (!input.name) return json(request, { error: "An item name is required." }, 400);
  await env.DB.prepare(`UPDATE catalog_items SET name = ?, title = ?, description = ?, price = ?, currency = ?, image_url = ?, external_link = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(input.name, input.title, input.description, input.price, input.currency, input.imageUrl, input.externalLink, id).run();
  const row = await env.DB.prepare(`SELECT * FROM catalog_items WHERE id = ?`).bind(id).first<ItemRow>();
  return json(request, { item: row ? itemToJson(row) : null });
}

async function deleteItem(request: Request, env: ItemsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureItemsSchema(env.DB);
  await env.DB.prepare(`DELETE FROM catalog_items WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).run();
  return json(request, { deleted: true });
}

// Exposed for the flow engine (worker/flows.ts) to resolve item ids into full records —
// deliberately unauthenticated at this layer since the widget-facing flow runtime has no
// session, but callers only ever pass ids that were already chosen by the workspace's own
// authenticated flow builder.
export async function getItemsByIds(db: D1Database, workspaceId: string, ids: string[]): Promise<ReturnType<typeof itemToJson>[]> {
  if (!ids.length) return [];
  await ensureItemsSchema(db);
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT * FROM catalog_items WHERE workspace_id = ? AND id IN (${placeholders})`)
    .bind(workspaceId, ...ids).all<ItemRow>();
  const byId = new Map((result.results || []).map((r) => [r.id, itemToJson(r)]));
  return ids.map((id) => byId.get(id)).filter((x): x is ReturnType<typeof itemToJson> => Boolean(x));
}

// Exposed for the Automations engine (worker/automations.ts) so an AI reply/AI action step can
// let Claude know which catalog items exist and choose which ones to show via the show_items tool.
export async function listItemsForWorkspace(db: D1Database, workspaceId: string): Promise<ReturnType<typeof itemToJson>[]> {
  await ensureItemsSchema(db);
  const result = await db.prepare(`SELECT * FROM catalog_items WHERE workspace_id = ? ORDER BY created_at DESC`).bind(workspaceId).all<ItemRow>();
  return (result.results || []).map(itemToJson);
}

export async function handleItemsRequest(request: Request, env: ItemsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/items")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/items" && request.method === "GET") return listItems(request, env);
  if (url.pathname === "/api/items" && request.method === "POST") return createItem(request, env);
  const match = url.pathname.match(/^\/api\/items\/([^/]+)$/);
  if (match && request.method === "PATCH") return updateItem(request, env, match[1]);
  if (match && request.method === "DELETE") return deleteItem(request, env, match[1]);
  return json(request, { error: "Not found" }, 404);
}
