// ── v2 automation model: a real directed graph of nodes ──
//
// v1 hardcoded one shape: trigger -> split -> exactly 2 branches -> optionally 1 nested split ->
// 2 sub-branches. That could not express a wide menu tree (e.g. a service desk with 9 top-level
// choices, each with its own sub-choices), a loop back to a main menu, or a linear chain deeper
// than a couple of steps. v2 replaces it with `nodes` keyed by id plus explicit `next` pointers,
// so any node can lead anywhere, any number of times, at any depth — including cycles.
//
// Every v1 automation (and all 8 sector templates) is converted through migrateV1ToV2 below, so
// nothing that already exists needs rewriting by hand.

export type NodeKind =
  | "trigger"   // entry point; config.channels decides which channels run this automation
  | "message"   // send text (supports {{variable}} interpolation)
  | "buttons"   // send text + N tappable options, each routing to its own node; waits for a choice
  | "question"  // ask for one value, validate it, store it in a variable, then continue
  | "upload"    // ask for one or more documents; waits until every required one has arrived
  | "items"     // show catalog item cards, with each card's link built from collected variables
  | "aiReply"   // hand the conversation to the real AI assistant
  | "aiAction"  // AI reply with one specific AI Action tool available
  | "split"     // rule-based branch with N cases + a fallback
  | "wait"      // pause, resumed later by the cron handler
  | "tag" | "notify" | "escalate"
  | "end";      // terminal: clears the session cursor

export type RuleType = "conditional" | "ab" | "time" | "freq";
export type InputType = "text" | "number" | "date" | "email" | "phone";

export type NodeOption = { id: string; label: string; description?: string; next: string | null };
export type NodeCase = { id: string; label: string; match?: string; weight?: number; next: string | null };

// One document the business expects at an upload node. `accept` is the list of allowed extensions;
// it is enforced server-side against the file's real magic bytes, not just its name or the MIME type
// the browser claims, since both of those are trivially forged.
export type DocumentSpec = { key: string; label: string; accept: string[]; maxMb: number; required: boolean };
export type CollectFlow = { id: string; name: string; fields: { key: string; label: string }[]; urlTemplate: string; itemIds: string[] };

export type NodeConfig = {
  channels?: string[];
  messageText?: string;
  options?: NodeOption[];
  variableKey?: string; inputType?: InputType; required?: boolean;
  documents?: DocumentSpec[];
  itemIds?: string[]; urlTemplate?: string;
  ruleType?: RuleType; cases?: NodeCase[]; fallbackNext?: string | null;
  activeDays?: string[]; startTime?: string; endTime?: string;
  freqMax?: number; freqPeriod?: "hour" | "day" | "week";
  waitAmount?: number; waitUnit?: "minutes" | "hours" | "days";
  tagName?: string;
  notifyChannels?: string[]; notifyRecipient?: string;
  aiActionName?: string;
  escalateQueue?: string; escalatePriority?: "Normal" | "Urgent";
  collectFlows?: CollectFlow[];
};

export type AutomationNode = {
  id: string; kind: NodeKind;
  title: string; subtitle?: string; icon?: string; chip?: string;
  next?: string | null;
  config?: NodeConfig;
};

export type AutomationGraph = { version: 2; entryId: string; nodes: Record<string, AutomationNode> };

export const MAX_NODES = 200;
export const MAX_OPTIONS = 24;
export const MAX_CASES = 12;

// Node kinds that stop the walk and wait for the customer's next message.
const AWAITING_KINDS = new Set<NodeKind>(["buttons", "question", "upload", "aiReply", "aiAction"]);
export function nodeAwaitsInput(kind: NodeKind): boolean { return AWAITING_KINDS.has(kind); }

