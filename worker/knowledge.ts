import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface KnowledgeEnv extends AuthEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
}

const MAX_CONTENT_LENGTH = 20000;
const FETCH_TIMEOUT_MS = 10000;
const RENDER_TIMEOUT_MS = 20000;
// A page whose raw HTML yields less than this much body text is treated as "nothing real here".
// It has to clear the site's own chrome: a page consisting only of a nav bar and footer can still
// produce a few hundred characters, and the old 300 threshold read that as success — which is
// exactly how a restaurant page with all its detail in JavaScript passed as fetched-and-fine.
const MIN_RAW_BODY_LENGTH = 800;
const MAX_PAGES = 25;
const FETCH_CONCURRENCY = 4;
const MAX_PAGE_CHARS = 6000;
// Rendering a page through the browser API costs seconds, not milliseconds, and Cloudflare rate
// limits it hard — a burst of 8 got 7 rejections. Only this many pages get the expensive treatment
// per sync, spaced apart; the rest keep whatever their raw HTML gave and are picked up next sync.
const MAX_RENDER_CALLS = 3;
// Cloudflare throttles Browser Rendering hard on the free tier — 1.5s between calls still drew
// "Rate limit exceeded" on 3 of 4. Spacing them this far apart trades sync speed for actually
// getting the pages.
const RENDER_GAP_MS = 12000;
// A page can clear the "has some text" bar on its description alone while the detail that answers
// questions — opening hours, capacity, prices — is still only in JavaScript. The Al Madam page is
// exactly that: 1,149 characters of blurb, no times. Rendering therefore reaches further up than
// the empty-page threshold does.
const RENDER_IF_UNDER = 2500;

async function ensureKnowledgeSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_content (
      workspace_id TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      url TEXT,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, source_id)
    )`),
    // One row per crawled page. Storing pages separately (rather than one blob per source) is what
    // lets a question about breakfast pull the restaurant page instead of the first 12k characters
    // of whatever happened to be fetched first.
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_pages (
      workspace_id TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, source_id, url)
    )`),
  ]);
}

async function extractTextFromHtml(html: string): Promise<{ bodyText: string; metaText: string }> {
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

  const transformed = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  const reader = transformed.body?.getReader();
  if (reader) { while (true) { const { done } = await reader.read(); if (done) break; } }

  return {
    bodyText: bodyChunks.join(" ").replace(/\s+/g, " ").trim(),
    metaText: metaParts.join(" — ").replace(/\s+/g, " ").trim(),
  };
}

// Rendering used to fail completely silently, which made a misconfigured token indistinguishable
// from a site that genuinely has no content — the sync just reported few pages and no reason. The
// first failure's actual message is kept and surfaced to the dashboard.
export type RenderBudget = { renders: number; attempted: number; succeeded: number; lastError?: string };

async function fetchRenderedHtml(url: string, accountId: string, apiToken: string, budget?: RenderBudget): Promise<string | null> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (budget && !budget.lastError) {
        const detail = (await response.text()).slice(0, 300);
        budget.lastError = `HTTP ${response.status}: ${detail}`;
      }
      return null;
    }
    const payload = await response.json() as { success?: boolean; result?: string; errors?: Array<{ message?: string }> };
    if (!payload.success || !payload.result) {
      if (budget && !budget.lastError) budget.lastError = payload.errors?.[0]?.message || "Browser Rendering returned no content.";
      return null;
    }
    if (budget) budget.succeeded++;
    return payload.result;
  } catch (error) {
    if (budget && !budget.lastError) budget.lastError = error instanceof Error ? error.message : "Browser Rendering request failed.";
    return null;
  }
}

// ── Crawling the whole site, not just the one URL that was typed in ──
//
// A business adds "our website" and reasonably expects the assistant to know what is on it. Fetching
// only the exact URL meant a homepage of navigation links was all the AI ever saw, so any question
// about a specific restaurant, room or offer got an honest "I don't have that" — the content existed
// one click away and was never read.

