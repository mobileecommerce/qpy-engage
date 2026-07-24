import { requireSession, createSession, type AuthEnv, type SessionContext } from "./auth";
import { json, corsPreflight, allowedOrigin, sanitizeActions, type AssistantActionDef } from "./shared";
import { MESSAGE_CATEGORIES, WORKSPACE_PLANS, ensurePlanLimitsSchema, grantPlanMessages } from "./messageBalance";

export interface AdminEnv extends AuthEnv {
  DB: D1Database;
}

function uid(): string {
  return crypto.randomUUID();
}

const DEFAULT_MESSAGE_PRICING: Record<string, number> = { Marketing: 0.05, Utility: 0.02, Authentication: 0.02, Service: 0 };

// Plan $ price and feature-inclusion metadata for the superadmin Plans & Billing screen. This
// is real, persisted, superadmin-editable config — but note it's list-price metadata only, not
// tied to an actual payment gateway (none is integrated yet), and plan_features isn't currently
// enforced elsewhere in the app — it documents what's nominally included per tier.
const DEFAULT_PLAN_PRICING: Record<string, number> = { Free: 0, Starter: 49, Growth: 149, Scale: 399, Enterprise: 1200 };
const PLAN_FEATURE_KEYS = ["whatsapp", "instagram", "webWidget", "aiActions", "ordersQpy", "analytics", "prioritySupport", "whiteLabel"] as const;
const DEFAULT_PLAN_FEATURES: Record<string, Record<string, boolean>> = {
  Free: { whatsapp: true, instagram: false, webWidget: true, aiActions: false, ordersQpy: false, analytics: false, prioritySupport: false, whiteLabel: false },
  Starter: { whatsapp: true, instagram: false, webWidget: true, aiActions: true, ordersQpy: false, analytics: false, prioritySupport: false, whiteLabel: false },
  Growth: { whatsapp: true, instagram: true, webWidget: true, aiActions: true, ordersQpy: true, analytics: true, prioritySupport: false, whiteLabel: false },
  Scale: { whatsapp: true, instagram: true, webWidget: true, aiActions: true, ordersQpy: true, analytics: true, prioritySupport: true, whiteLabel: false },
  Enterprise: { whatsapp: true, instagram: true, webWidget: true, aiActions: true, ordersQpy: true, analytics: true, prioritySupport: true, whiteLabel: true },
};

async function ensurePlanConfigSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS plan_pricing (
      plan TEXT PRIMARY KEY NOT NULL,
      price_usd REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS plan_features (
      plan TEXT NOT NULL,
      feature TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plan, feature)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS qpy_integration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      connected INTEGER NOT NULL DEFAULT 0,
      api_key TEXT,
      channel_whatsapp INTEGER NOT NULL DEFAULT 1,
      channel_instagram INTEGER NOT NULL DEFAULT 1,
      channel_webchat INTEGER NOT NULL DEFAULT 1,
      auto_confirm_orders INTEGER NOT NULL DEFAULT 0,
      notify_email TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);
  const havePricing = await db.prepare(`SELECT plan FROM plan_pricing`).all<{ plan: string }>();
  const pricingHave = new Set((havePricing.results || []).map((r) => r.plan));
  const missingPricing = Object.entries(DEFAULT_PLAN_PRICING).filter(([plan]) => !pricingHave.has(plan));
  const haveFeatures = await db.prepare(`SELECT plan, feature FROM plan_features`).all<{ plan: string; feature: string }>();
  const featuresHave = new Set((haveFeatures.results || []).map((r) => `${r.plan}::${r.feature}`));
  const missingFeatures: Array<[string, string, boolean]> = [];
  for (const plan of Object.keys(DEFAULT_PLAN_FEATURES)) {
    for (const feature of PLAN_FEATURE_KEYS) {
      if (!featuresHave.has(`${plan}::${feature}`)) missingFeatures.push([plan, feature, DEFAULT_PLAN_FEATURES[plan][feature]]);
    }
  }
  const seeds = [
    ...missingPricing.map(([plan, price]) => db.prepare(`INSERT INTO plan_pricing (plan, price_usd) VALUES (?, ?)`).bind(plan, price)),
    ...missingFeatures.map(([plan, feature, enabled]) => db.prepare(`INSERT INTO plan_features (plan, feature, enabled) VALUES (?, ?, ?)`).bind(plan, feature, enabled ? 1 : 0)),
  ];
  if (seeds.length) await db.batch(seeds);
  const qpyRow = await db.prepare(`SELECT id FROM qpy_integration WHERE id = 1`).first();
  if (!qpyRow) await db.prepare(`INSERT INTO qpy_integration (id, connected, notify_email) VALUES (1, 0, '')`).run();
}

