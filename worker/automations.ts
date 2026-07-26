import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin, callClaude, callClaudeWithActions, sanitizeActions, type ChatMessage, type AssistantActionDef } from "./shared";
import { readWorkspaceState, buildSystemPrompt } from "./widget";
import { listItemsForWorkspace, getItemsByIds } from "./items";

export interface AutomationsEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

function uid(): string { return crypto.randomUUID(); }
function sqliteNow(): string { return new Date().toISOString().slice(0, 19).replace("T", " "); }

// Lets an AI reply/AI action step give each shown item card a conversation-specific link (e.g.
// the guest's actual dates/guest count) instead of the AI having to paste a URL in its text reply.
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

// ── Types (mirrors the design's tree shape exactly: trigger -> split1 -> 2 branches -> optional
// split2 -> 2 sub-branches -> exit) ──

export type StepKind = "trigger" | "split" | "aiReply" | "message" | "wait" | "tag" | "notify" | "aiAction" | "escalate" | "generic";
export type RuleType = "conditional" | "ab" | "time" | "freq";

export type AutomationStep = {
  id: string; icon: string; title: string; subtitle: string; chip: string; kind: StepKind;
  config?: {
    channels?: string[];
    ruleType?: RuleType; condition?: string; matchLanguage?: string;
    abWeightA?: number;
    activeDays?: string[]; startTime?: string; endTime?: string;
    freqMax?: number; freqPeriod?: "hour" | "day" | "week";
    messageChannel?: "whatsapp" | "webchat"; messageText?: string;
    waitAmount?: number; waitUnit?: "minutes" | "hours" | "days";
    tagName?: string;
    notifyChannels?: string[]; notifyRecipient?: string;
    aiActionName?: string;
    escalateQueue?: string; escalatePriority?: "Normal" | "Urgent";
  };
};
export type AutomationBranch = { id: string; label: string; color: string; steps: AutomationStep[]; split2?: AutomationStep; subBranches?: [AutomationSubBranch, AutomationSubBranch] };
export type AutomationSubBranch = { id: string; label: string; color: string; steps: AutomationStep[] };
export type FlowTree = { trigger: AutomationStep; split1: AutomationStep; branches: [AutomationBranch, AutomationBranch] };
export type Automation = { id: string; name: string; sectorKey: string; status: "active" | "draft" | "inactive"; priority: number; needsConfig: boolean; flow: FlowTree; createdAt?: string; updatedAt?: string };

// ── Schema ──

let automationsSchemaEnsured = false;