const DEFAULT_ICONS: Record<NodeKind, string> = {
  trigger: "💬", message: "💬", buttons: "◉", question: "❓", upload: "📎", items: "▤",
  aiReply: "✨", aiAction: "⚙", split: "⑂", wait: "⏱", tag: "🏷️",
  notify: "🔔", escalate: "🧑‍💼", end: "⏹",
};
const DEFAULT_CHIPS: Record<NodeKind, string> = {
  trigger: "rose", message: "rose", buttons: "teal", question: "teal", upload: "teal", items: "teal",
  aiReply: "indigo", aiAction: "indigo", split: "purple", wait: "neutral", tag: "neutral",
  notify: "purple", escalate: "human", end: "neutral",
};

// Extensions the platform can actually verify by magic bytes (see sniffFileType in documents.ts).
// Deliberately narrow: accepting a format we cannot verify would let anything through under a
// trusted-looking label.
export const SUPPORTED_UPLOAD_TYPES = ["pdf", "jpg", "png", "webp", "heic"] as const;
export const MAX_UPLOAD_MB = 5;
export const MAX_DOCUMENTS_PER_NODE = 10;

export function nodeIcon(node: AutomationNode): string { return node.icon || DEFAULT_ICONS[node.kind] || "•"; }
export function nodeChip(node: AutomationNode): string { return node.chip || DEFAULT_CHIPS[node.kind] || "neutral"; }

// ── Variable interpolation ──
// Supports {{key}} (used in message/question/items text) and {key} (the form the existing
// Collect & Link URL templates already use), so both styles work anywhere.
export function interpolate(text: string, vars: Record<string, string>): string {
  return (text || "")
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "")
    .replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (_m, k: string) => vars[k] ?? "");
}

// URL templates need each substituted value percent-encoded, which plain interpolate() must not do
// (it also feeds plain chat text). Shared by the items node and the dashboard's Test-link preview so
// the preview is byte-identical to what a real customer gets.
export function buildUrlFromTemplate(template: string, vars: Record<string, unknown>): string {
  return (template || "").replace(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g, (_m, k: string) => {
    const v = vars[k];
    return encodeURIComponent(v === undefined || v === null ? "" : String(v));
  });
}

// ── Validation of untrusted graph input (PATCH bodies) ──

function str(v: unknown, max: number): string { return typeof v === "string" ? v.slice(0, max) : ""; }
function nextOf(v: unknown): string | null { return typeof v === "string" && v ? v.slice(0, 80) : null; }

const KINDS = new Set<NodeKind>(["trigger", "message", "buttons", "question", "upload", "items", "aiReply", "aiAction", "split", "wait", "tag", "notify", "escalate", "end"]);