async function listPlanPricing(request: Request, env: AdminEnv, requireAdmin: boolean): Promise<Response> {
  if (requireAdmin) {
    const session = await requireSuperadmin(request, env);
    if (session instanceof Response) return session;
  } else {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
  }
  await ensurePlanConfigSchema(env.DB);
  const result = await env.DB.prepare(`SELECT plan, price_usd as priceUsd FROM plan_pricing ORDER BY price_usd`).all<{ plan: string; priceUsd: number }>();
  return json(request, { pricing: result.results || [] });
}

async function updatePlanPricing(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanConfigSchema(env.DB);
  const body = await request.json() as { plan?: string; priceUsd?: number };
  const plan = (body.plan || "").trim();
  if (!WORKSPACE_PLANS.includes(plan)) return json(request, { error: "Invalid plan." }, 400);
  const priceUsd = Number(body.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return json(request, { error: "A valid, non-negative price is required." }, 400);
  await env.DB.prepare(`UPDATE plan_pricing SET price_usd = ?, updated_at = CURRENT_TIMESTAMP WHERE plan = ?`).bind(priceUsd, plan).run();
  return json(request, { saved: true });
}

async function listPlanFeatures(request: Request, env: AdminEnv, requireAdmin: boolean): Promise<Response> {
  if (requireAdmin) {
    const session = await requireSuperadmin(request, env);
    if (session instanceof Response) return session;
  } else {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
  }
  await ensurePlanConfigSchema(env.DB);
  const result = await env.DB.prepare(`SELECT plan, feature, enabled FROM plan_features ORDER BY plan, feature`).all<{ plan: string; feature: string; enabled: number }>();
  return json(request, { features: (result.results || []).map((r) => ({ plan: r.plan, feature: r.feature, enabled: Boolean(r.enabled) })) });
}

async function updatePlanFeature(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanConfigSchema(env.DB);
  const body = await request.json() as { plan?: string; feature?: string; enabled?: boolean };
  const plan = (body.plan || "").trim();
  const feature = (body.feature || "").trim();
  if (!WORKSPACE_PLANS.includes(plan)) return json(request, { error: "Invalid plan." }, 400);
  if (!(PLAN_FEATURE_KEYS as readonly string[]).includes(feature)) return json(request, { error: "Invalid feature." }, 400);
  await env.DB.prepare(`INSERT INTO plan_features (plan, feature, enabled, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(plan, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`)
    .bind(plan, feature, body.enabled ? 1 : 0).run();
  return json(request, { saved: true });
}

async function getQpyIntegration(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanConfigSchema(env.DB);
  const row = await env.DB.prepare(`SELECT connected, api_key as apiKey, channel_whatsapp as channelWhatsapp, channel_instagram as channelInstagram, channel_webchat as channelWebchat, auto_confirm_orders as autoConfirmOrders, notify_email as notifyEmail FROM qpy_integration WHERE id = 1`)
    .first<{ connected: number; apiKey: string | null; channelWhatsapp: number; channelInstagram: number; channelWebchat: number; autoConfirmOrders: number; notifyEmail: string }>();
  return json(request, {
    integration: {
      connected: Boolean(row?.connected),
      hasApiKey: Boolean(row?.apiKey),
      channels: { whatsapp: Boolean(row?.channelWhatsapp), instagram: Boolean(row?.channelInstagram), webchat: Boolean(row?.channelWebchat) },
      autoConfirmOrders: Boolean(row?.autoConfirmOrders),
      notifyEmail: row?.notifyEmail || "",
    },
  });
}

async function updateQpyIntegration(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanConfigSchema(env.DB);
  const body = await request.json() as { connected?: boolean; apiKey?: string; channels?: { whatsapp?: boolean; instagram?: boolean; webchat?: boolean }; autoConfirmOrders?: boolean; notifyEmail?: string };
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.connected !== undefined) { sets.push("connected = ?"); values.push(body.connected ? 1 : 0); }
  if (body.apiKey !== undefined) { sets.push("api_key = ?"); values.push(body.apiKey.trim() || null); }
  if (body.channels?.whatsapp !== undefined) { sets.push("channel_whatsapp = ?"); values.push(body.channels.whatsapp ? 1 : 0); }
  if (body.channels?.instagram !== undefined) { sets.push("channel_instagram = ?"); values.push(body.channels.instagram ? 1 : 0); }
  if (body.channels?.webchat !== undefined) { sets.push("channel_webchat = ?"); values.push(body.channels.webchat ? 1 : 0); }
  if (body.autoConfirmOrders !== undefined) { sets.push("auto_confirm_orders = ?"); values.push(body.autoConfirmOrders ? 1 : 0); }
  if (body.notifyEmail !== undefined) { sets.push("notify_email = ?"); values.push(body.notifyEmail.trim().slice(0, 200)); }
  if (!sets.length) return json(request, { saved: true });
  sets.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(`UPDATE qpy_integration SET ${sets.join(", ")} WHERE id = 1`).bind(...values).run();
  return json(request, { saved: true });
}

