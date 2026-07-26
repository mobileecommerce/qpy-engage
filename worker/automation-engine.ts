import { callClaude, callClaudeWithActions, sanitizeActions, type ChatMessage, type AssistantActionDef, type CatalogItemRef } from "./shared";
import { readWorkspaceState, buildSystemPrompt } from "./widget";
import { listItemsForWorkspace, getItemsByIds } from "./items";
import { toGraph, interpolate, buildUrlFromTemplate, type AutomationGraph, type AutomationNode, type NodeConfig } from "./automation-graph";
import { loadSession, saveSession, clearCursor } from "./automation-session";
import { receivedKeysAtNode } from "./documents";

export interface EngineEnv { DB: D1Database; ANTHROPIC_API_KEY?: string }

export type AutomationRow = { id: string; name: string; sector_key: string; status: string; priority: number; needs_config: number; flow_json: string; created_at: string; updated_at: string };

function sqliteNow(): string { return new Date().toISOString().slice(0, 19).replace("T", " "); }

export type AutomationOutMessage =
  | { type: "text"; text: string }
  | { type: "buttons"; text: string; options: { label: string; description?: string }[] }
  | { type: "upload"; text: string; nodeId: string; documents: { key: string; label: string; accept: string[]; maxMb: number; required: boolean; received: boolean }[] }
  | { type: "items"; text?: string; items: Array<{ id: string; name: string; title: string; description: string; price: number; currency: string; imageUrl: string; externalLink: string }> };

export type RunChannel = "webchat" | "whatsapp";
export interface RunCtx {
  channel: RunChannel;
  contactKey: string;            // widget session_id, or the customer's WhatsApp number
  phoneNumberId?: string;        // whatsapp only — persisted so a resumed wait can still deliver
  deliver: (text: string) => Promise<boolean>;
  persistConversationState: boolean; // web chat has an Inbox surface for tags/escalation; whatsapp doesn't (yet)
}

export interface AutomationRunResult { handled: boolean; messages: AutomationOutMessage[]; automationName?: string; branchLabel?: string }

// A cycle in the graph (e.g. a "Main menu" button pointing back to the top) is a legitimate,
// intentional design — so instead of forbidding cycles, cap how many nodes one incoming message can
// traverse. Any real path to the next customer prompt is far shorter than this.
const MAX_NODES_PER_TURN = 40;

function withLinkParams<T extends { externalLink: string }>(items: T[], linkParams?: Record<string, string>): T[] {
  if (!linkParams || !Object.keys(linkParams).length) return items;
  return items.map((item) => {
    if (!item.externalLink) return item;
    try {
      const url = new URL(item.externalLink);
      for (const [k, v] of Object.entries(linkParams)) url.searchParams.set(k, v);
      return { ...item, externalLink: url.toString() };
    } catch { return item; }
  });
}

// ── Rule evaluation for split nodes (now N-way, was binary) ──

function withinTimeWindow(activeDays: string[] | undefined, startTime: string | undefined, endTime: string | undefined, now: Date): boolean {
  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const today = dayKeys[now.getUTCDay()];
  if (activeDays && activeDays.length && !activeDays.includes(today)) return false;
  if (!startTime || !endTime) return true;
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  return minutesNow >= sh * 60 + sm && minutesNow <= eh * 60 + em;
}

