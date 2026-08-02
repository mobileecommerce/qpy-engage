/* ================================================================================================
   Visitor context for web chat.

   An agent picking up a live chat is otherwise working blind: no name, no history, just text. The
   request itself already carries most of what would help — Cloudflare resolves coarse location and
   network at the edge, and the browser announces itself in the User-Agent — so this costs one extra
   write per conversation and no third-party geo-IP service.

   The raw IP address is deliberately never stored. City and country are what an agent can act on;
   the full address is the identifying part, is what turns a support record into a tracking record,
   and nothing in the product needs it.
   ============================================================================================== */

export interface VisitorContext {
  country: string; countryCode: string; city: string; region: string; timezone: string;
  isp: string; browser: string; os: string; deviceType: string; language: string;
  pageUrl: string; pageTitle: string; referrer: string; screen: string;
  firstSeen: string; lastSeen: string; visitCount: number;
  online: boolean; secondsSinceSeen: number;
}

// Cloudflare attaches this to every request at the edge. Typed narrowly because only these fields
// are read, and `cf` is absent when running outside the Workers runtime.
interface CfProperties {
  country?: string; city?: string; region?: string; timezone?: string; asOrganization?: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  AE: "United Arab Emirates", SA: "Saudi Arabia", IN: "India", PK: "Pakistan", GB: "United Kingdom",
  US: "United States", CA: "Canada", AU: "Australia", DE: "Germany", FR: "France", ES: "Spain",
  IT: "Italy", NL: "Netherlands", SG: "Singapore", PH: "Philippines", BD: "Bangladesh",
  EG: "Egypt", JO: "Jordan", LB: "Lebanon", QA: "Qatar", KW: "Kuwait", OM: "Oman", BH: "Bahrain",
  ZA: "South Africa", NG: "Nigeria", KE: "Kenya", TR: "Turkey", RU: "Russia", CN: "China",
  JP: "Japan", KR: "South Korea", BR: "Brazil", MX: "Mexico", ID: "Indonesia", MY: "Malaysia",
  TH: "Thailand", LK: "Sri Lanka", NP: "Nepal", IR: "Iran", IQ: "Iraq", SY: "Syria", YE: "Yemen",
};

/**
 * Browser and OS from the User-Agent.
 *
 * Order matters throughout: Edge and Opera both claim to be Chrome, Chrome claims to be Safari, and
 * every mobile browser claims to be Safari. Testing the most specific token first is what keeps
 * "Edge" from being reported as "Chrome".
 */
export function parseUserAgent(ua: string): { browser: string; os: string; deviceType: string } {
  const s = ua || "";
  const browser =
    /\bEdgA?\//.test(s) ? "Edge"
    : /\bOPR\/|\bOpera/.test(s) ? "Opera"
    : /\bSamsungBrowser\//.test(s) ? "Samsung Internet"
    : /\bFxiOS\/|\bFirefox\//.test(s) ? "Firefox"
    : /\bCriOS\//.test(s) ? "Chrome"
    : /\bChrome\//.test(s) ? "Chrome"
    : /\bSafari\//.test(s) ? "Safari"
    : "";

  const os =
    /\bWindows NT 10/.test(s) ? "Windows"
    : /\bWindows/.test(s) ? "Windows"
    : /\bAndroid\b/.test(s) ? "Android"
    // iPadOS reports as Macintosh, so touch capability is the only reliable separator.
    : /\biPhone\b/.test(s) ? "iOS"
    : /\biPad\b/.test(s) ? "iPadOS"
    : /\bMac OS X\b/.test(s) ? "macOS"
    : /\bCrOS\b/.test(s) ? "ChromeOS"
    : /\bLinux\b/.test(s) ? "Linux"
    : "";

  const deviceType =
    /\biPad\b/.test(s) || (/\bAndroid\b/.test(s) && !/\bMobile\b/.test(s)) ? "Tablet"
    : /\bMobi|\biPhone\b|\bAndroid\b/.test(s) ? "Mobile"
    : os ? "Desktop" : "";

  return { browser, os, deviceType };
}

/** The first tag in Accept-Language, which is the visitor's actual preference. */
export function primaryLanguage(header: string): string {
  const first = (header || "").split(",")[0]?.trim().split(";")[0]?.trim() || "";
  return first.slice(0, 12);
}