async function ensureAutomationsSchema(db: D1Database): Promise<void> {
  if (automationsSchemaEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS automations2 (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sector_key TEXT NOT NULL DEFAULT 'custom',
      status TEXT NOT NULL DEFAULT 'draft',
      priority INTEGER NOT NULL DEFAULT 0,
      needs_config INTEGER NOT NULL DEFAULT 0,
      flow_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_automations2_workspace ON automations2 (workspace_id, priority)`),
    // Real Activity log — one row per automation execution.
    db.prepare(`CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      automation_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      channel TEXT NOT NULL,
      branch_label TEXT NOT NULL,
      outcome TEXT NOT NULL,
      outcome_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace ON automation_runs (workspace_id, created_at DESC)`),
    // Frequency-cap gate: counts real sends per contact, used to evaluate "freq" rule splits.
    db.prepare(`CREATE TABLE IF NOT EXISTS automation_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      contact_key TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_automation_sends_lookup ON automation_sends (workspace_id, automation_id, contact_key, sent_at)`),
    // Real pending "wait" steps — resumed by the scheduled (cron) handler once due.
    db.prepare(`CREATE TABLE IF NOT EXISTS automation_waits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      contact_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      resume_path TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_automation_waits_due ON automation_waits (due_at)`),
  ]);
  // phone_number_id lets a resumed WhatsApp wait step still reach the right Cloud API number.
  try { await db.prepare(`ALTER TABLE automation_waits ADD COLUMN phone_number_id TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  automationsSchemaEnsured = true;
}

// ── The 8 real industry starter flows — ported verbatim from the design file's SECTOR_FLOWS,
// with an explicit `kind`/`config` assigned per step (the design's mock inferred `kind` from
// title text at render time; here it's assigned once, directly, since this drives real
// execution behavior, not just which config-drawer fields to show). ──

function step(icon: string, title: string, subtitle: string, chip: string, kind: StepKind, config?: AutomationStep["config"]): AutomationStep {
  return { id: uid(), icon, title, subtitle, chip, kind, config };
}
function splitStep(title: string, subtitle: string, config?: AutomationStep["config"]): AutomationStep {
  return { id: uid(), icon: "⑂", title, subtitle, chip: "purple", kind: "split", config: { ruleType: "conditional", ...config } };
}
function branch(label: string, color: string, steps: AutomationStep[], split2?: AutomationStep, subBranches?: [AutomationSubBranch, AutomationSubBranch]): AutomationBranch {
  return { id: uid(), label, color, steps, split2, subBranches };
}
function sub(label: string, color: string, steps: AutomationStep[]): AutomationSubBranch {
  return { id: uid(), label, color, steps };
}

function sectorFlows(): Record<string, { name: string; icon: string; desc: string; flow: FlowTree }> {
  const trigger = (subtitle: string): AutomationStep => step("💬", "New message received", subtitle, "rose", "trigger", { channels: ["whatsapp", "webchat"] });
  return {
    general: {
      name: "General Support", icon: "🤖",
      desc: "Default WhatsApp + web chat triage: escalate on request, else let AI reply and follow up.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat widget · any conversation state"),
        split1: splitStep("Conditional split", "Message text contains \"human\", \"agent\", or \"talk to someone\"", { condition: "human, agent, talk to someone" }),
        branches: [
          branch("Matches", "green", [
            step("🧑‍💼", "Escalate to human agent", "Assign to Support queue · mark conversation \"Needs human\"", "human", "escalate", { escalateQueue: "Support queue", escalatePriority: "Normal" }),
            step("🔔", "Notify team", "Slack + email alert to on-duty agent within business hours", "purple", "notify", { notifyChannels: ["email", "slack"], notifyRecipient: "on-duty@qpyengage.com" }),
            step("📝", "Add internal note", "\"Escalated automatically — customer requested a human\"", "neutral", "generic"),
          ]),
          branch("No match", "blue",
            [step("✨", "Send AI reply", "Claude Sonnet 5 · role: Support assistant · uses AI Actions if needed", "indigo", "aiReply")],
            splitStep("Conditional split", "AI confidence score of the reply", { ruleType: "ab", abWeightA: 30 }),
            [
              sub("Low confidence (<70%)", "rose", [step("🧑‍💼", "Escalate to human agent", "AI wasn't confident — route to support queue instead of guessing", "human", "escalate", { escalateQueue: "Support queue" })]),
              sub("High confidence", "green", [
                step("🏷️", "Add tag: ai-handled", "Tag conversation for reporting", "neutral", "tag", { tagName: "ai-handled" }),
                step("⏱", "Wait", "24 hours after conversation resolved", "neutral", "wait", { waitAmount: 24, waitUnit: "hours" }),
                step("⭐", "Send satisfaction survey", "WhatsApp template message · 1-tap rating", "teal", "message", { messageChannel: "webchat", messageText: "Quick one — how would you rate the help you got today, 1 to 5?" }),
              ]),
            ]),
        ],
      },
    },
    fnb: {
      name: "Food & Beverage", icon: "🍽️",
      desc: "Handle reservations instantly, route orders and feedback to the right team.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · restaurant inbox"),
        split1: splitStep("Conditional split", "Message contains \"reservation\", \"table\", or \"book\"", { condition: "reservation, table, book" }),
        branches: [
          branch("Reservation request", "green", [
            step("📅", "Check table availability", "AI Action → reservation system lookup", "indigo", "aiAction", { aiActionName: "Check table availability" }),
            step("✅", "Send booking confirmation", "WhatsApp template with date, time, party size", "rose", "message", { messageChannel: "webchat", messageText: "You're booked! We've saved your table — see you soon." }),
            step("📋", "Add to reservations list", "Save guest as lead · source: WhatsApp", "neutral", "generic"),
          ]),
          branch("General / order", "blue",
            [step("✨", "Send AI menu & order assistant reply", "Answers menu, hours, delivery questions", "indigo", "aiReply")],
            splitStep("Conditional split", "Did the customer place an order?", { condition: "order, add to cart" }),
            [
              sub("Order captured", "green", [
                step("🧾", "Save order as lead", "Tag: order", "neutral", "tag", { tagName: "order" }),
                step("🔔", "Notify kitchen team", "Order details sent to kitchen display/Slack", "purple", "notify", { notifyChannels: ["slack"], notifyRecipient: "" }),
              ]),
              sub("Still deciding", "rose", [step("🧑‍💼", "Escalate to human agent", "Customer needs help completing the order", "human", "escalate", { escalateQueue: "Front desk" })]),
            ]),
        ],
      },
    },
    hotels: {
      name: "Hotels & Resorts", icon: "🏨",
      desc: "Instant room booking help, concierge AI, and automatic guest follow-up.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · reservations inbox"),
        split1: splitStep("Conditional split", "Message contains \"book a room\", \"reservation\", or \"availability\"", { condition: "book a room, reservation, availability" }),
        branches: [
          branch("Booking request", "green", [
            step("🛏️", "Check room availability", "AI Action → PMS lookup by dates & room type", "indigo", "aiAction", { aiActionName: "Check room availability" }),
            step("💳", "Send rates & booking link", "WhatsApp template with pricing and payment link", "rose", "message", { messageChannel: "webchat", messageText: "Here are our current rates and a link to complete your booking." }),
            step("📋", "Add guest to CRM", "Save as lead · source: WhatsApp booking inquiry", "neutral", "generic"),
          ]),
          branch("General inquiry", "blue",
            [step("✨", "Send AI concierge reply", "Answers amenities, check-in, local recommendations", "indigo", "aiReply")],
            splitStep("Conditional split", "Guest asks for the front desk / concierge", { condition: "front desk, concierge" }),
            [
              sub("Requests concierge", "rose", [step("🧑‍💼", "Escalate to front desk", "Route to on-duty concierge team", "human", "escalate", { escalateQueue: "Concierge team" })]),
              sub("Info only", "green", [
                step("🏷️", "Add tag: info-request", "Tag conversation for reporting", "neutral", "tag", { tagName: "info-request" }),
                step("⏱", "Wait", "Until 1 day after checkout date", "neutral", "wait", { waitAmount: 24, waitUnit: "hours" }),
                step("⭐", "Send review request", "WhatsApp template asking for a review/rating", "teal", "message", { messageChannel: "webchat", messageText: "Thanks for staying with us! Would you mind leaving a quick review?" }),
              ]),
            ]),
        ],
      },
    },
    grocery: {
      name: "Grocery & Retail", icon: "🛒",
      desc: "Instant order tracking plus AI shopping help that captures every lead.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · storefront inbox"),
        split1: splitStep("Conditional split", "Message contains an order number or the word \"track\"", { condition: "track, order #" }),
        branches: [
          branch("Order tracking", "green", [
            step("📦", "Look up order status", "AI Action → store/ERP order lookup", "indigo", "aiAction", { aiActionName: "Look up order status" }),
            step("🚚", "Send tracking update", "WhatsApp template with carrier + ETA", "rose", "message", { messageChannel: "webchat", messageText: "Here's your latest tracking update." }),
          ]),
          branch("Shopping question", "blue",
            [step("✨", "Send AI shopping assistant reply", "Answers stock, pricing, delivery-area questions", "indigo", "aiReply")],
            splitStep("Conditional split", "Did the customer add items to an order?", { condition: "order, cart" }),
            [
              sub("Order captured", "green", [step("📋", "Save order as lead", "Tag: order · notify fulfillment team", "neutral", "tag", { tagName: "order" })]),
              sub("Still browsing", "rose", [step("🧑‍💼", "Escalate to human agent", "Customer needs help completing checkout", "human", "escalate", { escalateQueue: "Support queue" })]),
            ]),
        ],
      },
    },
    realestate: {
      name: "Real Estate", icon: "🏠",
      desc: "Qualify buyers automatically, share listings, and hand hot leads to agents.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · listings inbox"),
        split1: splitStep("Conditional split", "Message contains \"property\", \"listing\", or \"viewing\"", { condition: "property, listing, viewing" }),
        branches: [
          branch("Property inquiry", "green", [
            step("🔎", "Search matching listings", "AI Action → property search by budget/location", "indigo", "aiAction", { aiActionName: "Search matching listings" }),
            step("📋", "Capture lead details", "Budget, location, timeline saved to lead record", "neutral", "generic"),
            step("🔔", "Notify assigned agent", "Route to the agent covering that listing area", "purple", "notify", { notifyChannels: ["slack"], notifyRecipient: "" }),
          ]),
          branch("General inquiry", "blue",
            [step("✨", "Send AI assistant reply", "Answers financing, process, and neighborhood questions", "indigo", "aiReply")],
            splitStep("Conditional split", "Contact qualifies as a hot lead", { ruleType: "ab", abWeightA: 40 }),
            [
              sub("Qualified lead", "green", [step("🧑‍💼", "Escalate to agent", "Route directly to a human for scheduling a viewing", "human", "escalate", { escalateQueue: "Support queue" })]),
              sub("Early-stage", "rose", [
                step("🏷️", "Add tag: nurture", "Tag conversation for reporting", "neutral", "tag", { tagName: "nurture" }),
                step("⏱", "Wait", "3 days", "neutral", "wait", { waitAmount: 3, waitUnit: "days" }),
                step("📤", "Send new-listings follow-up", "WhatsApp template with matching new listings", "rose", "message", { messageChannel: "webchat", messageText: "A few new listings just came up that match what you're looking for — want details?" }),
              ]),
            ]),
        ],
      },
    },
    healthcare: {
      name: "Hospitals & Clinics", icon: "🏥",
      desc: "Route emergencies instantly; let AI handle appointments and FAQs safely.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · patient inbox"),
        split1: splitStep("Conditional split", "Message contains \"emergency\" or \"urgent\"", { condition: "emergency, urgent" }),
        branches: [
          branch("Urgent", "rose", [
            step("🧑‍💼", "Escalate immediately", "Route to on-call staff · bypass AI reply entirely", "human", "escalate", { escalateQueue: "Front desk", escalatePriority: "Urgent" }),
            step("🔔", "Notify team (urgent)", "SMS + Slack alert to on-call nurse/doctor", "purple", "notify", { notifyChannels: ["slack"], notifyRecipient: "" }),
          ]),
          branch("Non-urgent", "blue",
            [step("✨", "Send AI assistant reply", "Appointment info, hours, and FAQ answers only", "indigo", "aiReply")],
            splitStep("Conditional split", "Patient wants to book an appointment", { condition: "appointment, book, schedule" }),
            [
              sub("Appointment request", "green", [
                step("📅", "Check doctor availability", "AI Action → scheduling system lookup", "indigo", "aiAction", { aiActionName: "Check doctor availability" }),
                step("✅", "Book & send confirmation", "WhatsApp template with date, time, doctor", "rose", "message", { messageChannel: "webchat", messageText: "You're booked — we'll send a reminder closer to your appointment." }),
              ]),
              sub("General question", "rose", [step("🧑‍💼", "Escalate to front desk", "Anything outside FAQ scope goes to a human", "human", "escalate", { escalateQueue: "Front desk" })]),
            ]),
        ],
      },
    },
    schools: {
      name: "Schools (K-12)", icon: "🏫",
      desc: "Log attendance automatically and route parent questions to the right office.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · parent/guardian inbox"),
        split1: splitStep("Conditional split", "Message contains \"absence\", \"sick\", or \"attendance\"", { condition: "absence, sick, attendance" }),
        branches: [
          branch("Attendance notice", "green", [
            step("📝", "Log attendance note", "AI Action → attendance system entry", "indigo", "aiAction", { aiActionName: "Log attendance note" }),
            step("🔔", "Notify homeroom teacher", "Sent automatically, no manual entry needed", "purple", "notify", { notifyChannels: ["email"], notifyRecipient: "" }),
          ]),
          branch("General question", "blue",
            [step("✨", "Send AI assistant reply", "Answers school hours, calendar, and policy questions", "indigo", "aiReply")],
            splitStep("Conditional split", "Parent needs the front office", { condition: "front office, admin" }),
            [
              sub("Needs front office", "rose", [step("🧑‍💼", "Escalate to front office", "Route to school admin staff", "human", "escalate", { escalateQueue: "Front desk" })]),
              sub("Info only", "green", [step("🏷️", "Add tag: info", "Tag conversation for reporting", "neutral", "tag", { tagName: "info" })]),
            ]),
        ],
      },
    },
    universities: {
      name: "Universities & Colleges", icon: "🎓",
      desc: "Guide prospective students through admissions and route the rest to advisors.",
      flow: {
        trigger: trigger("Channel: WhatsApp or Web chat · admissions inbox"),
        split1: splitStep("Conditional split", "Message contains \"admissions\", \"apply\", or \"enroll\"", { condition: "admissions, apply, enroll" }),
        branches: [
          branch("Admissions inquiry", "green", [
            step("✨", "Send AI admissions assistant reply", "Answers deadlines, requirements, and program details", "indigo", "aiReply"),
            step("📋", "Capture lead", "Program interest, intake term saved to lead record", "neutral", "generic"),
            step("🔔", "Notify admissions team", "Routed for personal follow-up", "purple", "notify", { notifyChannels: ["email"], notifyRecipient: "" }),
          ]),
          branch("General question", "blue",
            [step("✨", "Send AI assistant reply", "Campus life, financial aid, and general FAQ answers", "indigo", "aiReply")],
            splitStep("Conditional split", "Contact needs an academic advisor", { condition: "advisor, course, program guidance" }),
            [
              sub("Needs advisor", "rose", [step("🧑‍💼", "Escalate to academic advisor", "Route to a human for course/program guidance", "human", "escalate", { escalateQueue: "Academic advisors" })]),
              sub("Prospect, early-stage", "green", [
                step("🏷️", "Add tag: prospect", "Tag conversation for reporting", "neutral", "tag", { tagName: "prospect" }),
                step("⏱", "Wait", "3 days", "neutral", "wait", { waitAmount: 3, waitUnit: "days" }),
                step("📤", "Send program info follow-up", "WhatsApp template with program brochure link", "rose", "message", { messageChannel: "webchat", messageText: "Here's more info on the program you asked about, including a link to our brochure." }),
              ]),
            ]),
        ],
      },
    },
  };
}

