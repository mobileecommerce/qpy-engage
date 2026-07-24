import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";
import { decryptToken, graphVersion, metaError, hmacHex, type MetaEnv, type ConnectionRow } from "./meta";
import { MESSAGE_CATEGORIES, deductMessageBalance, incrementSentCount } from "./messageBalance";

export interface CampaignsEnv extends AuthEnv, MetaEnv {
  DB: D1Database;
}

// Cloudflare Workers have a wall-clock limit per request; cap how many recipients a single
// campaign send loop will process synchronously. Larger sends need a real queue, which doesn't
// exist yet — this keeps the feature honest about what it can actually do today.
const MAX_SEND_RECIPIENTS = 200;

async function sendCampaign(request: Request, env: CampaignsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!env.META_TOKEN_ENCRYPTION_KEY || !env.META_APP_SECRET) return json(request, { error: "Meta server credentials are incomplete." }, 503);

  const body = await request.json() as { audienceId?: string; templateName?: string; templateLanguage?: string; messageCategory?: string };
  const audienceId = (body.audienceId || "").trim();
  const templateName = (body.templateName || "").trim();
  const templateLanguage = (body.templateLanguage || "en_US").trim();
  const messageCategory = (body.messageCategory || "").trim();
  if (!audienceId) return json(request, { error: "Select an audience." }, 400);
  if (!templateName) return json(request, { error: "Enter the exact name of a Meta-approved message template." }, 400);
  if (!MESSAGE_CATEGORIES.includes(messageCategory)) return json(request, { error: "Invalid message category." }, 400);

  const connection = await env.DB.prepare("SELECT * FROM whatsapp_connections WHERE workspace_id = ?").bind(session.workspaceId).first<ConnectionRow>();
  if (!connection) return json(request, { error: "Connect WhatsApp Business in Channels before sending a real campaign." }, 409);

  const audience = await env.DB.prepare("SELECT id FROM audiences WHERE id = ? AND workspace_id = ?").bind(audienceId, session.workspaceId).first();
  if (!audience) return json(request, { error: "Audience not found." }, 404);
  const membersResult = await env.DB.prepare(`SELECT c.phone as phone FROM contacts c JOIN audience_members am ON am.contact_id = c.id WHERE am.audience_id = ? AND c.consent = 1`)
    .bind(audienceId).all<{ phone: string }>();
  const recipients = (membersResult.results || []).map((r) => r.phone).filter(Boolean);
  if (!recipients.length) return json(request, { error: "This audience has no consented contacts to send to." }, 400);
  if (recipients.length > MAX_SEND_RECIPIENTS) return json(request, { error: `This audience has ${recipients.length.toLocaleString()} consented contacts — real sends are currently capped at ${MAX_SEND_RECIPIENTS} recipients per campaign.` }, 400);

  const token = await decryptToken(connection.token_ciphertext, connection.token_iv, env.META_TOKEN_ENCRYPTION_KEY);
  const proof = await hmacHex(env.META_APP_SECRET, token);
  const endpoint = `https://graph.facebook.com/${graphVersion(env)}/${connection.phone_number_id}/messages?appsecret_proof=${proof}`;

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const phone of recipients) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: phone.replace(/[^\d]/g, ""), type: "template", template: { name: templateName, language: { code: templateLanguage } } }),
      });
      if (response.ok) { sent++; } else { failed++; if (errors.length < 5) errors.push(await metaError(response)); }
    } catch { failed++; }
  }

  let balances;
  if (sent > 0) {
    const deduction = await deductMessageBalance(env.DB, session.workspaceId, messageCategory, sent);
    balances = deduction.ok ? deduction.balances : undefined;
    await incrementSentCount(env.DB, session.workspaceId, messageCategory, sent).catch(() => {});
  }

  return json(request, { sent, failed, total: recipients.length, deliveredPercent: Math.round((sent / recipients.length) * 1000) / 10, errors, balances });
}

export async function handleCampaignsRequest(request: Request, env: CampaignsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/campaigns/send") return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);
  if (request.method === "POST") return sendCampaign(request, env);
  return json(request, { error: "Method not allowed" }, 405);
}
