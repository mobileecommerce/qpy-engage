/**
 * Find a contact email for a business by reading its own website.
 * Google Places never returns email addresses, so this is the only honest
 * source: the address the business chose to publish.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Substrings that mark an address as a placeholder, tracker or asset, not a mailbox. */
const JUNK_PATTERNS = [
  /example\.(com|org|net)$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /^(noreply|no-reply|donotreply|mailer-daemon)@/i,
  /@(\d+\.){3}\d+$/,
  /schema\.org$/i,
  /w3\.org$/i,
];

/** Prefer generic business inboxes over personal or automated ones. */
const PREFERRED_LOCALPARTS = ["info", "contact", "hello", "enquiry", "enquiries", "sales", "admin", "office", "support", "reception"];

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  // Decode the most common HTML entity obfuscations before matching.
  const decoded = html
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&#46;|&period;/gi, ".")
    .replace(/\s*\[at\]\s*|\s*\(at\)\s*/gi, "@")
    .replace(/\s*\[dot\]\s*|\s*\(dot\)\s*/gi, ".");

  for (const match of decoded.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase().replace(/^mailto:/, "").replace(/[.,;:]+$/, "");
    if (JUNK_PATTERNS.some((re) => re.test(email))) continue;
    if (email.length > 254) continue;
    found.add(email);
  }
  return [...found];
}

export function pickBestEmail(emails: string[], websiteHost?: string | null): string | null {
  if (emails.length === 0) return null;
  const host = websiteHost?.replace(/^www\./, "").toLowerCase();

  const score = (email: string): number => {
    const [local, domain] = email.split("@");
    let s = 0;
    if (host && domain === host) s += 10; // same domain as the website
    if (PREFERRED_LOCALPARTS.includes(local)) s += 5;
    if (/^(gmail|yahoo|hotmail|outlook|rediffmail)\.com$/.test(domain)) s += 1; // still fine for SMBs
    return s;
  };

  return [...emails].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export interface EnrichOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

async function fetchText(url: string, { fetchImpl = fetch, timeoutMs = 8000, maxBytes = 600_000 }: EnrichOptions): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify ourselves honestly; many sites block anonymous bots.
        "User-Agent": "Mozilla/5.0 (compatible; WavelyOutreachBot/1.0; +https://wavely.app)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) return null;
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  }
}

/**
 * Try the homepage first, then the usual contact pages. Returns the best
 * email found or null. Never throws; a missing email is a normal outcome.
 */
export async function findEmailOnWebsite(website: string, options: EnrichOptions = {}): Promise<string | null> {
  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(base.protocol)) return null;

  const candidates = [base.href, new URL("/contact", base).href, new URL("/contact-us", base).href];
  const seen = new Set<string>();

  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await fetchText(url, options);
    if (!html) continue;
    const email = pickBestEmail(extractEmails(html), base.hostname);
    if (email) return email;
  }
  return null;
}