async function ensureAdminSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS automation_templates (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      action_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS message_pricing (
      category TEXT PRIMARY KEY NOT NULL,
      price_usd REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);
  const existing = await db.prepare(`SELECT category FROM message_pricing`).all<{ category: string }>();
  const have = new Set((existing.results || []).map((r) => r.category));
  const missing = Object.entries(DEFAULT_MESSAGE_PRICING).filter(([category]) => !have.has(category));
  if (missing.length) {
    await db.batch(missing.map(([category, price]) => db.prepare(`INSERT INTO message_pricing (category, price_usd) VALUES (?, ?)`).bind(category, price)));
  }
}

export async function listMessagePricing(request: Request, env: AdminEnv, requireAdmin: boolean): Promise<Response> {
  if (requireAdmin) {
    const session = await requireSuperadmin(request, env);
    if (session instanceof Response) return session;
  } else {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
  }
  await ensureAdminSchema(env.DB);
  const result = await env.DB.prepare(`SELECT category, price_usd as priceUsd, updated_at as updatedAt FROM message_pricing ORDER BY category`).all<{ category: string; priceUsd: number; updatedAt: string }>();
  return json(request, { pricing: result.results || [] });
}

async function updateMessagePricing(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  const body = await request.json() as { category?: string; priceUsd?: number };
  const category = (body.category || "").trim();
  if (!Object.keys(DEFAULT_MESSAGE_PRICING).includes(category)) return json(request, { error: "Invalid category." }, 400);
  const priceUsd = Number(body.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return json(request, { error: "A valid, non-negative price is required." }, 400);
  await env.DB.prepare(`UPDATE message_pricing SET price_usd = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?`).bind(priceUsd, category).run();
  return json(request, { saved: true });
}

async function requireSuperadmin(request: Request, env: AdminEnv): Promise<SessionContext | Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!session.isSuperadmin) return json(request, { error: "Not authorized." }, 403);
  return session;
}