export async function ensureVisitorSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS widget_visitor_context (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '',
      country_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '',
      isp TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      device_type TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      page_url TEXT NOT NULL DEFAULT '',
      page_title TEXT NOT NULL DEFAULT '',
      referrer TEXT NOT NULL DEFAULT '',
      screen TEXT NOT NULL DEFAULT '',
      visit_count INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, session_id)
    )`),
  ]);
}

export interface ClientHints {
  pageUrl?: string; pageTitle?: string; referrer?: string; screen?: string; timezone?: string;
}

/**
 * Records what this request reveals about the visitor.
 *
 * Called on every message rather than only the first: the page they are on changes as they browse,
 * and knowing a visitor moved from the homepage to the pricing page mid-conversation is exactly the
 * kind of context that helps an agent. Location and device are written once and then left alone,
 * because a later request through a different network should not silently rewrite where the
 * conversation started.
 */
export async function recordVisitorContext(
  db: D1Database, request: Request, workspaceId: string, sessionId: string, hints: ClientHints = {},
): Promise<void> {
  if (!workspaceId || !sessionId) return;
  const cf = (request as Request & { cf?: CfProperties }).cf || {};
  const headers = request.headers;
  const { browser, os, deviceType } = parseUserAgent(headers.get("user-agent") || "");
  const countryCode = (cf.country || headers.get("cf-ipcountry") || "").toUpperCase().slice(0, 2);

  const clip = (value: string | undefined, max: number) => (value || "").toString().trim().slice(0, max);

  await ensureVisitorSchema(db);
  await db.prepare(`INSERT INTO widget_visitor_context
      (workspace_id, session_id, country, country_code, city, region, timezone, isp,
       browser, os, device_type, language, page_url, page_title, referrer, screen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET
      page_url   = CASE WHEN excluded.page_url   != '' THEN excluded.page_url   ELSE widget_visitor_context.page_url END,
      page_title = CASE WHEN excluded.page_title != '' THEN excluded.page_title ELSE widget_visitor_context.page_title END,
      visit_count = widget_visitor_context.visit_count + 1,
      last_seen = CURRENT_TIMESTAMP`)
    .bind(
      workspaceId, sessionId,
      COUNTRY_NAMES[countryCode] || countryCode, countryCode,
      clip(cf.city, 60), clip(cf.region, 60),
      clip(hints.timezone || cf.timezone, 60), clip(cf.asOrganization, 80),
      browser, os, deviceType, primaryLanguage(headers.get("accept-language") || ""),
      clip(hints.pageUrl, 300), clip(hints.pageTitle, 160),
      clip(hints.referrer, 300), clip(hints.screen, 20),
    )
    .run()
    .catch(() => { /* context is a nicety — never fail a customer's message over it */ });
}

interface ContextRow {
  country: string; country_code: string; city: string; region: string; timezone: string; isp: string;
  browser: string; os: string; device_type: string; language: string; page_url: string;
  page_title: string; referrer: string; screen: string; visit_count: number;
  first_seen: string; last_seen: string;
}


/** A visitor is "here" if we heard from their browser this recently. The widget polls every 4
 *  seconds, so this tolerates roughly four missed beats before it stops claiming they are online. */
export const ONLINE_WINDOW_SECONDS = 20;

/**
 * Records that this visitor's browser is still open.
 *
 * Called from the widget poll, which fires every few seconds per open page. Writing on every one of
 * those would be a needless write per visitor per poll, so the UPDATE is conditional: the row is
 * only touched once the stored timestamp is actually stale. Presence stays accurate to within a few
 * seconds while the write rate drops by roughly the polling frequency.
 */
export async function touchPresence(db: D1Database, workspaceId: string, sessionId: string): Promise<void> {
  if (!workspaceId || !sessionId) return;
  await db.prepare(`UPDATE widget_visitor_context SET last_seen = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND session_id = ? AND last_seen < datetime('now', '-8 seconds')`)
    .bind(workspaceId, sessionId).run().catch(() => { /* presence is never worth failing a poll */ });
}

/** SQL fragment giving 1 when a visitor row was seen inside the online window. */
export const ONLINE_SQL = `(v.last_seen IS NOT NULL AND v.last_seen > datetime('now', '-${ONLINE_WINDOW_SECONDS} seconds'))`;


/** D1 stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; Date.parse needs both
 *  the separator and the Z or it silently reads them as local time and reports the wrong age. */
function secondsSince(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const parsed = Date.parse(`${stamp.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

export async function readVisitorContext(
  db: D1Database, workspaceId: string, sessionId: string,
): Promise<VisitorContext | null> {
  const row = await db.prepare(`SELECT * FROM widget_visitor_context WHERE workspace_id = ? AND session_id = ?`)
    .bind(workspaceId, sessionId).first<ContextRow>().catch(() => null);
  if (!row) return null;
  const seconds = secondsSince(row.last_seen);
  return {
    country: row.country, countryCode: row.country_code, city: row.city, region: row.region,
    timezone: row.timezone, isp: row.isp, browser: row.browser, os: row.os,
    deviceType: row.device_type, language: row.language, pageUrl: row.page_url,
    pageTitle: row.page_title, referrer: row.referrer, screen: row.screen,
    firstSeen: row.first_seen, lastSeen: row.last_seen, visitCount: row.visit_count,
    online: seconds !== null && seconds <= ONLINE_WINDOW_SECONDS,
    secondsSinceSeen: seconds ?? -1,
  };
}
