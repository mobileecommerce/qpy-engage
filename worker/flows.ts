import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";
import { getItemsByIds, type ItemsEnv } from "./items";

export interface FlowsEnv extends AuthEnv, ItemsEnv {
  DB: D1Database;
}

function uid(): string {
  return crypto.randomUUID();
}

// ── Types ──

export type FlowStepType = "message" | "buttons" | "text_input" | "number_input" | "date_input" | "yesno" | "items" | "summary" | "end";

export type FlowOption = { id: string; label: string; next: string | null };

export type FlowStep = {
  id: string;
  type: FlowStepType;
  prompt: string;
  variableName?: string;
  options?: FlowOption[]; // buttons, yesno
  itemIds?: string[]; // items
  next?: string | null; // message, text_input, number_input, date_input, items, summary
};

export type FlowDef = {
  id?: string;
  name: string;
  triggerText: string;
  status: "draft" | "active";
  startStepId: string;
  steps: FlowStep[];
};

export type FlowOutMessage =
  | { type: "text"; text: string }
  | { type: "buttons"; text: string; options: { label: string }[] }
  | { type: "items"; text?: string; items: Array<{ name: string; title: string; description: string; price: number; currency: string; imageUrl: string; externalLink: string }> };

const INPUT_STEP_TYPES = new Set<FlowStepType>(["buttons", "text_input", "number_input", "date_input", "yesno"]);
const MAX_STEPS_PER_TURN = 30;

// ── Schema ──

let flowsSchemaEnsured = false;

async function ensureFlowsSchema(db: D1Database): Promise<void> {
  if (flowsSchemaEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      start_step_id TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_flows_workspace ON flows (workspace_id, created_at DESC)`),
    // Tracks where a live widget conversation is inside a flow, across turns.
    db.prepare(`CREATE TABLE IF NOT EXISTS flow_sessions (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      current_step_id TEXT NOT NULL,
      variables_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, session_id)
    )`),
  ]);
  flowsSchemaEnsured = true;
}

// ── CRUD ──

type FlowRow = { id: string; name: string; trigger_text: string; status: string; start_step_id: string; steps_json: string; created_at: string; updated_at: string };

function flowToJson(row: FlowRow): FlowDef & { id: string; createdAt: string; updatedAt: string } {
  return {
    id: row.id, name: row.name, triggerText: row.trigger_text, status: row.status === "active" ? "active" : "draft",
    startStepId: row.start_step_id, steps: JSON.parse(row.steps_json) as FlowStep[],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function sanitizeSteps(input: unknown): FlowStep[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).map((raw): FlowStep | null => {
    const s = raw as Record<string, unknown>;
    const id = String(s.id || uid()).slice(0, 60);
    const typeRaw = String(s.type || "message");
    const type: FlowStepType = (["message", "buttons", "text_input", "number_input", "date_input", "yesno", "items", "summary", "end"] as string[]).includes(typeRaw) ? (typeRaw as FlowStepType) : "message";
    const prompt = String(s.prompt || "").slice(0, 2000);
    const step: FlowStep = { id, type, prompt };
    if (s.variableName) step.variableName = String(s.variableName).trim().slice(0, 60);
    if (Array.isArray(s.options)) {
      step.options = s.options.slice(0, 12).map((o: unknown) => {
        const opt = o as Record<string, unknown>;
        return { id: String(opt.id || uid()).slice(0, 60), label: String(opt.label || "").slice(0, 120), next: opt.next ? String(opt.next) : null };
      });
    }
    if (Array.isArray(s.itemIds)) step.itemIds = s.itemIds.slice(0, 20).map((x: unknown) => String(x));
    if ("next" in s) step.next = s.next ? String(s.next) : null;
    return step;
  }).filter((s): s is FlowStep => s !== null);
}

async function listFlows(request: Request, env: FlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFlowsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM flows WHERE workspace_id = ? ORDER BY created_at DESC`).bind(session.workspaceId).all<FlowRow>();
  return json(request, { flows: (result.results || []).map(flowToJson) });
}