async function listWorkspaces(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;

  const result = await env.DB.prepare(`SELECT w.id, w.name, w.created_at as createdAt, w.status as status, w.plan as plan, u.email as ownerEmail
    FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id ORDER BY w.created_at DESC`)
    .all<{ id: string; name: string; createdAt: string; status: string | null; plan: string | null; ownerEmail: string | null }>();
  const workspaces = result.results || [];
  const ids = workspaces.map((w) => w.id);

  const messageCounts = new Map<string, number>();
  const conversationCounts = new Map<string, number>();
  const whatsappConnected = new Set<string>();
  const leadCounts = new Map<string, number>();
  const whatsappMessageCounts = new Map<string, number>();
  const sentTotals = new Map<string, number>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    try {
      const wc = await env.DB.prepare(`SELECT workspace_id, COUNT(*) as c, COUNT(DISTINCT session_id) as sessions FROM widget_messages WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id`)
        .bind(...ids).all<{ workspace_id: string; c: number; sessions: number }>();
      for (const r of wc.results || []) { messageCounts.set(r.workspace_id, r.c); conversationCounts.set(r.workspace_id, r.sessions); }
    } catch { /* widget_messages may not exist yet */ }
    try {
      const wa = await env.DB.prepare(`SELECT workspace_id FROM whatsapp_connections WHERE workspace_id IN (${placeholders})`)
        .bind(...ids).all<{ workspace_id: string }>();
      for (const r of wa.results || []) whatsappConnected.add(r.workspace_id);
    } catch { /* whatsapp_connections may not exist yet */ }
    try {
      const leads = await env.DB.prepare(`SELECT workspace_id, COUNT(*) as c FROM action_submissions WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id`)
        .bind(...ids).all<{ workspace_id: string; c: number }>();
      for (const r of leads.results || []) leadCounts.set(r.workspace_id, r.c);
    } catch { /* action_submissions may not exist yet */ }
    try {
      const wm = await env.DB.prepare(`SELECT workspace_id, COUNT(*) as c FROM whatsapp_messages WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id`)
        .bind(...ids).all<{ workspace_id: string; c: number }>();
      for (const r of wm.results || []) whatsappMessageCounts.set(r.workspace_id, r.c);
    } catch { /* whatsapp_messages may not exist yet */ }
    try {
      const sent = await env.DB.prepare(`SELECT workspace_id, SUM(sent_count) as c FROM workspace_message_sent WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id`)
        .bind(...ids).all<{ workspace_id: string; c: number }>();
      for (const r of sent.results || []) sentTotals.set(r.workspace_id, r.c || 0);
    } catch { /* workspace_message_sent may not exist yet */ }
  }

  return json(request, {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ownerEmail: w.ownerEmail,
      createdAt: w.createdAt,
      webChatMessageCount: messageCounts.get(w.id) || 0,
      webChatConversationCount: conversationCounts.get(w.id) || 0,
      whatsappConnected: whatsappConnected.has(w.id),
      whatsappMessageCount: whatsappMessageCounts.get(w.id) || 0,
      leadsCount: leadCounts.get(w.id) || 0,
      messagesSentTotal: sentTotals.get(w.id) || 0,
      status: w.status === "disabled" ? "disabled" : "active",
      plan: w.plan || "Free",
    })),
  });
}

const ALLOWED_PLANS = new Set(["Free", "Starter", "Growth", "Scale", "Enterprise"]);

async function updateWorkspace(request: Request, env: AdminEnv, workspaceId: string): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { status?: string; plan?: string };
  const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(workspaceId).first();
  if (!workspace) return json(request, { error: "Workspace not found." }, 404);

  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return json(request, { error: "Invalid status." }, 400);
    await env.DB.prepare("UPDATE workspaces SET status = ? WHERE id = ?").bind(body.status, workspaceId).run();
  }
  if (body.plan !== undefined) {
    if (!ALLOWED_PLANS.has(body.plan)) return json(request, { error: "Invalid plan." }, 400);
    await env.DB.prepare("UPDATE workspaces SET plan = ? WHERE id = ?").bind(body.plan, workspaceId).run();
    await grantPlanMessages(env.DB, workspaceId, body.plan);
  }
  return json(request, { saved: true });
}