function sameOrigin(candidate: string, origin: string): boolean {
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "") || u.toString();
  } catch { return ""; }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; QpyEngageBot/1.0; +https://mobileecommerce.github.io/qpy-engage/)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch { return null; }
}

// Sitemaps are the reliable map of a site. WordPress splits them across an index plus per-type
// children, so nested indexes are followed one level down before giving up and scraping links.
async function discoverUrls(entryUrl: string): Promise<string[]> {
  const origin = new URL(entryUrl).origin;
  const found = new Set<string>();
  const locs = (xml: string) => (xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/g) || [])
    .map((m) => m.replace(/<\/?loc>/g, "").trim());

  for (const path of ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"]) {
    const xml = await fetchText(origin + path);
    if (!xml || !xml.includes("<loc>")) continue;
    const top = locs(xml);
    const childSitemaps = top.filter((u) => /\.xml($|\?)/i.test(u) && sameOrigin(u, origin)).slice(0, 8);

    const groups: string[][] = [];
    for (const child of childSitemaps) {
      const childXml = await fetchText(child);
      if (childXml) groups.push(locs(childXml).filter((u) => sameOrigin(u, origin)).map(normaliseUrl).filter(Boolean));
    }
    const direct = top.filter((u) => !/\.xml($|\?)/i.test(u) && sameOrigin(u, origin)).map(normaliseUrl).filter(Boolean);
    if (direct.length) groups.unshift(direct);

    // Take one URL from each child sitemap in turn rather than draining them in order. Sites group
    // their sitemaps by content type, and the biggest group (usually promotional posts) would
    // otherwise consume the entire page budget before a single restaurant or room page is reached.
    for (let i = 0; found.size < MAX_PAGES * 3; i++) {
      let added = false;
      for (const group of groups) if (group[i]) { found.add(group[i]); added = true; }
      if (!added) break;
    }
    if (found.size) break;
  }

  // No usable sitemap — fall back to same-origin links on the entry page.
  if (!found.size) {
    const html = await fetchText(entryUrl);
    if (html) {
      for (const m of html.match(/href="([^"]+)"/g) || []) {
        const href = m.slice(6, -1);
        if (href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
        try {
          const abs = new URL(href, entryUrl).toString();
          if (sameOrigin(abs, origin) && !/\.(css|js|png|jpe?g|gif|svg|webp|pdf|zip|ico)($|\?)/i.test(abs)) {
            found.add(normaliseUrl(abs));
          }
        } catch { /* skip unparseable href */ }
      }
    }
  }

  found.delete("");
  const entry = normaliseUrl(entryUrl);
  const depth = (u: string) => { try { return new URL(u).pathname.split("/").filter(Boolean).length; } catch { return 0; } };
  // A Worker invocation may only make so many subrequests (50 on the free plan, and D1 writes count
  // toward it), so the page budget is genuinely scarce — spend it on pages that hold answers. A
  // section listing like /al_badayer_dining is mostly links; the detail page beneath it,
  // /al_badayer_dining/al-madam-restaurant, is where the opening hours actually live.
  const rest = [...found].filter((u) => u !== entry).sort((a, b) => Math.min(depth(b), 2) - Math.min(depth(a), 2));
  return [entry, ...rest].slice(0, MAX_PAGES);
}

type CrawledPage = { url: string; title: string; text: string };

