export const MESSAGE_CATEGORIES = ["Marketing", "Utility", "Authentication", "Service"];
export const WORKSPACE_PLANS = ["Free", "Starter", "Growth", "Scale", "Enterprise"];

const DEFAULT_PLAN_LIMITS: Record<string, Record<string, number>> = {
  Free: { Marketing: 100, Utility: 100, Authentication: 100, Service: 1000 },
  Starter: { Marketing: 1000, Utility: 1000, Authentication: 1000, Service: 5000 },
  Growth: { Marketing: 5000, Utility: 5000, Authentication: 5000, Service: 20000 },
  Scale: { Marketing: 20000, Utility: 20000, Authentication: 20000, Service: 100000 },
  Enterprise: { Marketing: 100000, Utility: 100000, Authentication: 100000, Service: 1000000 },
};

// Isolate-level caches so these schema/seed checks run once per Worker isolate, not on every
// request (both are hit by polled endpoints like /api/credits — see the same pattern in widget.ts).
let messageBalanceSchemaEnsured = false;
let planLimitsSeeded = false;

export async function ensureMessageBalanceSchema(db: D1Database): Promise<void> {
  if (messageBalanceSchemaEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_message_balance (
      workspace_id TEXT NOT NULL,
      category TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, category)
    )`),
    // Lifetime count of real messages actually sent per category (across campaigns, OTP, and
    // inbox replies) — separate from the balance, which only ever decreases. Powers the "sent
    // this workspace" usage figures.
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_message_sent (
      workspace_id TEXT NOT NULL,
      category TEXT NOT NULL,
      sent_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, category)
    )`),
  ]);
  messageBalanceSchemaEnsured = true;
}

