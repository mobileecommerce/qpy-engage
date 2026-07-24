import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";
import { listMessagePricing, type AdminEnv } from "./admin";
import { MESSAGE_CATEGORIES, ensureMessageBalanceSchema, getMessageBalances, getSentCounts, getPlanLimits, grantPlanMessages, deductMessageBalance } from "./messageBalance";

export interface CreditsEnv extends AuthEnv, AdminEnv {
  DB: D1Database;
}

const MAX_TOPUP_MESSAGES = 1_000_000;

async function getCredits(request: Request, env: CreditsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  // Grants on read (not just on signup/plan-change) so workspaces that predate this feature,
  // or whose grant was otherwise missed, still get their current plan's included messages —
  // idempotent and never reduces a balance already above the plan's floor.
  await grantPlanMessages(env.DB, session.workspaceId, session.workspacePlan);
  const [balances, sent] = await Promise.all([
    getMessageBalances(env.DB, session.workspaceId),
    getSentCounts(env.DB, session.workspaceId),
  ]);
  return json(request, { balances, sent });
}

async function getMyPlanLimits(request: Request, env: CreditsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const workspace = await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(session.workspaceId).first<{ plan: string | null }>();
  const plan = workspace?.plan || "Free";
  const limits = await getPlanLimits(env.DB, plan);
  return json(request, { plan, limits });
}

async function topupCredits(request: Request, env: CreditsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureMessageBalanceSchema(env.DB);
  const body = await request.json() as { category?: string; messages?: number };
  const category = (body.category || "").trim();
  if (!MESSAGE_CATEGORIES.includes(category)) return json(request, { error: "Invalid category." }, 400);
  const messages = Math.floor(Number(body.messages));
  if (!Number.isFinite(messages) || messages <= 0 || messages > MAX_TOPUP_MESSAGES) return json(request, { error: `Enter a message quantity between 1 and ${MAX_TOPUP_MESSAGES.toLocaleString()}.` }, 400);
  await env.DB.prepare(`INSERT INTO workspace_message_balance (workspace_id, category, message_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, category) DO UPDATE SET message_count = message_count + excluded.message_count, updated_at = CURRENT_TIMESTAMP`)
    .bind(session.workspaceId, category, messages).run();
  const balances = await getMessageBalances(env.DB, session.workspaceId);
  return json(request, { balances, demo: true });
}

async function deductCredits(request: Request, env: CreditsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureMessageBalanceSchema(env.DB);
  const body = await request.json() as { category?: string; messages?: number };
  const category = (body.category || "").trim();
  if (!MESSAGE_CATEGORIES.includes(category)) return json(request, { error: "Invalid category." }, 400);
  const messages = Math.floor(Number(body.messages));
  if (!Number.isFinite(messages) || messages < 0) return json(request, { error: "A valid, non-negative message count is required." }, 400);
  const result = await deductMessageBalance(env.DB, session.workspaceId, category, messages);
  if (!result.ok) return json(request, { error: result.error }, 402);
  return json(request, { balances: result.balances });
}

export async function handleCreditsRequest(request: Request, env: CreditsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/credits" && url.pathname !== "/api/credits/topup" && url.pathname !== "/api/credits/deduct" && url.pathname !== "/api/pricing" && url.pathname !== "/api/plan-limits") return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/pricing" && request.method === "GET") return listMessagePricing(request, env, false);
  if (url.pathname === "/api/plan-limits" && request.method === "GET") return getMyPlanLimits(request, env);
  if (url.pathname === "/api/credits" && request.method === "GET") return getCredits(request, env);
  if (url.pathname === "/api/credits/topup" && request.method === "POST") return topupCredits(request, env);
  if (url.pathname === "/api/credits/deduct" && request.method === "POST") return deductCredits(request, env);
  return json(request, { error: "Method not allowed" }, 405);
}