async function createFlow(request: Request, env: FlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFlowsSchema(env.DB);
  const body = await request.json() as Record<string, unknown>;
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) return json(request, { error: "A flow name is required." }, 400);
  const triggerText = String(body.triggerText || "").trim().slice(0, 200);
  const status = body.status === "active" ? "active" : "draft";
  const steps = sanitizeSteps(body.steps);
  const startStepId = String(body.startStepId || steps[0]?.id || "").slice(0, 60);
  const id = uid();
  await env.DB.prepare(`INSERT INTO flows (id, workspace_id, name, trigger_text, status, start_step_id, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, session.workspaceId, name, triggerText, status, startStepId, JSON.stringify(steps)).run();
  const row = await env.DB.prepare(`SELECT * FROM flows WHERE id = ?`).bind(id).first<FlowRow>();
  return json(request, { flow: row ? flowToJson(row) : null });
}

async function updateFlow(request: Request, env: FlowsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFlowsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM flows WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<FlowRow>();
  if (!existing) return json(request, { error: "Flow not found." }, 404);
  const body = await request.json() as Record<string, unknown>;
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 120) : existing.name;
  if (!name) return json(request, { error: "A flow name is required." }, 400);
  const triggerText = body.triggerText !== undefined ? String(body.triggerText).trim().slice(0, 200) : existing.trigger_text;
  const status = body.status !== undefined ? (body.status === "active" ? "active" : "draft") : existing.status;
  const steps = body.steps !== undefined ? sanitizeSteps(body.steps) : (JSON.parse(existing.steps_json) as FlowStep[]);
  const startStepId = body.startStepId !== undefined ? String(body.startStepId).slice(0, 60) : existing.start_step_id;
  await env.DB.prepare(`UPDATE flows SET name = ?, trigger_text = ?, status = ?, start_step_id = ?, steps_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, triggerText, status, startStepId, JSON.stringify(steps), id).run();
  const row = await env.DB.prepare(`SELECT * FROM flows WHERE id = ?`).bind(id).first<FlowRow>();
  return json(request, { flow: row ? flowToJson(row) : null });
}

