import type { OutreachEnv } from "./config";
import type { SendResult } from "./whatsapp";

/**
 * Email sender backed by Resend (https://resend.com). Any transactional
 * provider works; this one has a tiny API and a free tier.
 *
 * Every message carries a List-Unsubscribe header and an unsubscribe link in
 * the body, which CAN-SPAM, GDPR and Gmail's bulk-sender rules all require.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  unsubscribeUrl: string;
}

export function emailConfigured(env: OutreachEnv): string | null {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY is not set";
  if (!env.OUTREACH_FROM_EMAIL) return "OUTREACH_FROM_EMAIL is not set";
  return null;
}

export async function sendEmail(env: OutreachEnv, input: SendEmailInput, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const missing = emailConfigured(env);
  if (missing) return { ok: false, error: missing };

  const text = `${input.text.trimEnd()}\n\n--\nIf you'd rather not hear from us, unsubscribe here: ${input.unsubscribeUrl}\n`;

  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.OUTREACH_FROM_EMAIL,
        to: [input.to],
        reply_to: env.OUTREACH_REPLY_TO ?? undefined,
        subject: input.subject,
        text,
        headers: {
          "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${data.message ?? data.name ?? res.statusText}` };
    return { ok: true, providerMessageId: data.id };
  } catch (err) {
    return { ok: false, error: `Email request failed: ${(err as Error).message}` };
  }
}