export const SECTOR_ORDER = ["general", "fnb", "hotels", "grocery", "realestate", "healthcare", "schools", "universities"];

// ── CRUD ──

// A step is "incomplete" when the field that makes it actually do something is still blank.
// Shared by needsConfig (automation-level badge) and the per-node attention markers in the UI.
export function stepIsIncomplete(step: AutomationStep): boolean {
  const c = step.config || {};
  switch (step.kind) {
    case "trigger": return !(c.channels || []).length;
    case "split": return (c.ruleType || "conditional") === "conditional" && !(c.condition || "").trim();
    case "message": return !(c.messageText || "").trim();
    case "tag": return !(c.tagName || "").trim();
    case "aiAction": return !(c.aiActionName || "").trim();
    case "escalate": return !(c.escalateQueue || "").trim();
    case "notify": return !(c.notifyChannels || []).length;
    default: return false; // aiReply/wait/generic need no required field
  }
}

export function flowNeedsConfig(flow: FlowTree): boolean {
  if (stepIsIncomplete(flow.trigger) || stepIsIncomplete(flow.split1)) return true;
  for (const branch of flow.branches) {
    if (branch.steps.some(stepIsIncomplete)) return true;
    if (branch.split2 && stepIsIncomplete(branch.split2)) return true;
    if (branch.subBranches) for (const sub of branch.subBranches) if (sub.steps.some(stepIsIncomplete)) return true;
  }
  return false;
}

