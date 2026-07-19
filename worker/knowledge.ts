import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface KnowledgeEnv extends AuthEnv {
  DB: D1Database;
}

const MAX_CONTENT_LENGTH = 20000;
const FETCH_TIMEOUT_MS = 10000;

async function ensureKnowledgeSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_content (
    workspace_id TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    url TEXT,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, source_id)
  )`).run();
}

async function fetchWebsiteText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; QpyEngageBot/1.0; +https://mobileecommerce.github.io/qpy-engage/)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`Could not fetch that URL (HTTP ${response.status}).`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html")) throw new Error("That URL did not return an HTML page.");

  const bodyChunks: string[] = [];
  const metaParts: string[] = [];
  let skipDepth = 0;
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, head", {
      element(element) {
        skipDepth++;
        element.onEndTag(() => { skipDepth = Math.max(0, skipDepth - 1); });
      },
    })
    .on("*", {
      text(chunk) {
        if (skipDepth === 0 && chunk.text) bodyChunks.push(chunk.text);
      },
    })
    .on("title", {
      text(chunk) { if (chunk.text) metaParts.push(chunk.text); },
    })
    .on('meta[name="description"], meta[property="og:description"], meta[name="og:description"]', {
      element(element) {
        const content = element.getAttribute("content");
        if (content) metaParts.push(content);
      },
    });

  const transformed = rewriter.transform(response);
  const reader = transformed.body?.getReader();
  if (reader) { while (true) { const { done } = await reader.read(); if (done) break; } }

  const bodyText = bodyChunks.join(" ").replace(/\s+/g, " ").trim();
  const metaText = metaParts.join(" — ").replace(/\s+/g, " ").trim();

  // Client-rendered pages often have little or no text in the raw HTML body;
  // fall back to title/meta description so there's at least something real to ground on.
  const text = bodyText.length > metaText.length ? bodyText : [metaText, bodyText].filter(Boolean).join(" — ");
  return text.slice(0, MAX_CONTENT_LENGTH);
}

async function fetchWebsite(request: Request, env: KnowledgeEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { url?: string; sourceId?: number };
  const url = (body.url || "").trim();
  const sourceId = Number(body.sourceId);
  if (!url || !/^https?:\/\//i.test(url)) return json(request, { error: "Enter a valid http(s) URL." }, 400);
  if (!Number.isFinite(sourceId)) return json(request, { error: "Missing source id." }, 400);

  await ensureKnowledgeSchema(env.DB);
  let content: string;
  try {
    content = await fetchWebsiteText(url);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "Could not fetch that website." }, 400);
  }
  if (!content) return json(request, { error: "No readable text found on that page." }, 400);

  await env.DB.prepare(`INSERT INTO knowledge_content (workspace_id, source_id, url, content, char_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, source_id) DO UPDATE SET url=excluded.url, content=excluded.content, char_count=excluded.char_count, fetched_at=CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, sourceId, url, content, content.length).run();

  return json(request, { fetched: true, charCount: content.length, excerpt: content.slice(0, 300) });
}

async function saveContent(request: Request, env: KnowledgeEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sourceId?: number; content?: string };
  const sourceId = Number(body.sourceId);
  const content = (body.content || "").trim().slice(0, MAX_CONTENT_LENGTH);
  if (!Number.isFinite(sourceId)) return json(request, { error: "Missing source id." }, 400);
  if (!content) return json(request, { error: "Paste some content before saving." }, 400);

  await ensureKnowledgeSchema(env.DB);
  await env.DB.prepare(`INSERT INTO knowledge_content (workspace_id, source_id, url, content, char_count) VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(workspace_id, source_id) DO UPDATE SET content=excluded.content, char_count=excluded.char_count, fetched_at=CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, sourceId, content, content.length).run();

  return json(request, { saved: true, charCount: content.length });
}

async function getContent(request: Request, env: KnowledgeEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureKnowledgeSchema(env.DB);
  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (!ids.length) return json(request, { content: {} });
  const content = await getStoredKnowledgeContent(env.DB, session.workspaceId, ids);
  return json(request, { content });
}

export async function getStoredKnowledgeContent(db: D1Database, workspaceId: string, sourceIds: number[]): Promise<Record<number, string>> {
  if (!sourceIds.length) return {};
  await ensureKnowledgeSchema(db);
  const placeholders = sourceIds.map(() => "?").join(",");
  const result = await db.prepare(`SELECT source_id as sourceId, content FROM knowledge_content WHERE workspace_id = ? AND source_id IN (${placeholders})`)
    .bind(workspaceId, ...sourceIds).all<{ sourceId: number; content: string }>();
  const content: Record<number, string> = {};
  for (const row of result.results || []) content[row.sourceId] = row.content;
  return content;
}

export async function handleKnowledgeRequest(request: Request, env: KnowledgeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/knowledge/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/knowledge/fetch-website" && request.method === "POST") return fetchWebsite(request, env);
  if (url.pathname === "/api/knowledge/save-content" && request.method === "POST") return saveContent(request, env);
  if (url.pathname === "/api/knowledge/content" && request.method === "GET") return getContent(request, env);
  return json(request, { error: "Not found" }, 404);
}