// `alreadyRich` holds URLs whose stored content is already substantial. On a site where most pages
// render client-side, one pass can only afford to render a handful, so those are skipped next time
// and the budget goes to pages still known to be thin — running Sync again keeps filling the site
// in instead of re-rendering the same first few pages forever.
async function crawlPages(urls: string[], env: KnowledgeEnv, alreadyRich: Set<string>): Promise<{ pages: CrawledPage[]; budget: RenderBudget }> {
  const pages: CrawledPage[] = [];
  const budget: RenderBudget = { renders: MAX_RENDER_CALLS, attempted: 0, succeeded: 0 };

  // Phase 1 — plain HTML for every page, in parallel. Cheap and safe to hammer.
  for (let i = 0; i < urls.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(urls.slice(i, i + FETCH_CONCURRENCY).map(async (url) => {
      try {
        const text = await fetchWebsiteText(url, env);
        return { url, title: "", text: text || "" };
      } catch { return null; }
    }));
    for (const page of batch) if (page) pages.push(page);
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_BROWSER_RENDERING_TOKEN) {
    return { pages: pages.filter((p) => p.text), budget };
  }

  // Phase 2 — the pages that came back with nothing real get the browser, ONE AT A TIME. Running
  // these inside the parallel batches above meant Cloudflare saw a burst and rejected 7 of 8 with
  // "Rate limit exceeded", so a correctly configured token still looked like it did nothing.
  // Pages already holding good content from an earlier sync are skipped so repeat runs advance.
  const thin = pages
    .filter((p) => p.text.length < MIN_RAW_BODY_LENGTH && !alreadyRich.has(p.url))
    .sort((a, b) => a.text.length - b.text.length);

  for (const page of thin) {
    if (budget.renders <= 0) break;
    budget.renders--;
    budget.attempted++;
    const html = await fetchRenderedHtml(page.url, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_BROWSER_RENDERING_TOKEN, budget);
    if (html) {
      const rendered = await extractTextFromHtml(html);
      if (rendered.bodyText.length > page.text.length) page.text = rendered.bodyText.slice(0, MAX_CONTENT_LENGTH);
    }
    // Spacing the calls keeps a burst from tripping the same per-minute limit again.
    if (budget.renders > 0) await new Promise((resolve) => setTimeout(resolve, RENDER_GAP_MS));
  }

  return { pages: pages.filter((p) => p.text), budget };
}