type AutomationRow = { id: string; name: string; sector_key: string; status: string; priority: number; needs_config: number; flow_json: string; created_at: string; updated_at: string };

function rowToAutomation(row: AutomationRow): Automation {
  return {
    id: row.id, name: row.name, sectorKey: row.sector_key,
    status: row.status === "active" ? "active" : row.status === "inactive" ? "inactive" : "draft",
    priority: row.priority, needsConfig: Boolean(row.needs_config),
    flow: JSON.parse(row.flow_json) as FlowTree,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function listAutomations(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM automations2 WHERE workspace_id = ? ORDER BY priority ASC`).bind(session.workspaceId).all<AutomationRow>();
  return json(request, { automations: (result.results || []).map(rowToAutomation) });
}

async function listSectors(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const flows = sectorFlows();
  const sectors = SECTOR_ORDER.map((key) => ({ key, name: flows[key].name, icon: flows[key].icon, desc: flows[key].desc }));
  return json(request, { sectors });
}

function blankFlow(): FlowTree {
  return {
    trigger: step("💬", "New message received", "Click to choose which channels trigger this automation", "rose", "trigger", { channels: ["webchat"] }),
    split1: splitStep("Conditional split", "Click to set the keywords that decide the branch", { condition: "" }),
    branches: [
      branch("Matches", "green", [step("💬", "Send message", "Click to write what gets sent", "rose", "message", { messageChannel: "webchat", messageText: "" })]),
      branch("No match", "blue", [step("💬", "Send message", "Click to write what gets sent", "rose", "message", { messageChannel: "webchat", messageText: "" })]),
    ],
  };
}

async function createBlank(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const body = await request.json().catch(() => ({})) as { name?: string };
  const maxPriority = await env.DB.prepare(`SELECT MAX(priority) as m FROM automations2 WHERE workspace_id = ?`).bind(session.workspaceId).first<{ m: number | null }>();
  const priority = (maxPriority?.m ?? -1) + 1;
  const id = uid();
  const name = (body.name || "New automation").trim().slice(0, 120) || "New automation";
  const flow = blankFlow();
  await env.DB.prepare(`INSERT INTO automations2 (id, workspace_id, name, sector_key, status, priority, needs_config, flow_json) VALUES (?, ?, ?, 'custom', 'draft', ?, ?, ?)`)
    .bind(id, session.workspaceId, name, priority, flowNeedsConfig(flow) ? 1 : 0, JSON.stringify(flow)).run();
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(id).first<AutomationRow>();
  return json(request, { automation: row ? rowToAutomation(row) : null });
}

async function createFromTemplate(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const body = await request.json() as { sectorKey?: string; name?: string };
  const flows = sectorFlows();
  const sectorKey = body.sectorKey && flows[body.sectorKey] ? body.sectorKey : "general";
  const template = flows[sectorKey];
  const maxPriority = await env.DB.prepare(`SELECT MAX(priority) as m FROM automations2 WHERE workspace_id = ?`).bind(session.workspaceId).first<{ m: number | null }>();
  const priority = (maxPriority?.m ?? -1) + 1;
  const id = uid();
  const name = (body.name || `${template.name} automation`).slice(0, 120);
  await env.DB.prepare(`INSERT INTO automations2 (id, workspace_id, name, sector_key, status, priority, needs_config, flow_json) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
    .bind(id, session.workspaceId, name, sectorKey, priority, flowNeedsConfig(template.flow) ? 1 : 0, JSON.stringify(template.flow)).run();
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(id).first<AutomationRow>();
  return json(request, { automation: row ? rowToAutomation(row) : null });
}

async function updateAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<AutomationRow>();
  if (!existing) return json(request, { error: "Automation not found." }, 404);
  const body = await request.json() as { name?: string; status?: string; flow?: FlowTree; needsConfig?: boolean };
  const name = body.name !== undefined ? body.name.trim().slice(0, 120) || existing.name : existing.name;
  const status = body.status !== undefined && ["active", "draft", "inactive"].includes(body.status) ? body.status : existing.status;
  const flow = body.flow !== undefined ? body.flow : JSON.parse(existing.flow_json) as FlowTree;
  const flowJson = JSON.stringify(flow);
  // needsConfig is always derived from the flow's real completeness — the badge clears itself once
  // every step's required field is filled in, and reappears if something is emptied.
  const needsConfig = flowNeedsConfig(flow) ? 1 : 0;
  await env.DB.prepare(`UPDATE automations2 SET name = ?, status = ?, flow_json = ?, needs_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, status, flowJson, needsConfig, id).run();
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(id).first<AutomationRow>();
  return json(request, { automation: row ? rowToAutomation(row) : null });
}

async function reorderAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const body = await request.json() as { direction?: "up" | "down" };
  const result = await env.DB.prepare(`SELECT id, priority FROM automations2 WHERE workspace_id = ? ORDER BY priority ASC`).bind(session.workspaceId).all<{ id: string; priority: number }>();
  const list = result.results || [];
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return json(request, { error: "Automation not found." }, 404);
  const swapIdx = body.direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return json(request, { saved: true });
  const a = list[idx]; const b = list[swapIdx];
  await env.DB.batch([
    env.DB.prepare(`UPDATE automations2 SET priority = ? WHERE id = ?`).bind(b.priority, a.id),
    env.DB.prepare(`UPDATE automations2 SET priority = ? WHERE id = ?`).bind(a.priority, b.id),
  ]);
  return json(request, { saved: true });
}

async function deleteAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  await env.DB.prepare(`DELETE FROM automations2 WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).run();
  return json(request, { deleted: true });
}

async function listActivity(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const url = new URL(request.url);
  const automationId = url.searchParams.get("automationId") || "";
  const channel = url.searchParams.get("channel") || "";
  let query = `SELECT * FROM automation_runs WHERE workspace_id = ?`;
  const params: unknown[] = [session.workspaceId];
  if (automationId) { query += ` AND automation_id = ?`; params.push(automationId); }
  if (channel) { query += ` AND channel = ?`; params.push(channel); }
  query += ` ORDER BY created_at DESC LIMIT 100`;
  const result = await env.DB.prepare(query).bind(...params).all<{ id: number; automation_id: string; automation_name: string; contact: string; channel: string; branch_label: string; outcome: string; outcome_type: string; created_at: string }>();
  return json(request, {
    rows: (result.results || []).map((r) => ({ id: r.id, automationId: r.automation_id, automationName: r.automation_name, contact: r.contact, channel: r.channel, branch: r.branch_label, outcome: r.outcome, outcomeType: r.outcome_type, createdAt: r.created_at })),
  });
}

// Lists the workspace's configured AI Action names so the step drawer can offer a real dropdown
// (instead of a free-text field the user has to spell exactly right).
async function listAiActions(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const stored = (await readWorkspaceState<unknown[]>(env.DB, session.workspaceId, "qpy-engage-assistant-actions")) || [];
  const actions = sanitizeActions(stored).map((a) => ({ name: a.name, description: a.description }));
  return json(request, { actions });
}

function describeStepEffect(step: AutomationStep): string {
  const c = step.config || {};
  switch (step.kind) {
    case "message": return `Send message: "${(c.messageText || "").slice(0, 80) || "(empty)"}"`;
    case "aiReply": return "Send a live AI assistant reply";
    case "aiAction": return `Run AI Action: ${c.aiActionName || "(none selected)"}`;
    case "wait": return `Wait ${c.waitAmount ?? 1} ${c.waitUnit || "hours"} (then continue)`;
    case "tag": return `Add tag: ${c.tagName || "(none)"}`;
    case "notify": return `Notify via ${(c.notifyChannels || []).join(" + ") || "(none)"}`;
    case "escalate": return `Escalate to ${c.escalateQueue || "Support queue"} (${c.escalatePriority || "Normal"})`;
    default: return step.title;
  }
}

// Dry-run: walk the tree for a sample message, reporting which branch(es) it takes and the actions
// that would run — without sending anything or writing any side effects. Conditional/time splits
// are evaluated for real; A/B and frequency-cap splits are inherently non-deterministic, so the
// result flags that.
async function dryRunAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<AutomationRow>();
  if (!row) return json(request, { error: "Automation not found." }, 404);
  const body = await request.json().catch(() => ({})) as { message?: string };
  const message = (body.message || "").trim();
  const flow = JSON.parse(row.flow_json) as FlowTree;

  const describeSplit = (split: AutomationStep): { note: string } => {
    const rt = split.config?.ruleType || "conditional";
    if (rt === "ab") return { note: "A/B split — branch chosen at random per message" };
    if (rt === "freq") return { note: "Frequency cap — branch depends on this contact's recent send count" };
    if (rt === "time") return { note: "Time window — branch depends on current day/time" };
    return { note: `Matches if message contains: ${split.config?.condition || "(no keywords set)"}` };
  };

  const branchIdx = await evaluateSplit(env.DB, session.workspaceId, row.id, flow.split1, message, "dry-run");
  const branch = flow.branches[branchIdx];
  const path: Array<{ label: string; note?: string; steps: string[] }> = [];
  path.push({ label: branch.label, note: describeSplit(flow.split1).note, steps: branch.steps.map(describeStepEffect) });

  if (branch.split2 && branch.subBranches) {
    const subIdx = await evaluateSplit(env.DB, session.workspaceId, row.id, branch.split2, message, "dry-run");
    const sub = branch.subBranches[subIdx];
    path.push({ label: sub.label, note: describeSplit(branch.split2).note, steps: sub.steps.map(describeStepEffect) });
  }

  return json(request, { branchIdx, path });
}