async function deleteFlow(request: Request, env: FlowsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureFlowsSchema(env.DB);
  await env.DB.prepare(`DELETE FROM flows WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).run();
  await env.DB.prepare(`DELETE FROM flow_sessions WHERE workspace_id = ? AND flow_id = ?`).bind(session.workspaceId, id).run();
  return json(request, { deleted: true });
}

// ── Engine ──

function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => variables[name] ?? "");
}

function findStep(steps: FlowStep[], id: string | null | undefined): FlowStep | null {
  if (!id) return null;
  return steps.find((s) => s.id === id) || null;
}

// Linear steps (message/question/items/summary) chain to whichever step comes next in the
// builder's list by default — the flow builder no longer asks the user to wire this manually.
// An explicit step.next (from an older saved flow, or a deliberate override) still wins if set.
function arrayNext(steps: FlowStep[], stepId: string): string | null {
  const idx = steps.findIndex((s) => s.id === stepId);
  return idx >= 0 ? (steps[idx + 1]?.id ?? null) : null;
}

function validateAndStore(steps: FlowStep[], step: FlowStep, message: string, variables: Record<string, string>): { ok: true; next: string | null } | { ok: false; error: string } {
  const trimmed = message.trim();
  if (step.type === "number_input") {
    if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: "Please reply with a number." };
    if (step.variableName) variables[step.variableName] = trimmed;
    return { ok: true, next: step.next ?? arrayNext(steps, step.id) };
  }
  if (step.type === "date_input") {
    if (!trimmed) return { ok: false, error: "Please provide a date." };
    if (step.variableName) variables[step.variableName] = trimmed;
    return { ok: true, next: step.next ?? arrayNext(steps, step.id) };
  }
  if (step.type === "text_input") {
    if (!trimmed) return { ok: false, error: "Please send a reply." };
    if (step.variableName) variables[step.variableName] = trimmed;
    return { ok: true, next: step.next ?? arrayNext(steps, step.id) };
  }
  if (step.type === "yesno") {
    const lower = trimmed.toLowerCase();
    const isYes = lower === "yes" || lower === "y";
    const isNo = lower === "no" || lower === "n";
    if (!isYes && !isNo) return { ok: false, error: "Please reply Yes or No." };
    if (step.variableName) variables[step.variableName] = isYes ? "Yes" : "No";
    const options = step.options || [];
    const match = options.find((o) => o.label.toLowerCase() === (isYes ? "yes" : "no"));
    return { ok: true, next: match?.next ?? null };
  }
  if (step.type === "buttons") {
    const options = step.options || [];
    const match = options.find((o) => o.label.trim().toLowerCase() === trimmed.toLowerCase());
    if (!match) return { ok: false, error: `Please choose one of: ${options.map((o) => o.label).join(", ")}` };
    if (step.variableName) variables[step.variableName] = match.label;
    return { ok: true, next: match.next ?? null };
  }
  return { ok: true, next: step.next ?? arrayNext(steps, step.id) };
}

async function renderForward(db: D1Database, workspaceId: string, steps: FlowStep[], startId: string | null, variables: Record<string, string>): Promise<{ messages: FlowOutMessage[]; stoppedAt: FlowStep | null; ended: boolean }> {
  const messages: FlowOutMessage[] = [];
  let currentId = startId;
  let guard = 0;
  while (currentId && guard < MAX_STEPS_PER_TURN) {
    guard++;
    const step = findStep(steps, currentId);
    if (!step || step.type === "end") return { messages, stoppedAt: null, ended: true };

    if (INPUT_STEP_TYPES.has(step.type)) {
      if (step.type === "buttons") {
        messages.push({ type: "buttons", text: interpolate(step.prompt, variables), options: (step.options || []).map((o) => ({ label: o.label })) });
      } else if (step.type === "yesno") {
        messages.push({ type: "buttons", text: interpolate(step.prompt, variables), options: [{ label: "Yes" }, { label: "No" }] });
      } else {
        messages.push({ type: "text", text: interpolate(step.prompt, variables) });
      }
      return { messages, stoppedAt: step, ended: false };
    }

    if (step.type === "items") {
      const items = await getItemsByIds(db, workspaceId, step.itemIds || []);
      messages.push({ type: "items", text: step.prompt ? interpolate(step.prompt, variables) : undefined, items: items.map((i) => ({ name: i.name, title: i.title, description: i.description, price: i.price, currency: i.currency, imageUrl: i.imageUrl, externalLink: i.externalLink })) });
      currentId = step.next ?? arrayNext(steps, step.id);
      continue;
    }

    // message, summary
    if (step.prompt) messages.push({ type: "text", text: interpolate(step.prompt, variables) });
    currentId = step.next ?? arrayNext(steps, step.id);
  }
  return { messages, stoppedAt: null, ended: currentId === null };
}

export interface FlowRunResult {
  handled: boolean;
  messages: FlowOutMessage[];
}

// Called from the widget message pipeline before falling back to the AI assistant. Returns
// handled:false if no flow session is active for this visitor and their message doesn't match
// any active flow's trigger phrase — the caller should then proceed with the normal AI reply.
export async function runFlowForWidgetMessage(db: D1Database, workspaceId: string, sessionId: string, message: string): Promise<FlowRunResult> {
  await ensureFlowsSchema(db);
  const existing = await db.prepare(`SELECT flow_id, current_step_id, variables_json FROM flow_sessions WHERE workspace_id = ? AND session_id = ?`)
    .bind(workspaceId, sessionId).first<{ flow_id: string; current_step_id: string; variables_json: string }>();

  if (existing) {
    const flowRow = await db.prepare(`SELECT * FROM flows WHERE id = ? AND workspace_id = ?`).bind(existing.flow_id, workspaceId).first<FlowRow>();
    if (!flowRow) { await db.prepare(`DELETE FROM flow_sessions WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).run(); return { handled: false, messages: [] }; }
    const flow = flowToJson(flowRow);
    const variables = JSON.parse(existing.variables_json) as Record<string, string>;
    const currentStep = findStep(flow.steps, existing.current_step_id);
    if (!currentStep) { await db.prepare(`DELETE FROM flow_sessions WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).run(); return { handled: false, messages: [] }; }

    const validation = validateAndStore(flow.steps, currentStep, message, variables);
    if (!validation.ok) return { handled: true, messages: [{ type: "text", text: validation.error }] };

    const { messages, stoppedAt, ended } = await renderForward(db, workspaceId, flow.steps, validation.next, variables);
    if (ended || !stoppedAt) {
      await db.prepare(`DELETE FROM flow_sessions WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).run();
    } else {
      await db.prepare(`UPDATE flow_sessions SET current_step_id = ?, variables_json = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND session_id = ?`)
        .bind(stoppedAt.id, JSON.stringify(variables), workspaceId, sessionId).run();
    }
    return { handled: true, messages };
  }

  // No active session — check whether this message starts an active flow.
  const activeFlows = await db.prepare(`SELECT * FROM flows WHERE workspace_id = ? AND status = 'active'`).bind(workspaceId).all<FlowRow>();
  const trimmedLower = message.trim().toLowerCase();
  const matched = (activeFlows.results || []).find((f) => f.trigger_text && trimmedLower.includes(f.trigger_text.trim().toLowerCase()));
  if (!matched) return { handled: false, messages: [] };

  const flow = flowToJson(matched);
  const variables: Record<string, string> = {};
  const { messages, stoppedAt, ended } = await renderForward(db, workspaceId, flow.steps, flow.startStepId, variables);
  if (!ended && stoppedAt) {
    await db.prepare(`INSERT INTO flow_sessions (workspace_id, session_id, flow_id, current_step_id, variables_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, session_id) DO UPDATE SET flow_id = excluded.flow_id, current_step_id = excluded.current_step_id, variables_json = excluded.variables_json, updated_at = CURRENT_TIMESTAMP`)
      .bind(workspaceId, sessionId, flow.id, stoppedAt.id, JSON.stringify(variables)).run();
  }
  return { handled: true, messages };
}