export async function ensurePlanLimitsSchema(db: D1Database): Promise<void> {
  if (planLimitsSeeded) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS plan_limits (
    plan TEXT NOT NULL,
    category TEXT NOT NULL,
    message_limit INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (plan, category)
  )`).run();
  const existing = await db.prepare(`SELECT plan, category FROM plan_limits`).all<{ plan: string; category: string }>();
  const have = new Set((existing.results || []).map((r) => `${r.plan}::${r.category}`));
  const missing: Array<[string, string, number]> = [];
  for (const plan of WORKSPACE_PLANS) {
    for (const category of MESSAGE_CATEGORIES) {
      if (!have.has(`${plan}::${category}`)) missing.push([plan, category, DEFAULT_PLAN_LIMITS[plan][category]]);
    }
  }
  if (missing.length) {
    await db.batch(missing.map(([plan, category, limit]) => db.prepare(`INSERT INTO plan_limits (plan, category, message_limit) VALUES (?, ?, ?)`).bind(plan, category, limit)));
  }
  planLimitsSeeded = true;
}

export async function getMessageBalances(db: D1Database, workspaceId: string): Promise<Record<string, number>> {
  await ensureMessageBalanceSchema(db);
  const result = await db.prepare(`SELECT category, message_count as messageCount FROM workspace_message_balance WHERE workspace_id = ?`)
    .bind(workspaceId).all<{ category: string; messageCount: number }>();
  const balances: Record<string, number> = Object.fromEntries(MESSAGE_CATEGORIES.map((c) => [c, 0]));
  for (const row of result.results || []) balances[row.category] = row.messageCount;
  return balances;
}

export async function getSentCounts(db: D1Database, workspaceId: string): Promise<Record<string, number>> {
  await ensureMessageBalanceSchema(db);
  const result = await db.prepare(`SELECT category, sent_count as sentCount FROM workspace_message_sent WHERE workspace_id = ?`)
    .bind(workspaceId).all<{ category: string; sentCount: number }>();
  const sent: Record<string, number> = Object.fromEntries(MESSAGE_CATEGORIES.map((c) => [c, 0]));
  for (const row of result.results || []) sent[row.category] = row.sentCount;
  return sent;
}

// Records that `count` real messages of `category` actually went out. Best-effort — callers
// `.catch()` this so a usage-counter hiccup never fails the actual send.
export async function incrementSentCount(db: D1Database, workspaceId: string, category: string, count: number): Promise<void> {
  if (count <= 0) return;
  await ensureMessageBalanceSchema(db);
  await db.prepare(`INSERT INTO workspace_message_sent (workspace_id, category, sent_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, category) DO UPDATE SET sent_count = sent_count + excluded.sent_count, updated_at = CURRENT_TIMESTAMP`)
    .bind(workspaceId, category, count).run();
}

export async function getPlanLimits(db: D1Database, plan: string): Promise<Record<string, number>> {
  await ensurePlanLimitsSchema(db);
  const result = await db.prepare(`SELECT category, message_limit as messageLimit FROM plan_limits WHERE plan = ?`).bind(plan).all<{ category: string; messageLimit: number }>();
  const limits: Record<string, number> = Object.fromEntries(MESSAGE_CATEGORIES.map((c) => [c, 0]));
  for (const row of result.results || []) limits[row.category] = row.messageLimit;
  return limits;
}

/**
 * Attempts to subtract `messages` from a workspace's balance in `category`. Rejects (no write)
 * if the balance is insufficient, so callers can treat this as a real prepaid gate.
 */
export async function deductMessageBalance(db: D1Database, workspaceId: string, category: string, messages: number): Promise<{ ok: true; balances: Record<string, number> } | { ok: false; error: string }> {
  const balances = await getMessageBalances(db, workspaceId);
  if (balances[category] < messages) {
    return { ok: false, error: `Not enough ${category} message credits. You have ${balances[category].toLocaleString()}, this needs ${messages.toLocaleString()}.` };
  }
  const next = balances[category] - messages;
  await db.prepare(`INSERT INTO workspace_message_balance (workspace_id, category, message_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, category) DO UPDATE SET message_count = excluded.message_count, updated_at = CURRENT_TIMESTAMP`)
    .bind(workspaceId, category, next).run();
  return { ok: true, balances: { ...balances, [category]: next } };
}

/**
 * Soft meter: decrements a category's balance by `messages`, flooring at 0, and NEVER blocks —
 * used for reactive messages (WhatsApp 24h-window service replies) where refusing to send would
 * harm live customer support. Contrast with deductMessageBalance's hard gate, which is right for
 * proactive sends (campaigns, OTP) where "you can't send more than you bought" is the intended
 * behavior. Best-effort: callers typically `.catch()` this so a metering hiccup never fails the
 * actual reply.
 */
export async function meterMessageBalance(db: D1Database, workspaceId: string, category: string, messages = 1): Promise<void> {
  const balances = await getMessageBalances(db, workspaceId);
  const next = Math.max(0, balances[category] - messages);
  if (next === balances[category]) return; // already at 0 — nothing to decrement
  await db.prepare(`INSERT INTO workspace_message_balance (workspace_id, category, message_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, category) DO UPDATE SET message_count = excluded.message_count, updated_at = CURRENT_TIMESTAMP`)
    .bind(workspaceId, category, next).run();
}

/**
 * Tops up a workspace's message balance so each category is at least the plan's included
 * quota. Never reduces an existing higher balance (e.g. from a prior real purchase), and only
 * writes the categories that actually need topping up.
 */
export async function grantPlanMessages(db: D1Database, workspaceId: string, plan: string): Promise<void> {
  const limits = await getPlanLimits(db, plan);
  const current = await getMessageBalances(db, workspaceId);
  const updates: Array<[string, number]> = [];
  for (const category of MESSAGE_CATEGORIES) {
    if (current[category] < limits[category]) updates.push([category, limits[category]]);
  }
  if (!updates.length) return;
  await db.batch(updates.map(([category, value]) => db.prepare(`INSERT INTO workspace_message_balance (workspace_id, category, message_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, category) DO UPDATE SET message_count = excluded.message_count, updated_at = CURRENT_TIMESTAMP`).bind(workspaceId, category, value)));
}
