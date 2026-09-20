import type { OutreachEnv } from "./config";

/**
 * WhatsApp Cloud API (Meta) sender.
 *
 * Business-initiated messages to people who have not written to you first
 * MUST use a pre-approved message template. Free-form text is only allowed
 * inside the 24-hour window after the customer replies. Create the template
 * in WhatsApp Manager > Message templates, category Marketing, and put its
 * name in WHATSAPP_TEMPLATE_NAME.
 */

export interface SendTemplateInput {
  to: string; // digits only, with country code
  templateName: string;
  languageCode: string;
  bodyParams: string[];
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export function whatsappConfigured(env: OutreachEnv): string | null {
  if (!env.WHATSAPP_ACCESS_TOKEN) return "WHATSAPP_ACCESS_TOKEN is not set";
  if (!env.WHATSAPP_PHONE_NUMBER_ID) return "WHATSAPP_PHONE_NUMBER_ID is not set";
  if (!env.WHATSAPP_TEMPLATE_NAME) return "WHATSAPP_TEMPLATE_NAME is not set";
  return null;
}

export async function sendWhatsAppTemplate(env: OutreachEnv, input: SendTemplateInput, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const missing = whatsappConfigured(env);
  if (missing) return { ok: false, error: missing };

  const version = env.WHATSAPP_API_VERSION ?? "v21.0";
  const url = `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components:
        input.bodyParams.length > 0
          ? [
              {
                type: "body",
                parameters: input.bodyParams.map((text) => ({ type: "text", text })),
              },
            ]
          : [],
    },
  };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    if (!res.ok) {
      return { ok: false, error: `WhatsApp ${res.status}: ${data.error?.message ?? res.statusText} (code ${data.error?.code ?? "?"})` };
    }
    return { ok: true, providerMessageId: data.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: `WhatsApp request failed: ${(err as Error).message}` };
  }
}

/* ---------- Inbound webhook parsing ---------- */

export interface InboundMessage {
  from: string; // digits only
  providerMessageId: string;
  text: string | null;
  type: string;
}

export interface StatusUpdate {
  providerMessageId: string;
  status: string; // sent | delivered | read | failed
  recipient: string;
  error: string | null;
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from: string; id: string; type: string; text?: { body?: string }; button?: { text?: string } }>;
        statuses?: Array<{ id: string; status: string; recipient_id: string; errors?: Array<{ title?: string; message?: string }> }>;
      };
    }>;
  }>;
}

export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const body = (payload ?? {}) as WebhookPayload;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const m of value?.messages ?? []) {
        messages.push({
          from: m.from.replace(/\D/g, ""),
          providerMessageId: m.id,
          type: m.type,
          text: m.text?.body ?? m.button?.text ?? null,
        });
      }
      for (const s of value?.statuses ?? []) {
        statuses.push({
          providerMessageId: s.id,
          status: s.status,
          recipient: s.recipient_id.replace(/\D/g, ""),
          error: s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null,
        });
      }
    }
  }
  return { messages, statuses };
}