// ── Builder-side live test (stateless: the flow may still be an unsaved draft) ──

async function testFlow(request: Request, env: FlowsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { flow?: { startStepId?: string; steps?: unknown }; currentStepId?: string | null; variables?: Record<string, string>; message?: string; reset?: boolean };
  const steps = sanitizeSteps(body.flow?.steps);
  const startStepId = String(body.flow?.startStepId || steps[0]?.id || "");
  const variables = { ...(body.variables || {}) };

  if (body.reset || !body.currentStepId) {
    const { messages, stoppedAt, ended } = await renderForward(env.DB, session.workspaceId, steps, startStepId, variables);
    return json(request, { messages, currentStepId: ended ? null : stoppedAt?.id ?? null, variables, ended });
  }

  const currentStep = findStep(steps, body.currentStepId);
  if (!currentStep) return json(request, { messages: [{ type: "text", text: "This step no longer exists — resetting." }], currentStepId: null, variables, ended: true });
  const validation = validateAndStore(steps, currentStep, body.message || "", variables);
  if (!validation.ok) return json(request, { messages: [{ type: "text", text: validation.error }], currentStepId: currentStep.id, variables, ended: false });
  const { messages, stoppedAt, ended } = await renderForward(env.DB, session.workspaceId, steps, validation.next, variables);
  return json(request, { messages, currentStepId: ended ? null : stoppedAt?.id ?? null, variables, ended });
}

export async function handleFlowsRequest(request: Request, env: FlowsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/flows")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/flows" && request.method === "GET") return listFlows(request, env);
  if (url.pathname === "/api/flows" && request.method === "POST") return createFlow(request, env);
  if (url.pathname === "/api/flows/test" && request.method === "POST") return testFlow(request, env);
  const match = url.pathname.match(/^\/api\/flows\/([^/]+)$/);
  if (match && request.method === "PATCH") return updateFlow(request, env, match[1]);
  if (match && request.method === "DELETE") return deleteFlow(request, env, match[1]);
  return json(request, { error: "Not found" }, 404);
}