// ── Real execution engine ──

function withinTimeWindow(activeDays: string[] | undefined, startTime: string | undefined, endTime: string | undefined, now: Date): boolean {
  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const today = dayKeys[now.getUTCDay()];
  if (activeDays && activeDays.length && !activeDays.includes(today)) return false;
  if (!startTime || !endTime) return true;
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMin = sh * 60 + sm; const endMin = eh * 60 + em;
  return minutesNow >= startMin && minutesNow <= endMin;
}

async function evaluateSplit(db: D1Database, workspaceId: string, automationId: string, split: AutomationStep, message: string, contactKey: string): Promise<0 | 1> {
  const cfg = split.config || {};
  const ruleType = cfg.ruleType || "conditional";
  if (ruleType === "conditional") {
    const keywords = (cfg.condition || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    const lower = message.toLowerCase();
    return keywords.some((k) => lower.includes(k)) ? 0 : 1;
  }
  if (ruleType === "ab") {
    const weightA = cfg.abWeightA ?? 50;
    return Math.random() * 100 < weightA ? 0 : 1;
  }
  if (ruleType === "time") {
    return withinTimeWindow(cfg.activeDays, cfg.startTime, cfg.endTime, new Date()) ? 0 : 1;
  }
  if (ruleType === "freq") {
    const max = cfg.freqMax ?? 3;
    const periodMs = cfg.freqPeriod === "hour" ? 3600_000 : cfg.freqPeriod === "week" ? 7 * 86400_000 : 86400_000;
    const since = new Date(Date.now() - periodMs).toISOString().slice(0, 19).replace("T", " ");
    const count = await db.prepare(`SELECT COUNT(*) as c FROM automation_sends WHERE workspace_id = ? AND automation_id = ? AND contact_key = ? AND sent_at > ?`)
      .bind(workspaceId, automationId, contactKey, since).first<{ c: number }>();
    return (count?.c || 0) < max ? 0 : 1;
  }
  return 1;
}

export type AutomationOutMessage =
  | { type: "text"; text: string }
  | { type: "items"; text?: string; items: Array<{ id: string; name: string; title: string; description: string; price: number; currency: string; imageUrl: string; externalLink: string }> };

// Delivery is channel-specific and injected by the caller: the Web chat widget records an
// assistant row in widget_messages; the WhatsApp webhook (worker/meta.ts) sends a real Cloud API
// message and meters a Service credit. The engine itself stays delivery-agnostic so both channels
// share the exact same branch/step logic. `deliver` returns false if the send failed.
export type RunChannel = "webchat" | "whatsapp";
export interface RunCtx {
  channel: RunChannel;
  contactKey: string;            // widget session_id, or the customer's WhatsApp number
  phoneNumberId?: string;        // whatsapp only — persisted so a resumed wait can still deliver
  deliver: (text: string) => Promise<boolean>;
  persistConversationState: boolean; // web chat has an Inbox surface for tags/escalation; whatsapp doesn't (yet)
}

async function sendSlackNotification(webhookUrl: string, text: string): Promise<void> {
  try { await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); } catch { /* best-effort */ }
}