async function listPlanLimits(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanLimitsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT plan, category, message_limit as messageLimit FROM plan_limits ORDER BY plan, category`).all<{ plan: string; category: string; messageLimit: number }>();
  return json(request, { limits: result.results || [] });
}

async function updatePlanLimit(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensurePlanLimitsSchema(env.DB);
  const body = await request.json() as { plan?: string; category?: string; messageLimit?: number };
  const plan = (body.plan || "").trim();
  const category = (body.category || "").trim();
  if (!WORKSPACE_PLANS.includes(plan)) return json(request, { error: "Invalid plan." }, 400);
  if (!MESSAGE_CATEGORIES.includes(category)) return json(request, { error: "Invalid category." }, 400);
  const messageLimit = Math.floor(Number(body.messageLimit));
  if (!Number.isFinite(messageLimit) || messageLimit < 0) return json(request, { error: "A valid, non-negative message limit is required." }, 400);
  await env.DB.prepare(`UPDATE plan_limits SET message_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE plan = ? AND category = ?`).bind(messageLimit, plan, category).run();
  return json(request, { saved: true });
}

type TemplateRow = { id: string; name: string; description: string; action_json: string; created_at: string; updated_at: string };

function templateToJson(row: TemplateRow) {
  return { id: row.id, name: row.name, description: row.description, action: JSON.parse(row.action_json) as AssistantActionDef, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function listTemplates(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM automation_templates ORDER BY created_at DESC`).all<TemplateRow>();
  return json(request, { templates: (result.results || []).map(templateToJson) });
}

function sanitizeTemplateAction(input: unknown): AssistantActionDef | null {
  const sanitized = sanitizeActions([{ ...(input as Record<string, unknown>), enabled: true }]);
  return sanitized[0] || null;
}

async function createTemplate(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  const body = await request.json() as { name?: string; description?: string; action?: unknown };
  const name = (body.name || "").trim().slice(0, 120);
  if (!name) return json(request, { error: "A template name is required." }, 400);
  const action = sanitizeTemplateAction(body.action);
  if (!action) return json(request, { error: "A valid action (name + https endpoint) is required." }, 400);
  const id = uid();
  await env.DB.prepare(`INSERT INTO automation_templates (id, name, description, action_json) VALUES (?, ?, ?, ?)`)
    .bind(id, name, (body.description || "").trim().slice(0, 400), JSON.stringify(action)).run();
  const row = await env.DB.prepare(`SELECT * FROM automation_templates WHERE id = ?`).bind(id).first<TemplateRow>();
  return json(request, { template: row ? templateToJson(row) : null });
}

async function updateTemplate(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM automation_templates WHERE id = ?`).bind(id).first<TemplateRow>();
  if (!existing) return json(request, { error: "Template not found." }, 404);
  const body = await request.json() as { name?: string; description?: string; action?: unknown };
  const name = body.name !== undefined ? body.name.trim().slice(0, 120) : existing.name;
  if (!name) return json(request, { error: "A template name is required." }, 400);
  let actionJson = existing.action_json;
  if (body.action !== undefined) {
    const action = sanitizeTemplateAction(body.action);
    if (!action) return json(request, { error: "A valid action (name + https endpoint) is required." }, 400);
    actionJson = JSON.stringify(action);
  }
  const description = body.description !== undefined ? body.description.trim().slice(0, 400) : existing.description;
  await env.DB.prepare(`UPDATE automation_templates SET name = ?, description = ?, action_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, description, actionJson, id).run();
  const row = await env.DB.prepare(`SELECT * FROM automation_templates WHERE id = ?`).bind(id).first<TemplateRow>();
  return json(request, { template: row ? templateToJson(row) : null });
}

async function deleteTemplate(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  await env.DB.prepare(`DELETE FROM automation_templates WHERE id = ?`).bind(id).run();
  return json(request, { deleted: true });
}

