/** Environment bindings the outreach pipeline reads. All strings are optional
 *  so the app still boots when a channel is not configured yet; each sender
 *  checks for what it needs and reports a clear error otherwise. */
export interface OutreachEnv {
  DB?: D1Database;

  /** Shared secret for the admin API (`Authorization: Bearer …`). */
  OUTREACH_ADMIN_TOKEN?: string;
  /** Secret used to sign unsubscribe links. Falls back to the admin token. */
  OUTREACH_SIGNING_SECRET?: string;
  /** Public origin of this deployment, used in unsubscribe links. */
  OUTREACH_PUBLIC_ORIGIN?: string;
  /** Max messages sent per daily run across all sectors. Default 50. */
  OUTREACH_DAILY_SEND_CAP?: string;
  /** Max automated touches per lead before we stop. Default 2. */
  OUTREACH_MAX_TOUCHES?: string;
  /** Days between the first message and a follow-up. Default 4. */
  OUTREACH_FOLLOW_UP_DAYS?: string;
  /** Comma-separated list of channels to use, in priority order. Default "whatsapp,email". */
  OUTREACH_CHANNELS?: string;
  /** Default country calling code for phone numbers without one. Default "91". */
  OUTREACH_DEFAULT_COUNTRY_CODE?: string;
  /** Set to "true" to log what would be sent without calling providers. */
  OUTREACH_DRY_RUN?: string;

  GOOGLE_MAPS_API_KEY?: string;

  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  /** Name of an approved Marketing/Utility template. */
  WHATSAPP_TEMPLATE_NAME?: string;
  /** Template language code, e.g. en or en_US. Default en. */
  WHATSAPP_TEMPLATE_LANG?: string;
  /** Comma-separated lead fields that fill the template body params, e.g. "business_name,city". */
  WHATSAPP_TEMPLATE_PARAMS?: string;
  /** Token you choose in the Meta dashboard when registering the webhook. */
  WHATSAPP_VERIFY_TOKEN?: string;
  /** Graph API version. Default v21.0 */
  WHATSAPP_API_VERSION?: string;

  RESEND_API_KEY?: string;
  /** e.g. "Praveen from Wavely <praveen@yourdomain.com>" */
  OUTREACH_FROM_EMAIL?: string;
  /** Reply-to address. Defaults to the from address. */
  OUTREACH_REPLY_TO?: string;
}

export interface OutreachSettings {
  dailySendCap: number;
  maxTouches: number;
  followUpDays: number;
  channels: Array<"whatsapp" | "email">;
  defaultCountryCode: string;
  dryRun: boolean;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readSettings(env: OutreachEnv): OutreachSettings {
  const channels = (env.OUTREACH_CHANNELS ?? "whatsapp,email")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is "whatsapp" | "email" => c === "whatsapp" || c === "email");

  return {
    dailySendCap: intFromEnv(env.OUTREACH_DAILY_SEND_CAP, 50),
    maxTouches: Math.max(1, intFromEnv(env.OUTREACH_MAX_TOUCHES, 2)),
    followUpDays: Math.max(1, intFromEnv(env.OUTREACH_FOLLOW_UP_DAYS, 4)),
    channels: channels.length > 0 ? channels : ["whatsapp", "email"],
    defaultCountryCode: (env.OUTREACH_DEFAULT_COUNTRY_CODE ?? "91").replace(/\D/g, "") || "91",
    dryRun: (env.OUTREACH_DRY_RUN ?? "").toLowerCase() === "true",
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