function sanitizeConfig(raw: unknown): NodeConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cfg: NodeConfig = {};
  if (Array.isArray(c.channels)) cfg.channels = c.channels.filter((x): x is string => typeof x === "string").slice(0, 4);
  if (typeof c.messageText === "string") cfg.messageText = c.messageText.slice(0, 4000);
  if (Array.isArray(c.options)) {
    cfg.options = c.options.slice(0, MAX_OPTIONS).map((o) => {
      const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      return { id: str(r.id, 80) || crypto.randomUUID(), label: str(r.label, 120), description: str(r.description, 300) || undefined, next: nextOf(r.next) };
    }).filter((o) => o.label);
  }
  if (typeof c.variableKey === "string") cfg.variableKey = c.variableKey.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 60);
  if (typeof c.inputType === "string" && ["text", "number", "date", "email", "phone"].includes(c.inputType)) cfg.inputType = c.inputType as InputType;
  if (typeof c.required === "boolean") cfg.required = c.required;
  if (Array.isArray(c.documents)) {
    cfg.documents = c.documents.slice(0, MAX_DOCUMENTS_PER_NODE).map((d) => {
      const r = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
      const accept = Array.isArray(r.accept)
        ? r.accept.filter((x): x is string => typeof x === "string")
            .map((x) => x.toLowerCase().replace(/^\./, ""))
            .filter((x) => (SUPPORTED_UPLOAD_TYPES as readonly string[]).includes(x))
        : [];
      return {
        // The key names the document in stored records and in {{variables}}, so it has to be a
        // stable identifier rather than the human label, which the business may reword later.
        key: str(r.key, 60).replace(/[^a-zA-Z0-9_]/g, "") || `doc_${Math.random().toString(36).slice(2, 8)}`,
        label: str(r.label, 120) || "Document",
        accept: accept.length ? accept : [...SUPPORTED_UPLOAD_TYPES],
        maxMb: typeof r.maxMb === "number" ? Math.max(1, Math.min(MAX_UPLOAD_MB, Math.round(r.maxMb))) : MAX_UPLOAD_MB,
        required: r.required !== false,
      };
    }).filter((d) => d.label);
  }
  if (Array.isArray(c.itemIds)) cfg.itemIds = c.itemIds.filter((x): x is string => typeof x === "string").slice(0, 40);
  if (typeof c.urlTemplate === "string") cfg.urlTemplate = c.urlTemplate.slice(0, 2000);
  if (typeof c.ruleType === "string" && ["conditional", "ab", "time", "freq"].includes(c.ruleType)) cfg.ruleType = c.ruleType as RuleType;
  if (Array.isArray(c.cases)) {
    cfg.cases = c.cases.slice(0, MAX_CASES).map((k) => {
      const r = (k && typeof k === "object" ? k : {}) as Record<string, unknown>;
      return {
        id: str(r.id, 80) || crypto.randomUUID(), label: str(r.label, 120) || "Case",
        match: str(r.match, 500) || undefined,
        weight: typeof r.weight === "number" ? Math.max(0, Math.min(100, r.weight)) : undefined,
        next: nextOf(r.next),
      };
    });
  }
  if (c.fallbackNext !== undefined) cfg.fallbackNext = nextOf(c.fallbackNext);
  if (Array.isArray(c.activeDays)) cfg.activeDays = c.activeDays.filter((x): x is string => typeof x === "string").slice(0, 7);
  if (typeof c.startTime === "string") cfg.startTime = c.startTime.slice(0, 5);
  if (typeof c.endTime === "string") cfg.endTime = c.endTime.slice(0, 5);
  if (typeof c.freqMax === "number") cfg.freqMax = Math.max(1, Math.min(999, c.freqMax));
  if (typeof c.freqPeriod === "string" && ["hour", "day", "week"].includes(c.freqPeriod)) cfg.freqPeriod = c.freqPeriod as NodeConfig["freqPeriod"];
  if (typeof c.waitAmount === "number") cfg.waitAmount = Math.max(1, Math.min(9999, c.waitAmount));
  if (typeof c.waitUnit === "string" && ["minutes", "hours", "days"].includes(c.waitUnit)) cfg.waitUnit = c.waitUnit as NodeConfig["waitUnit"];
  if (typeof c.tagName === "string") cfg.tagName = c.tagName.slice(0, 120);
  if (Array.isArray(c.notifyChannels)) cfg.notifyChannels = c.notifyChannels.filter((x): x is string => typeof x === "string").slice(0, 4);
  if (typeof c.notifyRecipient === "string") cfg.notifyRecipient = c.notifyRecipient.slice(0, 200);
  if (typeof c.aiActionName === "string") cfg.aiActionName = c.aiActionName.slice(0, 120);
  if (typeof c.escalateQueue === "string") cfg.escalateQueue = c.escalateQueue.slice(0, 120);
  if (c.escalatePriority === "Urgent" || c.escalatePriority === "Normal") cfg.escalatePriority = c.escalatePriority;
  if (Array.isArray(c.collectFlows)) {
    cfg.collectFlows = c.collectFlows.slice(0, 12).map((f) => {
      const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      const fields = Array.isArray(r.fields) ? r.fields.slice(0, 20).map((x) => {
        const fr = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        return { key: str(fr.key, 60).replace(/[^a-zA-Z0-9_]/g, ""), label: str(fr.label, 300) };
      }).filter((x) => x.key || x.label) : [];
      return {
        id: str(r.id, 80) || crypto.randomUUID(), name: str(r.name, 120),
        fields, urlTemplate: str(r.urlTemplate, 2000),
        itemIds: Array.isArray(r.itemIds) ? r.itemIds.filter((x): x is string => typeof x === "string").slice(0, 40) : [],
      };
    });
  }
  return cfg;
}