// Item link params (e.g. a guest's confirmed dates/guest count) are collected by the AI over
// several turns but only actually supplied on the turn it calls show_items — a later turn in the
// same conversation (e.g. "show me other options") may re-call show_items without re-supplying
// them, since nothing forces the model to repeat itself. Persisting the last-known set per
// session and falling back to it closes that gap without relying on the model to remember.
async function loadLinkParams(db: D1Database, workspaceId: string, sessionId: string): Promise<Record<string, string> | undefined> {
  try { await db.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN link_params TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  const row = await db.prepare(`SELECT link_params FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, sessionId).first<{ link_params: string }>();
  if (!row?.link_params) return undefined;
  try { const parsed = JSON.parse(row.link_params); return parsed && typeof parsed === "object" ? parsed : undefined; } catch { return undefined; }
}

async function saveLinkParams(db: D1Database, workspaceId: string, sessionId: string, linkParams: Record<string, string>): Promise<void> {
  try { await db.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN link_params TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
  await db.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, link_params) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, session_id) DO UPDATE SET link_params = excluded.link_params`).bind(workspaceId, sessionId, JSON.stringify(linkParams)).run();
}

// If the model supplied linkParams this turn, that's the freshest/most authoritative set — persist
// it for later turns in the same session. If it didn't (e.g. it re-showed items without repeating
// itself), fall back to whatever was last persisted, instead of sending a bare, param-less link.
// Only applies to web chat, which has the conversation-state surface this relies on (persistConversationState).
async function resolveLinkParams(db: D1Database, workspaceId: string, ctx: RunCtx, freshLinkParams?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (!ctx.persistConversationState) return freshLinkParams;
  if (freshLinkParams && Object.keys(freshLinkParams).length) {
    await saveLinkParams(db, workspaceId, ctx.contactKey, freshLinkParams);
    return freshLinkParams;
  }
  return loadLinkParams(db, workspaceId, ctx.contactKey);
}

async function executeStep(env: AutomationsEnv, workspaceId: string, ctx: RunCtx, automation: AutomationRow, step: AutomationStep, history: ChatMessage[], outMessages: AutomationOutMessage[]): Promise<"continue" | "waiting"> {
  const cfg = step.config || {};
  const send = async (text: string) => {
    outMessages.push({ type: "text", text });
    await ctx.deliver(text);
    await env.DB.prepare(`INSERT INTO automation_sends (workspace_id, automation_id, contact_key) VALUES (?, ?, ?)`).bind(workspaceId, automation.id, ctx.contactKey).run();
  };
  if (step.kind === "message") {
    await send(cfg.messageText || step.subtitle);
    return "continue";
  }
  if (step.kind === "aiReply") {
    if (!env.ANTHROPIC_API_KEY) { await send("Our assistant isn't fully configured yet — a team member will follow up shortly."); return "continue"; }
    const systemPrompt = await buildSystemPrompt(env.DB, workspaceId);
    const catalogItems = await listItemsForWorkspace(env.DB, workspaceId);
    let shownItemIds: string[] = [];
    let shownLinkParams: Record<string, string> | undefined;
    const result = catalogItems.length
      ? await callClaudeWithActions(env.ANTHROPIC_API_KEY, systemPrompt, history, [], undefined, undefined, undefined, catalogItems, async (ids, linkParams) => { shownItemIds = ids; shownLinkParams = linkParams; })
      : await callClaude(env.ANTHROPIC_API_KEY, systemPrompt, history);
    await send(result.reply || "Thanks for reaching out — a team member will follow up shortly.");
    if (shownItemIds.length) {
      const linkParams = await resolveLinkParams(env.DB, workspaceId, ctx, shownLinkParams);
      const items = withLinkParams(await getItemsByIds(env.DB, workspaceId, shownItemIds), linkParams);
      if (items.length) outMessages.push({ type: "items", items });
    }
    return "continue";
  }
  if (step.kind === "aiAction") {
    if (!env.ANTHROPIC_API_KEY) { await send("One moment — checking on that for you."); return "continue"; }
    const storedActions = (await readWorkspaceState<unknown[]>(env.DB, workspaceId, "qpy-engage-assistant-actions")) || [];
    const actions: AssistantActionDef[] = sanitizeActions(storedActions).filter((a) => a.name.toLowerCase() === (cfg.aiActionName || "").toLowerCase());
    const systemPrompt = await buildSystemPrompt(env.DB, workspaceId) + `\n\nIf relevant, use the "${cfg.aiActionName}" tool to help answer this.`;
    const catalogItems = await listItemsForWorkspace(env.DB, workspaceId);
    let shownItemIds: string[] = [];
    let shownLinkParams: Record<string, string> | undefined;
    const result = await callClaudeWithActions(env.ANTHROPIC_API_KEY, systemPrompt, history, actions, undefined, undefined, undefined, catalogItems, async (ids, linkParams) => { shownItemIds = ids; shownLinkParams = linkParams; });
    await send(result.reply || "Let me look into that and get back to you.");
    if (shownItemIds.length) {
      const linkParams = await resolveLinkParams(env.DB, workspaceId, ctx, shownLinkParams);
      const items = withLinkParams(await getItemsByIds(env.DB, workspaceId, shownItemIds), linkParams);
      if (items.length) outMessages.push({ type: "items", items });
    }
    return "continue";
  }
  if (step.kind === "tag" && ctx.persistConversationState) {
    try { await env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN tags TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
    const existing = await env.DB.prepare(`SELECT tags FROM widget_conversation_state WHERE workspace_id = ? AND session_id = ?`).bind(workspaceId, ctx.contactKey).first<{ tags: string }>();
    const tags = new Set((existing?.tags || "").split(",").map((t) => t.trim()).filter(Boolean));
    if (cfg.tagName) tags.add(cfg.tagName);
    await env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, tags) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, session_id) DO UPDATE SET tags = excluded.tags`).bind(workspaceId, ctx.contactKey, [...tags].join(",")).run();
    return "continue";
  }
  if (step.kind === "escalate" && ctx.persistConversationState) {
    try { await env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN queue_name TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
    try { await env.DB.prepare(`ALTER TABLE widget_conversation_state ADD COLUMN queue_priority TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already exists */ }
    await env.DB.prepare(`INSERT INTO widget_conversation_state (workspace_id, session_id, needs_attention, attention_reason, queue_name, queue_priority) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(workspace_id, session_id) DO UPDATE SET needs_attention = 1, attention_reason = excluded.attention_reason, queue_name = excluded.queue_name, queue_priority = excluded.queue_priority`)
      .bind(workspaceId, ctx.contactKey, `Automation: ${automation.name}`, cfg.escalateQueue || "Support queue", cfg.escalatePriority || "Normal").run();
    return "continue";
  }
  if (step.kind === "notify") {
    const workspaceSettings = await readWorkspaceState<{ slackWebhookUrl?: string }>(env.DB, workspaceId, "qpy-engage-automation-settings");
    if ((cfg.notifyChannels || []).includes("slack") && workspaceSettings?.slackWebhookUrl) {
      await sendSlackNotification(workspaceSettings.slackWebhookUrl, `[${automation.name}] ${step.subtitle}`);
    }
    // Email delivery requires a connected provider — honestly not wired up yet (no SMTP/Resend
    // credentials exist in this project). The notification intent is still recorded for real
    // via the Activity log entry the caller writes after this step runs.
    return "continue";
  }
  if (step.kind === "wait") {
    return "waiting";
  }
  // tag/escalate on a channel without a conversation-state surface (whatsapp), or generic/trigger/split.
  return "continue";
}