async function deployTemplate(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  await ensureAdminSchema(env.DB);
  const template = await env.DB.prepare(`SELECT * FROM automation_templates WHERE id = ?`).bind(id).first<TemplateRow>();
  if (!template) return json(request, { error: "Template not found." }, 404);
  const action = JSON.parse(template.action_json) as AssistantActionDef;

  const body = await request.json() as { target?: "all" | string[] };
  let targetIds: string[];
  if (body.target === "all") {
    const all = await env.DB.prepare(`SELECT id FROM workspaces`).all<{ id: string }>();
    targetIds = (all.results || []).map((w) => w.id);
  } else if (Array.isArray(body.target)) {
    targetIds = body.target.filter((x): x is string => typeof x === "string");
  } else {
    return json(request, { error: "A target ('all' or a list of workspace ids) is required." }, 400);
  }
  if (!targetIds.length) return json(request, { error: "No target workspaces." }, 400);

  const STATE_KEY = "qpy-engage-assistant-actions";
  let deployed = 0;
  for (const workspaceId of targetIds) {
    const scopedKey = `${workspaceId}::${STATE_KEY}`;
    const record = await env.DB.prepare(`SELECT value FROM workspace_state WHERE key = ?`).bind(scopedKey).first<{ value: string }>();
    const currentActions: Array<AssistantActionDef & { templateId?: string }> = record ? JSON.parse(record.value) : [];
    // Idempotent re-deploy: replace a previous deployment of this same template rather than duplicating it.
    const withoutThisTemplate = currentActions.filter((a) => a.templateId !== id);
    const deployedAction = { ...action, templateId: id };
    const nextActions = [...withoutThisTemplate, deployedAction];
    await env.DB.prepare(`INSERT INTO workspace_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
      .bind(scopedKey, JSON.stringify(nextActions)).run();
    deployed++;
  }
  return json(request, { deployed, targetCount: targetIds.length });
}

async function impersonate(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { workspaceId?: string };
  const workspaceId = (body.workspaceId || "").trim();
  if (!workspaceId) return json(request, { error: "Missing workspaceId." }, 400);
  const workspace = await env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>();
  if (!workspace) return json(request, { error: "Workspace not found." }, 404);

  const token = await createSession(env.DB, session.userId, workspaceId, true);
  return json(request, { token, workspace: { id: workspace.id, name: workspace.name } });
}

export async function handleAdminRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/admin/workspaces" && request.method === "GET") return listWorkspaces(request, env);
  if (url.pathname === "/api/admin/impersonate" && request.method === "POST") return impersonate(request, env);
  const workspaceMatch = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)$/);
  if (workspaceMatch && request.method === "PATCH") return updateWorkspace(request, env, workspaceMatch[1]);

  if (url.pathname === "/api/admin/templates" && request.method === "GET") return listTemplates(request, env);
  if (url.pathname === "/api/admin/templates" && request.method === "POST") return createTemplate(request, env);
  const templateMatch = url.pathname.match(/^\/api\/admin\/templates\/([^/]+)$/);
  if (templateMatch && request.method === "PATCH") return updateTemplate(request, env, templateMatch[1]);
  if (templateMatch && request.method === "DELETE") return deleteTemplate(request, env, templateMatch[1]);
  const deployMatch = url.pathname.match(/^\/api\/admin\/templates\/([^/]+)\/deploy$/);
  if (deployMatch && request.method === "POST") return deployTemplate(request, env, deployMatch[1]);

  if (url.pathname === "/api/admin/message-pricing" && request.method === "GET") return listMessagePricing(request, env, true);
  if (url.pathname === "/api/admin/message-pricing" && request.method === "PATCH") return updateMessagePricing(request, env);

  if (url.pathname === "/api/admin/plan-limits" && request.method === "GET") return listPlanLimits(request, env);
  if (url.pathname === "/api/admin/plan-limits" && request.method === "PATCH") return updatePlanLimit(request, env);

  if (url.pathname === "/api/admin/plan-pricing" && request.method === "GET") return listPlanPricing(request, env, true);
  if (url.pathname === "/api/admin/plan-pricing" && request.method === "PATCH") return updatePlanPricing(request, env);

  if (url.pathname === "/api/admin/plan-features" && request.method === "GET") return listPlanFeatures(request, env, true);
  if (url.pathname === "/api/admin/plan-features" && request.method === "PATCH") return updatePlanFeature(request, env);

  if (url.pathname === "/api/admin/integrations/qpy" && request.method === "GET") return getQpyIntegration(request, env);
  if (url.pathname === "/api/admin/integrations/qpy" && request.method === "PATCH") return updateQpyIntegration(request, env);

  return json(request, { error: "Not found" }, 404);
}