// Every page on a site repeats its nav and footer. Left in, that boilerplate is most of what gets
// stored — the Sharjah Collection homepage was 4,891 characters of mostly repeated menu items — and
// it crowds real answers out of the prompt budget. Anything appearing on more than half the pages
// is chrome, not content, so it is dropped once several pages exist to compare.
function stripSharedBoilerplate(pages: CrawledPage[]): CrawledPage[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  const segmentsOf = (text: string) => text.split(/(?<=[.!?])\s+|\s{2,}|\n+/).map((s) => s.trim()).filter((s) => s.length > 12);

  for (const page of pages) {
    for (const seg of new Set(segmentsOf(page.text))) counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  return pages.map((page) => {
    const kept = segmentsOf(page.text).filter((seg) => (counts.get(seg) || 0) < threshold);
    const text = kept.join(" ").replace(/\s+/g, " ").trim();
    // If stripping removed essentially everything, the page really was only chrome — keep it empty
    // rather than restoring noise.
    return { ...page, text: text.slice(0, MAX_PAGE_CHARS) };
  }).filter((page) => page.text.length > 40);
}

async function fetchWebsiteText(url: string, env: KnowledgeEnv): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; QpyEngageBot/1.0; +https://mobileecommerce.github.io/qpy-engage/)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`Could not fetch that URL (HTTP ${response.status}).`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html")) throw new Error("That URL did not return an HTML page.");

  const { bodyText, metaText } = await extractTextFromHtml(await response.text());

  // Client-rendered pages (SPAs) often have little or no text in the raw HTML body — the real
  // content only exists after JavaScript runs. If Browser Rendering is configured, retry against
  // the JS-executed page instead of settling for just the title/meta description.
  // Fall back to title/meta description so there's at least something real to ground on.
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

  let urls: string[];
  try { urls = await discoverUrls(url); }
  catch { urls = [normaliseUrl(url) || url]; }

  const priorRows = await env.DB.prepare(`SELECT url, char_count FROM knowledge_pages WHERE workspace_id = ? AND source_id = ?`)
    .bind(session.workspaceId, sourceId).all<{ url: string; char_count: number }>();
  const prior = new Map((priorRows.results || []).map((r) => [r.url, r.char_count]));
  const alreadyRich = new Set([...prior.entries()].filter(([, n]) => n >= MIN_RAW_BODY_LENGTH).map(([u]) => u));

  const { pages: crawled, budget } = await crawlPages(urls, env, alreadyRich);
  if (!crawled.length) return json(request, { error: "Could not read any pages on that site." }, 400);
  let pages = stripSharedBoilerplate(crawled);
  if (!pages.length) return json(request, { error: "No readable text found — this site's content may load via JavaScript." }, 400);

  // A later pass that could not afford to render a page must not overwrite richer content captured
  // by an earlier one — otherwise repeated syncs would undo their own progress.
  pages = pages.filter((page) => page.text.length >= (prior.get(page.url) || 0) || !prior.has(page.url));

  // Drop anything no longer reachable on the site, so a deleted page stops being quoted — but keep
  // pages that simply weren't re-read this pass.
  const liveUrls = new Set(crawled.map((p) => p.url));
  const stale = [...prior.keys()].filter((u) => !liveUrls.has(u));
  if (stale.length) {
    await env.DB.batch(stale.map((url) => env.DB.prepare(
      `DELETE FROM knowledge_pages WHERE workspace_id = ? AND source_id = ? AND url = ?`
    ).bind(session.workspaceId, sourceId, url)));
  }
  // Batched: each D1 round-trip counts against the Worker's subrequest ceiling, so writing 25 pages
  // one at a time would spend half the budget on storage alone.
  if (pages.length) {
    await env.DB.batch(pages.map((page) => env.DB.prepare(
      `INSERT INTO knowledge_pages (workspace_id, source_id, url, title, content, char_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, source_id, url) DO UPDATE SET title=excluded.title, content=excluded.content, char_count=excluded.char_count, fetched_at=CURRENT_TIMESTAMP`
    ).bind(session.workspaceId, sourceId, page.url, page.title, page.text, page.text.length)));
  }

  // knowledge_content stays the single-blob view, still used as the fallback whenever there is no
  // question to select pages against (and by anything already reading that table).
  const combined = pages.map((p) => `[${p.url}]\n${p.text}`).join("\n\n").slice(0, MAX_CONTENT_LENGTH);
  await env.DB.prepare(`INSERT INTO knowledge_content (workspace_id, source_id, url, content, char_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, source_id) DO UPDATE SET url=excluded.url, content=excluded.content, char_count=excluded.char_count, fetched_at=CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, sourceId, url, combined, combined.length).run();

  return json(request, {
    fetched: true, pageCount: pages.length, crawledCount: crawled.length, charCount: combined.length,
    render: { attempted: budget.attempted, succeeded: budget.succeeded, error: budget.lastError || null },
    pages: pages.map((p) => ({ url: p.url, chars: p.text.length })),
    excerpt: combined.slice(0, 300),
  });
}

// Rendering gets its own request because a Worker invocation is capped at 50 subrequests (free
// plan, D1 writes included). Crawling 25 pages plus storing them very nearly exhausts that, so the
// render calls at the end were being rejected outright — a correctly configured token still
// produced nothing. Each call to this endpoint starts with a fresh budget and upgrades a few more
// of the pages that are still thin, so running it repeatedly fills a JavaScript-heavy site in.
async function renderPass(request: Request, env: KnowledgeEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sourceId?: number };
  const sourceId = Number(body.sourceId);
  if (!Number.isFinite(sourceId)) return json(request, { error: "Missing source id." }, 400);
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_BROWSER_RENDERING_TOKEN) {
    return json(request, { error: "Browser rendering isn't configured for this workspace." }, 400);
  }

  await ensureKnowledgeSchema(env.DB);
  const rows = await env.DB.prepare(
    `SELECT url, char_count FROM knowledge_pages WHERE workspace_id = ? AND source_id = ? AND char_count < ?
     ORDER BY char_count ASC LIMIT ?`
  ).bind(session.workspaceId, sourceId, RENDER_IF_UNDER, MAX_RENDER_CALLS).all<{ url: string; char_count: number }>();
  const targets = rows.results || [];
  if (!targets.length) return json(request, { rendered: 0, remaining: 0, done: true });

  const budget: RenderBudget = { renders: MAX_RENDER_CALLS, attempted: 0, succeeded: 0 };
  const updates: D1PreparedStatement[] = [];
  for (const target of targets) {
    budget.attempted++;
    const html = await fetchRenderedHtml(target.url, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_BROWSER_RENDERING_TOKEN, budget);
    if (html) {
      const { bodyText } = await extractTextFromHtml(html);
      const text = bodyText.slice(0, MAX_PAGE_CHARS);
      // Only ever replace with more than we had, so a failed render never destroys good content.
      if (text.length > target.char_count) {
        updates.push(env.DB.prepare(`UPDATE knowledge_pages SET content = ?, char_count = ?, fetched_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ? AND source_id = ? AND url = ?`)
          .bind(text, text.length, session.workspaceId, sourceId, target.url));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RENDER_GAP_MS));
  }
  if (updates.length) await env.DB.batch(updates);

  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM knowledge_pages WHERE workspace_id = ? AND source_id = ? AND char_count < ?`)
    .bind(session.workspaceId, sourceId, RENDER_IF_UNDER).first<{ n: number }>();
  const remaining = Number(left?.n || 0);
  return json(request, {
    rendered: updates.length, attempted: budget.attempted, succeeded: budget.succeeded,
    remaining, done: remaining === 0, error: budget.lastError || null,
  });
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

// Picks the crawled pages worth spending the prompt budget on for THIS question. Without it,
// crawling a whole site would be actively worse than fetching one page: the budget would fill with
// whichever pages happened to be stored first, and the one page that answers the question would be
// truncated away. Deliberately simple keyword scoring — no embeddings, no vector store — because it
// only has to beat "the first N characters", which it does comfortably.
const STOPWORDS = new Set(["the","and","for","are","you","your","our","with","what","when","where","how","can","does","did","was","were","this","that","have","has","from","about","would","could","should","there","their","they","its","it's","get","got","any","all","not","but","who","why","which"]);

export async function getRelevantKnowledgePages(db: D1Database, workspaceId: string, sourceIds: number[], question: string, budget: number): Promise<string> {
  if (!sourceIds.length) return "";
  await ensureKnowledgeSchema(db);
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT url, content FROM knowledge_pages WHERE workspace_id = ? AND source_id IN (${placeholders})`)
    .bind(workspaceId, ...sourceIds).all<{ url: string; content: string }>();
  const pages = rows.results || [];
  if (!pages.length) return "";

  const terms = (question || "").toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((t) => !STOPWORDS.has(t)) || [];
  const scored = pages.map((page) => {
    const haystack = `${page.url} ${page.content}`.toLowerCase();
    let score = 0;
    for (const term of new Set(terms)) {
      const hits = haystack.split(term).length - 1;
      if (hits) score += 1 + Math.min(hits, 5) * 0.2;
    }
    return { ...page, score };
  }).sort((a, b) => b.score - a.score);

  // No question, or nothing matched: fall back to whole-site order rather than returning nothing.
  const chosen = scored.some((p) => p.score > 0) ? scored.filter((p) => p.score > 0) : scored;
  const parts: string[] = [];
  let used = 0;
  for (const page of chosen) {
    const block = `[${page.url}]\n${page.content}`;
    if (used + block.length > budget) {
      const remaining = budget - used;
      if (remaining > 400) parts.push(block.slice(0, remaining));
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
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
  if (url.pathname === "/api/knowledge/render-pass" && request.method === "POST") return renderPass(request, env);
  if (url.pathname === "/api/knowledge/save-content" && request.method === "POST") return saveContent(request, env);
  if (url.pathname === "/api/knowledge/content" && request.method === "GET") return getContent(request, env);
  return json(request, { error: "Not found" }, 404);
}