function waitDueDate(cfg: AutomationStep["config"]): string {
  const amount = cfg?.waitAmount ?? 1;
  const unit = cfg?.waitUnit ?? "hours";
  const ms = unit === "minutes" ? amount * 60_000 : unit === "days" ? amount * 86_400_000 : amount * 3_600_000;
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");
}

type ResumePath = { branchIdx: 0 | 1; subBranchIdx?: 0 | 1; stepIdx: number };

async function runStepsFrom(env: AutomationsEnv, workspaceId: string, ctx: RunCtx, automation: AutomationRow, steps: AutomationStep[], startIdx: number, history: ChatMessage[], resumePathBase: Omit<ResumePath, "stepIdx">): Promise<{ messages: AutomationOutMessage[]; waiting: boolean }> {
  const messages: AutomationOutMessage[] = [];
  for (let i = startIdx; i < steps.length; i++) {
    const outcome = await executeStep(env, workspaceId, ctx, automation, steps[i], history, messages);
    if (outcome === "waiting") {
      const dueAt = waitDueDate(steps[i].config);
      const resumePath: ResumePath = { ...resumePathBase, stepIdx: i + 1 };
      await env.DB.prepare(`INSERT INTO automation_waits (workspace_id, automation_id, session_id, contact_key, channel, phone_number_id, resume_path, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(workspaceId, automation.id, ctx.contactKey, ctx.contactKey, ctx.channel, ctx.phoneNumberId || "", JSON.stringify(resumePath), dueAt).run();
      return { messages, waiting: true };
    }
  }
  return { messages, waiting: false };
}

export interface AutomationRunResult { handled: boolean; messages: AutomationOutMessage[]; automationName?: string; branchLabel?: string }

// Channel-agnostic core: selects the first active automation whose trigger includes this channel,
// evaluates the split(s), runs the matching branch's steps, and writes an Activity-log row. All
// delivery goes through ctx.deliver so Web chat and WhatsApp share this identical logic.
export async function runAutomations(env: AutomationsEnv, workspaceId: string, channel: RunChannel, ctx: RunCtx, message: string, history: ChatMessage[]): Promise<AutomationRunResult> {
  await ensureAutomationsSchema(env.DB);
  const result = await env.DB.prepare(`SELECT * FROM automations2 WHERE workspace_id = ? AND status = 'active' ORDER BY priority ASC`).bind(workspaceId).all<AutomationRow>();
  const active = (result.results || []).filter((a) => {
    const flow = JSON.parse(a.flow_json) as FlowTree;
    return (flow.trigger.config?.channels || []).includes(channel);
  });
  if (!active.length) return { handled: false, messages: [] };

  const automation = active[0]; // first match wins — later active automations skipped for this message
  const flow = JSON.parse(automation.flow_json) as FlowTree;
  const branchIdx = await evaluateSplit(env.DB, workspaceId, automation.id, flow.split1, message, ctx.contactKey);
  const branch1 = flow.branches[branchIdx];

  const { messages: branchMessages, waiting: waiting1 } = await runStepsFrom(env, workspaceId, ctx, automation, branch1.steps, 0, history, { branchIdx: branchIdx as 0 | 1 });
  let allMessages = branchMessages;
  let branchLabel = branch1.label;
  let waiting = waiting1;
  let executedSteps = branch1.steps;

  if (!waiting1 && branch1.split2 && branch1.subBranches) {
    const subIdx = await evaluateSplit(env.DB, workspaceId, automation.id, branch1.split2, message, ctx.contactKey);
    const subBranch = branch1.subBranches[subIdx];
    const { messages: subMessages, waiting: waiting2 } = await runStepsFrom(env, workspaceId, ctx, automation, subBranch.steps, 0, history, { branchIdx: branchIdx as 0 | 1, subBranchIdx: subIdx as 0 | 1 });
    allMessages = [...allMessages, ...subMessages];
    branchLabel = `${branch1.label} → ${subBranch.label}`;
    waiting = waiting2;
    executedSteps = [...branch1.steps, ...subBranch.steps];
  }

  const wasEscalated = executedSteps.some((s) => s.kind === "escalate");
  const outcome = waiting ? "Waiting" : wasEscalated ? "Escalated" : "Resolved by AI";
  const outcomeType = outcome === "Escalated" ? "warn" : "good";
  const channelLabel = channel === "whatsapp" ? "WhatsApp" : "Web chat";
  await env.DB.prepare(`INSERT INTO automation_runs (workspace_id, automation_id, automation_name, contact, channel, branch_label, outcome, outcome_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(workspaceId, automation.id, automation.name, ctx.contactKey.slice(0, 14), channelLabel, branchLabel, outcome, outcomeType).run();

  return { handled: true, messages: allMessages, automationName: automation.name, branchLabel };
}

// Web chat wrapper: delivery records an assistant row in widget_messages (the widget's poll loop
// then shows it). Called from worker/widget.ts's respond() before the bare-AI fallback.
export async function runAutomationsForWidgetMessage(env: AutomationsEnv, workspaceId: string, sessionId: string, message: string, history: ChatMessage[]): Promise<AutomationRunResult> {
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

// Resumes any due "wait" steps — called from the scheduled (cron) handler. `makeDeliver` lets the
// caller supply a channel-appropriate sender (worker/index.ts builds a WhatsApp one when needed),
// since delivering from a background tick needs the same channel plumbing as a live message.
export async function resumeDueAutomationWaits(env: AutomationsEnv, makeDeliver: (row: { workspace_id: string; channel: string; contact_key: string; phone_number_id: string }) => ((text: string) => Promise<boolean>) | null): Promise<number> {
  await ensureAutomationsSchema(env.DB);
  const now = sqliteNow();
  const due = await env.DB.prepare(`SELECT * FROM automation_waits WHERE due_at <= ? LIMIT 25`).bind(now).all<{ id: number; workspace_id: string; automation_id: string; session_id: string; contact_key: string; channel: string; phone_number_id: string; resume_path: string }>();
  let resumed = 0;
  for (const row of due.results || []) {
    const automationRow = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(row.automation_id).first<AutomationRow>();
    await env.DB.prepare(`DELETE FROM automation_waits WHERE id = ?`).bind(row.id).run();
    if (!automationRow) continue;
    const deliver = makeDeliver({ workspace_id: row.workspace_id, channel: row.channel, contact_key: row.contact_key || row.session_id, phone_number_id: row.phone_number_id });
    if (!deliver) continue; // channel no longer deliverable (e.g. WhatsApp disconnected) — drop the resume
    const ctx: RunCtx = {
      channel: row.channel === "whatsapp" ? "whatsapp" : "webchat",
      contactKey: row.contact_key || row.session_id,
      phoneNumberId: row.phone_number_id || undefined,
      persistConversationState: row.channel !== "whatsapp",
      deliver,
    };
    const flow = JSON.parse(automationRow.flow_json) as FlowTree;
    const path = JSON.parse(row.resume_path) as ResumePath;
    const branch = flow.branches[path.branchIdx];
    const steps = path.subBranchIdx !== undefined && branch.subBranches ? branch.subBranches[path.subBranchIdx].steps : branch.steps;
    await runStepsFrom(env, row.workspace_id, ctx, automationRow, steps, path.stepIdx, [], { branchIdx: path.branchIdx, subBranchIdx: path.subBranchIdx });
    resumed++;
  }
  return resumed;
}

export async function handleAutomationsRequest(request: Request, env: AutomationsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/automations")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/automations" && request.method === "GET") return listAutomations(request, env);
  if (url.pathname === "/api/automations" && request.method === "POST") return createBlank(request, env);
  if (url.pathname === "/api/automations/sectors" && request.method === "GET") return listSectors(request, env);
  if (url.pathname === "/api/automations/from-template" && request.method === "POST") return createFromTemplate(request, env);
  if (url.pathname === "/api/automations/activity" && request.method === "GET") return listActivity(request, env);
  if (url.pathname === "/api/automations/ai-actions" && request.method === "GET") return listAiActions(request, env);
  const reorderMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/reorder$/);
  if (reorderMatch && request.method === "POST") return reorderAutomation(request, env, reorderMatch[1]);
  const testMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/test$/);
  if (testMatch && request.method === "POST") return dryRunAutomation(request, env, testMatch[1]);
  const match = url.pathname.match(/^\/api\/automations\/([^/]+)$/);
  if (match && request.method === "PATCH") return updateAutomation(request, env, match[1]);
  if (match && request.method === "DELETE") return deleteAutomation(request, env, match[1]);
  return json(request, { error: "Not found" }, 404);
}