export function sanitizeGraph(raw: unknown): AutomationGraph | null {
  const g = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!g) return null;
  const rawNodes = (g.nodes && typeof g.nodes === "object" ? g.nodes : null) as Record<string, unknown> | null;
  if (!rawNodes) return null;
  const nodes: Record<string, AutomationNode> = {};
  for (const [id, value] of Object.entries(rawNodes).slice(0, MAX_NODES)) {
    const n = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const kind = typeof n.kind === "string" && KINDS.has(n.kind as NodeKind) ? (n.kind as NodeKind) : "message";
    const safeId = id.slice(0, 80);
    nodes[safeId] = {
      id: safeId, kind,
      title: str(n.title, 160) || kind,
      subtitle: str(n.subtitle, 400) || undefined,
      icon: str(n.icon, 8) || undefined,
      chip: str(n.chip, 24) || undefined,
      next: nextOf(n.next),
      config: sanitizeConfig(n.config),
    };
  }
  const entryId = typeof g.entryId === "string" && nodes[g.entryId] ? g.entryId : Object.keys(nodes)[0];
  if (!entryId) return null;
  // Drop dangling pointers so the engine never chases a node that no longer exists.
  const exists = (id: string | null | undefined) => (id && nodes[id] ? id : null);
  for (const node of Object.values(nodes)) {
    node.next = exists(node.next);
    if (node.config?.options) node.config.options = node.config.options.map((o) => ({ ...o, next: exists(o.next) }));
    if (node.config?.cases) node.config.cases = node.config.cases.map((k) => ({ ...k, next: exists(k.next) }));
    if (node.config?.fallbackNext !== undefined) node.config.fallbackNext = exists(node.config.fallbackNext);
  }
  return { version: 2, entryId, nodes };
}

// ── Completeness (drives the ⚠ badge, per node and per automation) ──

export function nodeIsIncomplete(node: AutomationNode): boolean {
  const c = node.config || {};
  switch (node.kind) {
    case "trigger": return !(c.channels || []).length;
    case "message": return !(c.messageText || "").trim();
    case "buttons": return !(c.messageText || "").trim() || !(c.options || []).length || (c.options || []).some((o) => !o.label.trim());
    case "question": return !(c.messageText || "").trim() || !(c.variableKey || "").trim();
    case "upload": return !(c.messageText || "").trim() || !(c.documents || []).length || (c.documents || []).some((d) => !d.label.trim() || !d.accept.length);
    case "items": return !(c.itemIds || []).length;
    case "split": return (c.ruleType || "conditional") === "conditional"
      ? !(c.cases || []).length || (c.cases || []).some((k) => !(k.match || "").trim())
      : !(c.cases || []).length;
    case "tag": return !(c.tagName || "").trim();
    case "aiAction": return !(c.aiActionName || "").trim();
    case "escalate": return !(c.escalateQueue || "").trim();
    case "notify": return !(c.notifyChannels || []).length;
    case "aiReply": return (c.collectFlows || []).some((f) => !f.name.trim() || !f.fields.length || !f.urlTemplate.trim());
    default: return false; // wait/end need no required field
  }
}

export function graphNeedsConfig(graph: AutomationGraph): boolean {
  return Object.values(graph.nodes).some(nodeIsIncomplete);
}