export async function evaluateSplit(db: D1Database, workspaceId: string, automationId: string, node: AutomationNode, message: string, contactKey: string): Promise<{ next: string | null; label: string }> {
  const cfg = node.config || {};
  const cases = cfg.cases || [];
  const fallback = { next: cfg.fallbackNext ?? null, label: "Otherwise" };
  const ruleType = cfg.ruleType || "conditional";

  if (ruleType === "conditional") {
    const lower = message.toLowerCase();
    for (const k of cases) {
      const keywords = (k.match || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (keywords.some((kw) => lower.includes(kw))) return { next: k.next, label: k.label };
    }
    return fallback;
  }
  if (ruleType === "ab") {
    // Weighted pick across all cases; any leftover probability falls through to the fallback.
    const roll = Math.random() * 100;
    let acc = 0;
    for (const k of cases) { acc += k.weight ?? (100 / Math.max(1, cases.length)); if (roll < acc) return { next: k.next, label: k.label }; }
    return fallback;
  }
  if (ruleType === "time") {
    if (withinTimeWindow(cfg.activeDays, cfg.startTime, cfg.endTime, new Date()) && cases[0]) return { next: cases[0].next, label: cases[0].label };
    return fallback;
  }
  if (ruleType === "freq") {
    const max = cfg.freqMax ?? 3;
    const periodMs = cfg.freqPeriod === "hour" ? 3600_000 : cfg.freqPeriod === "week" ? 7 * 86400_000 : 86400_000;
    const since = new Date(Date.now() - periodMs).toISOString().slice(0, 19).replace("T", " ");
    const count = await db.prepare(`SELECT COUNT(*) as c FROM automation_sends WHERE workspace_id = ? AND automation_id = ? AND contact_key = ? AND sent_at > ?`)
      .bind(workspaceId, automationId, contactKey, since).first<{ c: number }>();
    if ((count?.c || 0) < max && cases[0]) return { next: cases[0].next, label: cases[0].label };
    return fallback;
  }
  return fallback;
}

// ── Input validation for `question` nodes ──

function validateInput(value: string, type: string | undefined): { ok: true; value: string } | { ok: false; error: string } {
  const v = value.trim();
  if (!v) return { ok: false, error: "Please send a value so I can continue." };
  if (type === "number") {
    const n = Number(v.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "Please reply with just a number." };
    return { ok: true, value: String(n) };
  }
  if (type === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, error: "That doesn't look like an email address — could you check it?" };
    return { ok: true, value: v };
  }
  if (type === "phone") {
    if (v.replace(/[^\d]/g, "").length < 7) return { ok: false, error: "That doesn't look like a phone number — could you check it?" };
    return { ok: true, value: v };
  }
  if (type === "date") {
    // Deliberately permissive: businesses' customers write dates every imaginable way, and the
    // downstream link/AI handles the real formatting. We only reject something with no date-like
    // content at all rather than pretending to parse every locale.
    if (!/\d/.test(v)) return { ok: false, error: "Could you give me a date? For example 12/08/2026." };
    return { ok: true, value: v };
  }
  return { ok: true, value: v };
}

// ── Collect & Link instructions for AI nodes (unchanged behaviour, now node-scoped) ──

function buildCollectLinkInstructions(cfg: NodeConfig | undefined): string {
  const flows = (cfg?.collectFlows || []).filter((f) => f.name.trim() && f.fields.filter((x) => x.key && x.label).length && f.urlTemplate.trim());
  if (!flows.length) return "";
  const flowBlocks = flows.map((flow) => {
    const fields = flow.fields.filter((f) => f.key && f.label);
    const order = fields.map((f, i) => `${i + 1}) ${f.label}`).join(", ");
    const keys = fields.map((f) => f.key).join(", ");
    return `Flow "${flow.name}": ask for these details ONE AT A TIME, in this exact order, waiting for their answer each time (never ask for more than one thing per message): ${order}. `
      + `After collecting all of this, in the SAME response that you summarize the details back to the customer and ask "Is that correct?", you MUST also call the set_link_params tool with these exact keys: ${keys}. Call it every time you show this summary, even before they've confirmed. `
      + `Once they confirm, you MUST also call the show_items tool in that same response to display the relevant catalog items as cards for the "${flow.name}" flow specifically — do not mix in items from a different flow.`;
  }).join("\n\n");
  const intro = flows.length > 1
    ? `This business handles ${flows.length} distinct kinds of requests, each with its own separate process below. First work out which one the customer means (ask a clarifying question if it's genuinely ambiguous), then follow ONLY that flow's instructions — never combine fields or items from two different flows in the same exchange.\n\n`
    : "";
  return `\n\n${intro}${flowBlocks}\n\nIn every case: never write a reply that says you're showing, pulling together, or providing options unless you are actually calling show_items in that exact response, every single time, with no exceptions. Do not describe the items yourself in text, and do NOT paste any link in your text reply — pass the same linkParams to show_items too, so each card's own button reflects the customer's exact request.`;
}