// ── v1 -> v2 migration ──
// Used for BOTH legacy stored automations and the 8 sector templates, so the conversion has exactly
// one implementation and is exercised constantly rather than being a one-off script.

type V1Step = { id: string; icon: string; title: string; subtitle: string; chip: string; kind: string; config?: Record<string, unknown> };
type V1Sub = { id: string; label: string; color: string; steps: V1Step[] };
type V1Branch = V1Sub & { split2?: V1Step; subBranches?: [V1Sub, V1Sub] };
export type V1Flow = { trigger: V1Step; split1: V1Step; branches: [V1Branch, V1Branch] };

export function isV1Flow(raw: unknown): raw is V1Flow {
  const f = raw as Record<string, unknown> | null;
  return Boolean(f && typeof f === "object" && f.trigger && f.split1 && Array.isArray(f.branches));
}

export function migrateV1ToV2(flow: V1Flow): AutomationGraph {
  const nodes: Record<string, AutomationNode> = {};

  const put = (s: V1Step, kind: NodeKind, next: string | null, config?: NodeConfig): string => {
    const id = s.id || crypto.randomUUID();
    nodes[id] = { id, kind, title: s.title, subtitle: s.subtitle, icon: s.icon, chip: s.chip, next, config };
    return id;
  };

  // A v1 branch was an ordered array of steps — chain them with `next`, back to front so each
  // node already knows its successor.
  const chain = (steps: V1Step[], tailNext: string | null): string | null => {
    let next = tailNext;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      const kind: NodeKind = (["aiReply", "message", "wait", "tag", "notify", "aiAction", "escalate"].includes(s.kind) ? s.kind : "message") as NodeKind;
      next = put(s, kind, next, (s.config || {}) as NodeConfig);
    }
    return next;
  };

  const splitNode = (s: V1Step, labelA: string, nextA: string | null, labelB: string, nextB: string | null): string => {
    const cfg = (s.config || {}) as NodeConfig;
    const ruleType = (cfg.ruleType || "conditional") as RuleType;
    // v1 splits were always binary: case 0 = "matched", the other side = fallback.
    const cases: NodeCase[] = [{
      id: crypto.randomUUID(), label: labelA, next: nextA,
      match: ruleType === "conditional" ? (cfg as { condition?: string }).condition || "" : undefined,
      weight: ruleType === "ab" ? (cfg as { abWeightA?: number }).abWeightA ?? 50 : undefined,
    }];
    return put(s, "split", null, { ...cfg, ruleType, cases, fallbackNext: nextB, options: undefined });
  };

  const branchEntry = (b: V1Branch): string | null => {
    if (b.split2 && b.subBranches) {
      const subA = chain(b.subBranches[0].steps, null);
      const subB = chain(b.subBranches[1].steps, null);
      const split2Id = splitNode(b.split2, b.subBranches[0].label, subA, b.subBranches[1].label, subB);
      return chain(b.steps, split2Id);
    }
    return chain(b.steps, null);
  };

  const entryA = branchEntry(flow.branches[0]);
  const entryB = branchEntry(flow.branches[1]);
  const split1Id = splitNode(flow.split1, flow.branches[0].label, entryA, flow.branches[1].label, entryB);
  const triggerId = put(flow.trigger, "trigger", split1Id, (flow.trigger.config || {}) as NodeConfig);

  return { version: 2, entryId: triggerId, nodes };
}

// Accepts either shape from storage and always hands back v2, so every caller downstream (engine,
// API responses, dashboard) only ever deals with one model.
export function toGraph(raw: unknown): AutomationGraph {
  if (isV1Flow(raw)) return migrateV1ToV2(raw);
  const sane = sanitizeGraph(raw);
  if (sane) return sane;
  const id = crypto.randomUUID();
  return { version: 2, entryId: id, nodes: { [id]: { id, kind: "trigger", title: "New message received", subtitle: "Click to choose which channels trigger this automation", next: null, config: { channels: ["webchat"] } } } };
}