function looksAffirmative(text: string): boolean {
  return /^\s*(yes|yeah|yep|yup|correct|that'?s correct|that is correct|confirmed|sounds good|perfect|right|ok|okay|looks? good|that works)\b/i.test((text || "").trim());
}

// ── Node execution ──

type NodeOutcome =
  | { control: "next"; next: string | null; label?: string }
  | { control: "await" }
  | { control: "waiting" }
  | { control: "end" };

type ExecCtx = {
  env: EngineEnv; workspaceId: string; ctx: RunCtx; automation: AutomationRow;
  history: ChatMessage[]; out: AutomationOutMessage[];
  vars: Record<string, string>;
};

async function sendText(x: ExecCtx, text: string): Promise<void> {
  x.out.push({ type: "text", text });
  await x.ctx.deliver(text);
  await x.env.DB.prepare(`INSERT INTO automation_sends (workspace_id, automation_id, contact_key) VALUES (?, ?, ?)`)
    .bind(x.workspaceId, x.automation.id, x.ctx.contactKey).run();
}

async function resolveItems(x: ExecCtx, itemIds: string[], urlTemplate?: string): Promise<AutomationOutMessage | null> {
  const items = await getItemsByIds(x.env.DB, x.workspaceId, itemIds);
  if (!items.length) return null;
  if (urlTemplate && urlTemplate.trim()) {
    // A per-node URL template wins: it builds each card's link from the variables collected in this
    // very conversation, by code, rather than trusting a model to reproduce a URL as text.
    const built = buildUrlFromTemplate(urlTemplate, x.vars);
    return { type: "items", items: items.map((it) => ({ ...it, externalLink: built })) };
  }
  return { type: "items", items: withLinkParams(items, x.vars) };
}

async function executeNode(x: ExecCtx, node: AutomationNode): Promise<NodeOutcome> {
  const cfg = node.config || {};

  switch (node.kind) {
    case "trigger":
      return { control: "next", next: node.next ?? null };

    case "message":
      await sendText(x, interpolate(cfg.messageText || node.subtitle || "", x.vars));
      return { control: "next", next: node.next ?? null };

    case "buttons": {
      const text = interpolate(cfg.messageText || node.title, x.vars);
      // The widget renders real tappable buttons from this message type. WhatsApp's text-only
      // delivery gets a numbered fallback so the same node still works there — the customer can
      // reply with the number or the label, and both match in resolveInputAt().
      const options = (cfg.options || []).map((o) => ({ label: o.label, description: o.description }));
      x.out.push({ type: "buttons", text, options });
      const flat = options.length ? `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}` : text;
      await x.ctx.deliver(flat);
      return { control: "await" };
    }

    case "question":
      await sendText(x, interpolate(cfg.messageText || node.title, x.vars));
      return { control: "await" };

    case "upload": {
      const specs = cfg.documents || [];
      const received = await receivedKeysAtNode(x.env.DB, x.workspaceId, x.ctx.contactKey, node.id);
      x.out.push({
        type: "upload", text: interpolate(cfg.messageText || node.title, x.vars), nodeId: node.id,
        documents: specs.map((d) => ({ ...d, received: received.has(d.key) })),
      });
      // WhatsApp has no upload widget — the customer just sends the file into the chat — so it gets
      // a plain-text checklist naming each document and the formats we can accept.
      if (!x.ctx.persistConversationState) {
        const lines = specs.map((d) => {
          const mark = received.has(d.key) ? "✅" : "•";
          return `${mark} ${d.label} (${d.accept.join(", ").toUpperCase()}, max ${d.maxMb} MB)${d.required ? "" : " — optional"}`;
        });
        await x.ctx.deliver(`${interpolate(cfg.messageText || node.title, x.vars)}\n\n${lines.join("\n")}\n\nPlease send each one as a photo or document in this chat.`);
      }
      return { control: "await" };
    }

    case "items": {
      const msg = await resolveItems(x, cfg.itemIds || [], cfg.urlTemplate);
      if (cfg.messageText) await sendText(x, interpolate(cfg.messageText, x.vars));
      if (msg) {
        x.out.push(msg);
        // Cards are interactive in the widget but invisible over plain text, so WhatsApp gets a
        // readable text rendering of the same items rather than silently nothing.
        if (msg.type === "items" && !x.ctx.persistConversationState) {
          await x.ctx.deliver(msg.items.map((it) => `${it.title || it.name}${it.externalLink ? `\n${it.externalLink}` : ""}`).join("\n\n"));
        }
      }
      return { control: "next", next: node.next ?? null };
    }

    case "aiReply":
    case "aiAction": {
      if (!x.env.ANTHROPIC_API_KEY) {
        await sendText(x, "Our assistant isn't fully configured yet — a team member will follow up shortly.");
        return { control: "next", next: node.next ?? null };
      }
      const actionHint = node.kind === "aiAction" && cfg.aiActionName ? `\n\nIf relevant, use the "${cfg.aiActionName}" tool to help answer this.` : "";
      // Search the crawled site against what the customer just asked, so an AI reply node inside an
      // automation grounds on the right page rather than the start of the site.
      const askedNow = [...x.history].reverse().find((m) => m.role === "user")?.content || "";
      const systemPrompt = (await buildSystemPrompt(x.env.DB, x.workspaceId, askedNow)) + actionHint + buildCollectLinkInstructions(cfg);
      const storedActions = node.kind === "aiAction"
        ? (await readWorkspaceState<unknown[]>(x.env.DB, x.workspaceId, "qpy-engage-assistant-actions")) || []
        : [];
      const actions: AssistantActionDef[] = node.kind === "aiAction"
        ? sanitizeActions(storedActions).filter((a) => a.name.toLowerCase() === (cfg.aiActionName || "").toLowerCase())
        : [];

      const allItems = await listItemsForWorkspace(x.env.DB, x.workspaceId);
      const scoped = [...new Set([...(cfg.itemIds || []), ...(cfg.collectFlows || []).flatMap((f) => f.itemIds || [])])];
      const catalogItems: CatalogItemRef[] = scoped.length ? allItems.filter((it) => scoped.includes(it.id)) : allItems;

      let shownIds: string[] = [];
      let shownParams: Record<string, string> | undefined;
      const onShow = async (ids: string[], p?: Record<string, string>) => { shownIds = ids; shownParams = p; };
      // Variables collected by the AI are written into the same session store the deterministic
      // `question` node uses, so both styles of collection feed one set of values.
      const onSetParams = async (p: Record<string, string>) => { Object.assign(x.vars, p); };

      const result = (catalogItems.length || actions.length)
        ? await callClaudeWithActions(x.env.ANTHROPIC_API_KEY, systemPrompt, x.history, actions, undefined, undefined, undefined, catalogItems, onShow, onSetParams)
        : await callClaude(x.env.ANTHROPIC_API_KEY, systemPrompt, x.history);

      if (shownParams) Object.assign(x.vars, shownParams);

      // Same failure mode guarded before: the model can promise options in prose without actually
      // calling show_items. If the customer just confirmed and we already hold real collected
      // values, show the node's items rather than leaving the promise empty.
      let fallback: AutomationOutMessage | null = null;
      if (!shownIds.length && catalogItems.length && Object.keys(x.vars).length) {
        const lastUser = x.history[x.history.length - 1];
        if (lastUser?.role === "user" && looksAffirmative(lastUser.content)) {
          fallback = await resolveItems(x, catalogItems.map((it) => it.id), cfg.urlTemplate);
        }
      }

      await sendText(x, result.reply || (fallback ? "Here are some options that might work for you — tap a card's button to see more and continue." : "Thanks for reaching out — a team member will follow up shortly."));
      if (shownIds.length) {
        const msg = await resolveItems(x, shownIds, cfg.urlTemplate);
        if (msg) x.out.push(msg);
      } else if (fallback) {
        x.out.push(fallback);
      }
      // AI nodes are conversational: stay parked here so following messages keep reaching the
      // assistant, unless the business explicitly wired a next node.
      return node.next ? { control: "next", next: node.next } : { control: "await" };
    }

    case "split": {
      const lastUser = x.history[x.history.length - 1];
      const decided = await evaluateSplit(x.env.DB, x.workspaceId, x.automation.id, node, lastUser?.content || "", x.ctx.contactKey);
      return { control: "next", next: decided.next, label: decided.label };
    }

    case "tag": {
      if (!x.ctx.persistConversationState) return { control: "next", next: node.next ?? null };
      try { await x.env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN tags TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
      const existing = await x.env.DB.prepare(`SELECT tags FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`).bind(x.workspaceId, x.ctx.contactKey).first<{ tags: string }>();
      const tags = new Set((existing?.tags || "").split(",").map((t) => t.trim()).filter(Boolean));
      if (cfg.tagName) tags.add(cfg.tagName);
      await x.env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, tags) VALUES (?, ?, ?)
        ON CONFLICT(workspace_id, session_id) DO UPDATE SET tags = excluded.tags`).bind(x.workspaceId, x.ctx.contactKey, [...tags].join(",")).run();
      return { control: "next", next: node.next ?? null };
    }

    case "escalate": {
      if (!x.ctx.persistConversationState) return { control: "next", next: node.next ?? null };
      try { await x.env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN queue_name TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
      try { await x.env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN queue_priority TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
      await x.env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, needs_attention, attention_reason, queue_name, queue_priority) VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(workspace_id, session_id) DO UPDATE SET needs_attention = 1, attention_reason = excluded.attention_reason, queue_name = excluded.queue_name, queue_priority = excluded.queue_priority`)
        .bind(x.workspaceId, x.ctx.contactKey, `Automation: ${x.automation.name}`, cfg.escalateQueue || "Support queue", cfg.escalatePriority || "Normal").run();
      return { control: "next", next: node.next ?? null };
    }

    case "notify": {
      const settings = await readWorkspaceState<{ slackWebhookUrl?: string }>(x.env.DB, x.workspaceId, "qpy-engage-automation-settings");
      if ((cfg.notifyChannels || []).includes("slack") && settings?.slackWebhookUrl) {
        try {
          await fetch(settings.slackWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[${x.automation.name}] ${node.subtitle || node.title}` }) });
        } catch { /* best-effort */ }
      }
      // Email delivery still requires a provider this project has no credentials for; the intent is
      // recorded in the Activity log rather than pretending a message went out.
      return { control: "next", next: node.next ?? null };
    }

    case "wait":
      return { control: "waiting" };

    case "end":
      return { control: "end" };
  }
  return { control: "next", next: node.next ?? null };
}

// ── Resolving an incoming message against the node the customer is parked at ──

type Resolution = { startId: string | null; reprompt: AutomationNode | null; error?: string };

async function resolveInputAt(x: ExecCtx, node: AutomationNode, message: string, vars: Record<string, string>): Promise<Resolution> {
  const cfg = node.config || {};
  const text = (message || "").trim();

  // An upload step advances on documents arriving, not on anything the customer types. Whatever
  // they send while documents are still outstanding gets the checklist back, naming exactly what is
  // still missing rather than repeating the whole request.
  if (node.kind === "upload") {
    const specs = cfg.documents || [];
    const received = await receivedKeysAtNode(x.env.DB, x.workspaceId, x.ctx.contactKey, node.id);
    const outstanding = specs.filter((d) => d.required && !received.has(d.key));
    if (!outstanding.length) {
      if (cfg.variableKey) vars[cfg.variableKey] = specs.filter((d) => received.has(d.key)).map((d) => d.label).join(", ");
      return { startId: node.next ?? null, reprompt: null };
    }
    return { startId: null, reprompt: node, error: `Still needed: ${outstanding.map((d) => d.label).join(", ")}.` };
  }

  if (node.kind === "buttons") {
    const options = cfg.options || [];
    const lower = text.toLowerCase();
    let hit = options.find((o) => o.label.trim().toLowerCase() === lower);
    if (!hit) {
      // WhatsApp (and anyone typing rather than tapping) can answer with the option's number.
      const asNumber = Number(text);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) hit = options[asNumber - 1];
    }
    if (!hit) hit = options.find((o) => lower.length > 2 && o.label.toLowerCase().includes(lower));
    if (hit) return { startId: hit.next, reprompt: null };
    if (cfg.fallbackNext) return { startId: cfg.fallbackNext, reprompt: null };
    return { startId: null, reprompt: node, error: "Sorry, I didn't catch that — please pick one of the options below." };
  }

  if (node.kind === "question") {
    const check = validateInput(text, cfg.inputType);
    if (!check.ok) return { startId: null, reprompt: node, error: check.error };
    if (cfg.variableKey) vars[cfg.variableKey] = check.value;
    return { startId: node.next ?? null, reprompt: null };
  }

  // AI nodes: re-run the node itself so the assistant handles this message.
  if (node.kind === "aiReply" || node.kind === "aiAction") return { startId: node.id, reprompt: null };

  return { startId: node.next ?? null, reprompt: null };
}

// ── The walk ──

async function walkFrom(x: ExecCtx, graph: AutomationGraph, startId: string | null): Promise<{ cursor: string | null; waiting: boolean; visited: AutomationNode[]; label: string }> {
  const visited: AutomationNode[] = [];
  let label = "";
  let currentId = startId;
  let guard = 0;

  while (currentId && guard++ < MAX_NODES_PER_TURN) {
    const node = graph.nodes[currentId];
    if (!node) break;
    visited.push(node);
    const outcome = await executeNode(x, node);
    if (outcome.control === "await") return { cursor: node.id, waiting: false, visited, label };
    if (outcome.control === "end") return { cursor: null, waiting: false, visited, label };
    if (outcome.control === "waiting") {
      const amount = node.config?.waitAmount ?? 1;
      const unit = node.config?.waitUnit ?? "hours";
      const ms = unit === "minutes" ? amount * 60_000 : unit === "days" ? amount * 86_400_000 : amount * 3_600_000;
      const dueAt = new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");
      await x.env.DB.prepare(`INSERT INTO automation_waits (workspace_id, automation_id, session_id, contact_key, channel, phone_number_id, resume_path, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(x.workspaceId, x.automation.id, x.ctx.contactKey, x.ctx.contactKey, x.ctx.channel, x.ctx.phoneNumberId || "", JSON.stringify({ nodeId: node.next ?? null }), dueAt).run();
      return { cursor: null, waiting: true, visited, label };
    }
    if (outcome.label) label = label ? `${label} → ${outcome.label}` : outcome.label;
    currentId = outcome.next;
  }
  return { cursor: null, waiting: false, visited, label };
}

// ── Entry point, shared by web chat and WhatsApp ──

export async function runAutomations(env: EngineEnv, workspaceId: string, channel: RunChannel, ctx: RunCtx, message: string, history: ChatMessage[]): Promise<AutomationRunResult> {
  const result = await env.DB.prepare(`SELECT * FROM automations2 WHERE workspace_id = ? AND status = 'active' ORDER BY priority ASC`).bind(workspaceId).all<AutomationRow>();
  const rows = result.results || [];
  if (!rows.length) return { handled: false, messages: [] };

  const session = await loadSession(env.DB, workspaceId, ctx.contactKey);
  const vars: Record<string, string> = { ...(session?.variables || {}) };

  // A live cursor pins the conversation to the automation it belongs to, so a mid-flow reply can
  // never be re-classified into a different automation (or a different branch of the same one).
  let automation = session?.nodeId ? rows.find((r) => r.id === session.automationId) : undefined;
  const resuming = Boolean(automation);
  if (!automation) {
    automation = rows.find((r) => (toGraph(JSON.parse(r.flow_json)).nodes[toGraph(JSON.parse(r.flow_json)).entryId]?.config?.channels || []).includes(channel));
  }
  if (!automation) return { handled: false, messages: [] };

  const graph = toGraph(JSON.parse(automation.flow_json));
  const out: AutomationOutMessage[] = [];
  const x: ExecCtx = { env, workspaceId, ctx, automation, history, out, vars };

  let startId: string | null;
  if (resuming && session?.nodeId && graph.nodes[session.nodeId]) {
    const parked = graph.nodes[session.nodeId];
    const res = await resolveInputAt(x, parked, message, vars);
    if (res.reprompt) {
      // Invalid answer: say why, re-ask the same node, and stay parked there.
      if (res.error) await sendText(x, res.error);
      await executeNode(x, res.reprompt);
      await saveSession(env.DB, workspaceId, ctx.contactKey, { automationId: automation.id, nodeId: parked.id, variables: vars });
      return { handled: true, messages: out, automationName: automation.name, branchLabel: parked.title };
    }
    startId = res.startId;
  } else {
    startId = graph.entryId;
  }

  const walk = await walkFrom(x, graph, startId);

  if (walk.cursor) await saveSession(env.DB, workspaceId, ctx.contactKey, { automationId: automation.id, nodeId: walk.cursor, variables: vars });
  else await clearCursor(env.DB, workspaceId, ctx.contactKey, vars);

  if (!walk.visited.length && !out.length) return { handled: false, messages: [] };

  // Report what actually happened rather than always crediting the AI: a deterministic menu tree can
  // run start to finish without any model call, and labelling that "Resolved by AI" would be a lie.
  const escalated = walk.visited.some((n) => n.kind === "escalate");
  const usedAi = walk.visited.some((n) => n.kind === "aiReply" || n.kind === "aiAction");
  const outcome = walk.waiting ? "Waiting"
    : escalated ? "Escalated"
    : walk.cursor ? "Awaiting reply"
    : usedAi ? "Resolved by AI"
    : "Completed";
  const branchLabel = walk.label || walk.visited[walk.visited.length - 1]?.title || "—";
  await env.DB.prepare(`INSERT INTO automation_runs (workspace_id, automation_id, automation_name, contact, channel, branch_label, outcome, outcome_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(workspaceId, automation.id, automation.name, ctx.contactKey.slice(0, 14), channel === "whatsapp" ? "WhatsApp" : "Web chat", branchLabel, outcome, escalated ? "warn" : "good").run();

  return { handled: true, messages: out, automationName: automation.name, branchLabel };
}

export async function runAutomationsForWidgetMessage(env: EngineEnv, workspaceId: string, sessionId: string, message: string, history: ChatMessage[]): Promise<AutomationRunResult> {
  const ctx: RunCtx = {
    channel: "webchat",
    contactKey: sessionId,
    persistConversationState: true,
    deliver: async (text: string) => {
      await env.DB.prepare(`INSERT INTO widget_messages (workspace_id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`).bind(workspaceId, sessionId, text, sqliteNow()).run();
      return true;
    },
  };
  return runAutomations(env, workspaceId, "webchat", ctx, message, history);
}

// Called after a document lands, so the conversation moves on the moment the last required file is
// in — the customer should not have to type "done" to continue a step they have already finished.
// Returns null when documents are still outstanding, leaving the cursor where it is.
export async function continueAfterUpload(env: EngineEnv, workspaceId: string, channel: RunChannel, ctx: RunCtx): Promise<AutomationRunResult | null> {
  const session = await loadSession(env.DB, workspaceId, ctx.contactKey);
  if (!session?.nodeId || !session.automationId) return null;

  const automation = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ? AND workspace_id = ?`)
    .bind(session.automationId, workspaceId).first<AutomationRow>();
  if (!automation) return null;

  const graph = toGraph(JSON.parse(automation.flow_json));
  const node = graph.nodes[session.nodeId];
  if (!node || node.kind !== "upload") return null;

  const specs = node.config?.documents || [];
  const received = await receivedKeysAtNode(env.DB, workspaceId, ctx.contactKey, node.id);
  if (specs.some((d) => d.required && !received.has(d.key))) return null;

  const vars = { ...(session.variables || {}) };
  if (node.config?.variableKey) vars[node.config.variableKey] = specs.filter((d) => received.has(d.key)).map((d) => d.label).join(", ");

  const out: AutomationOutMessage[] = [];
  const x: ExecCtx = { env, workspaceId, ctx, automation, history: [], out, vars };
  const walk = await walkFrom(x, graph, node.next ?? null);
  if (walk.cursor) await saveSession(env.DB, workspaceId, ctx.contactKey, { automationId: automation.id, nodeId: walk.cursor, variables: vars });
  else await clearCursor(env.DB, workspaceId, ctx.contactKey, vars);

  return { handled: true, messages: out, automationName: automation.name, branchLabel: node.title };
}

export async function resumeDueAutomationWaits(env: EngineEnv, makeDeliver: (row: { workspace_id: string; channel: string; contact_key: string; phone_number_id: string }) => ((text: string) => Promise<boolean>) | null): Promise<number> {
  const now = sqliteNow();
  const due = await env.DB.prepare(`SELECT * FROM automation_waits WHERE due_at <= ? LIMIT 25`).bind(now)
    .all<{ id: number; workspace_id: string; automation_id: string; session_id: string; contact_key: string; channel: string; phone_number_id: string; resume_path: string }>();
  let resumed = 0;
  for (const row of due.results || []) {
    const automation = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(row.automation_id).first<AutomationRow>();
    await env.DB.prepare(`DELETE FROM automation_waits WHERE id = ?`).bind(row.id).run();
    if (!automation) continue;
    const contactKey = row.contact_key || row.session_id;
    const deliver = makeDeliver({ workspace_id: row.workspace_id, channel: row.channel, contact_key: contactKey, phone_number_id: row.phone_number_id });
    if (!deliver) continue; // channel no longer deliverable (e.g. WhatsApp disconnected) — drop the resume
    const ctx: RunCtx = {
      channel: row.channel === "whatsapp" ? "whatsapp" : "webchat",
      contactKey, phoneNumberId: row.phone_number_id || undefined,
      persistConversationState: row.channel !== "whatsapp",
      deliver,
    };
    const graph = toGraph(JSON.parse(automation.flow_json));
    const session = await loadSession(env.DB, row.workspace_id, contactKey);
    const vars = { ...(session?.variables || {}) };
    const out: AutomationOutMessage[] = [];
    const x: ExecCtx = { env, workspaceId: row.workspace_id, ctx, automation, history: [], out, vars };
    let path: { nodeId?: string | null } = {};
    try { path = JSON.parse(row.resume_path) as { nodeId?: string | null }; } catch { path = {}; }
    const walk = await walkFrom(x, graph, path.nodeId ?? null);
    if (walk.cursor) await saveSession(env.DB, row.workspace_id, contactKey, { automationId: automation.id, nodeId: walk.cursor, variables: vars });
    else await clearCursor(env.DB, row.workspace_id, contactKey, vars);
    resumed++;
  }
  return resumed;
}
