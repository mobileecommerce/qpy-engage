import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin, sanitizeActions } from "./shared";
import { readWorkspaceState } from "./widget";
import {
  toGraph, sanitizeGraph, buildUrlFromTemplate, graphNeedsConfig, nodeAwaitsInput,
  type AutomationGraph, type AutomationNode,
} from "./automation-graph";
import { ensureSessionSchema } from "./automation-session";
import { evaluateSplit } from "./automation-engine";

export interface AutomationsEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

function uid(): string { return crypto.randomUUID(); }

// ── Types ──
// The stored/served shape is now the v2 node graph (worker/automation-graph.ts). The v1 tree types
// below survive only as the authoring format for the built-in sector templates, which are converted
// through the same migrateV1ToV2 path as legacy stored automations.

export type { AutomationGraph, AutomationNode, NodeConfig, NodeKind } from "./automation-graph";
export type Automation = { id: string; name: string; sectorKey: string; status: "active" | "draft" | "inactive"; priority: number; needsConfig: boolean; flow: AutomationGraph; createdAt?: string; updatedAt?: string };

type StepKind = "trigger" | "split" | "aiReply" | "message" | "wait" | "tag" | "notify" | "aiAction" | "escalate" | "generic";
type TemplateStep = { id: string; icon: string; title: string; subtitle: string; chip: string; kind: StepKind; config?: Record<string, unknown> };
type TemplateSub = { id: string; label: string; color: string; steps: TemplateStep[] };
type TemplateBranch = TemplateSub & { split2?: TemplateStep; subBranches?: [TemplateSub, TemplateSub] };
type TemplateFlow = { trigger: TemplateStep; split1: TemplateStep; branches: [TemplateBranch, TemplateBranch] };

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
  await ensureSessionSchema(db);
  automationsSchemaEnsured = true;
}

// ── The 8 real industry starter flows — ported verbatim from the design file's SECTOR_FLOWS,
// with an explicit `kind`/`config` assigned per step (the design's mock inferred `kind` from
// title text at render time; here it's assigned once, directly, since this drives real
// execution behavior, not just which config-drawer fields to show). ──

function step(icon: string, title: string, subtitle: string, chip: string, kind: StepKind, config?: Record<string, unknown>): TemplateStep {
  return { id: uid(), icon, title, subtitle, chip, kind, config };
}
function splitStep(title: string, subtitle: string, config?: Record<string, unknown>): TemplateStep {
  return { id: uid(), icon: "⑂", title, subtitle, chip: "purple", kind: "split", config: { ruleType: "conditional", ...config } };
}
function branch(label: string, color: string, steps: TemplateStep[], split2?: TemplateStep, subBranches?: [TemplateSub, TemplateSub]): TemplateBranch {
  return { id: uid(), label, color, steps, split2, subBranches };
}
function sub(label: string, color: string, steps: TemplateStep[]): TemplateSub {
  return { id: uid(), label, color, steps };
}

// A menu-tree template authored directly in the v2 graph shape — this is the pattern that v1 simply
// could not express: one prompt fanning out to many options, each option owning its own sub-tree, and
// a "Main menu" option looping all the way back to the top.
function serviceDeskGraph(): AutomationGraph {
  const n = (id: string, node: Omit<AutomationNode, "id">): [string, AutomationNode] => [id, { id, ...node }];
  const nodes = Object.fromEntries([
    n("sd-trigger", { kind: "trigger", title: "New message received", subtitle: "Any inbound message starts the menu", next: "sd-main", config: { channels: ["webchat"] } }),
    n("sd-main", {
      kind: "buttons", title: "Main menu", subtitle: "Top-level choice",
      config: {
        messageText: "Hello, how may we help you?",
        options: [
          { id: "o1", label: "Our Services", next: "sd-services" },
          { id: "o2", label: "General Information", next: "sd-info" },
          { id: "o3", label: "Speak to an Agent", next: "sd-agent" },
        ],
      },
    }),
    n("sd-services", {
      kind: "buttons", title: "Service list", subtitle: "As many options as the business needs",
      config: {
        messageText: "Please select a service:",
        options: [
          { id: "s1", label: "New Application", description: "Start a fresh application", next: "sd-apply-type" },
          { id: "s2", label: "Renewal", description: "Renew an existing licence or permit", next: "sd-renewal" },
          { id: "s3", label: "Fees & Payments", next: "sd-fees" },
          { id: "s4", label: "Track a Request", next: "sd-track" },
          { id: "s5", label: "Main Menu", next: "sd-main" },
        ],
      },
    }),
    n("sd-apply-type", {
      kind: "buttons", title: "Application category", subtitle: "A sub-menu under one option",
      config: {
        messageText: "Which category applies to you?",
        options: [
          { id: "a1", label: "Individual", next: "sd-apply-info" },
          { id: "a2", label: "Company", next: "sd-apply-info" },
          { id: "a3", label: "Back", next: "sd-services" },
        ],
      },
    }),
    n("sd-apply-info", {
      kind: "message", title: "Requirements", subtitle: "Static info block",
      next: "sd-apply-next",
      config: { messageText: "Requirements:\n\nPassport copy\nPersonal photo with a white background\nProof of address\nCompleted application form" },
    }),
    n("sd-apply-next", {
      kind: "buttons", title: "Next step", subtitle: "Where the customer goes from here",
      config: {
        messageText: "Please choose one of the below options:",
        options: [
          { id: "n1", label: "Submit Application", next: "sd-collect-name" },
          { id: "n2", label: "Speak to an Agent", next: "sd-agent" },
          { id: "n3", label: "Main Menu", next: "sd-main" },
        ],
      },
    }),
    n("sd-collect-name", { kind: "question", title: "Ask for name", next: "sd-collect-email", config: { messageText: "What name should the application be filed under?", variableKey: "applicant_name", inputType: "text" } }),
    n("sd-collect-email", { kind: "question", title: "Ask for email", next: "sd-collect-done", config: { messageText: "And the best email to send updates to?", variableKey: "applicant_email", inputType: "email" } }),
    n("sd-collect-done", { kind: "message", title: "Confirm receipt", next: "sd-agent", config: { messageText: "Thank you {{applicant_name}} — we have your details and will send updates to {{applicant_email}}." } }),
    n("sd-renewal", { kind: "message", title: "Renewal info", next: "sd-apply-next", config: { messageText: "Renewals open 30 days before expiry. You'll need your existing licence number and a valid payment method." } }),
    n("sd-fees", { kind: "message", title: "Fees info", next: "sd-apply-next", config: { messageText: "Fees depend on the service and category. An agent can confirm the exact amount for your case." } }),
    n("sd-track", { kind: "question", title: "Ask for reference", next: "sd-track-handoff", config: { messageText: "Please send your request reference number.", variableKey: "reference", inputType: "text" } }),
    n("sd-track-handoff", { kind: "message", title: "Tracking handoff", next: "sd-agent", config: { messageText: "Thanks — checking reference {{reference}} for you now." } }),
    n("sd-agent", { kind: "escalate", title: "Transfer to a human", next: "sd-agent-msg", config: { escalateQueue: "Support queue", escalatePriority: "Normal" } }),
    n("sd-agent-msg", { kind: "message", title: "Handoff notice", next: "sd-end", config: { messageText: "You are being transferred to one of our team now. Please wait, we will respond as soon as possible." } }),
    n("sd-info", {
      kind: "buttons", title: "General information",
      config: {
        messageText: "What would you like to know?",
        options: [
          { id: "g1", label: "Working Hours", next: "sd-hours" },
          { id: "g2", label: "Location", next: "sd-location" },
          { id: "g3", label: "Main Menu", next: "sd-main" },
        ],
      },
    }),
    n("sd-hours", { kind: "message", title: "Working hours", next: "sd-info", config: { messageText: "We're open Monday to Friday, 8am to 6pm." } }),
    n("sd-location", { kind: "message", title: "Location", next: "sd-info", config: { messageText: "Share your address here, or point customers at a map link." } }),
    n("sd-end", { kind: "end", title: "End of flow" }),
  ]);
  return { version: 2, entryId: "sd-trigger", nodes };
}

function sectorFlows(): Record<string, { name: string; icon: string; desc: string; flow: TemplateFlow | AutomationGraph }> {
  const trigger = (subtitle: string): TemplateStep => step("💬", "New message received", subtitle, "rose", "trigger", { channels: ["whatsapp", "webchat"] });
  return {
    servicedesk: {
      name: "Service Desk Menu", icon: "▤",
      desc: "A tappable menu tree — many options per prompt, nested sub-menus, loop-back to the main menu, and a real human handoff. No AI required.",
      flow: serviceDeskGraph(),
    },
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

export const SECTOR_ORDER = ["servicedesk", "general", "fnb", "hotels", "grocery", "realestate", "healthcare", "schools", "universities"];

// ── CRUD ──

// Node completeness now lives in worker/automation-graph.ts (nodeIsIncomplete / graphNeedsConfig)
// so the engine, the API and the dashboard all judge it the same way. Re-exported under the old
// names too, since the dashboard's mirror imports them.
export { nodeIsIncomplete, graphNeedsConfig } from "./automation-graph";

type AutomationRow = { id: string; name: string; sector_key: string; status: string; priority: number; needs_config: number; flow_json: string; created_at: string; updated_at: string };

function rowToAutomation(row: AutomationRow): Automation {
  return {
    id: row.id, name: row.name, sectorKey: row.sector_key,
    status: row.status === "active" ? "active" : row.status === "inactive" ? "inactive" : "draft",
    priority: row.priority, needsConfig: Boolean(row.needs_config),
    flow: toGraph(JSON.parse(row.flow_json)),
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

// A brand-new automation starts as the smallest useful real graph: a trigger into a menu the owner
// can immediately extend, since "add an option" is now the primitive that grows the tree.
function blankGraph(): AutomationGraph {
  const triggerId = uid();
  const menuId = uid();
  return {
    version: 2,
    entryId: triggerId,
    nodes: {
      [triggerId]: { id: triggerId, kind: "trigger", title: "New message received", subtitle: "Click to choose which channels trigger this automation", next: menuId, config: { channels: ["webchat"] } },
      [menuId]: { id: menuId, kind: "buttons", title: "Ask a question", subtitle: "Click to write the prompt and its options", next: null, config: { messageText: "", options: [] } },
    },
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
  const graph = blankGraph();
  await env.DB.prepare(`INSERT INTO automations2 (id, workspace_id, name, sector_key, status, priority, needs_config, flow_json) VALUES (?, ?, ?, 'custom', 'draft', ?, ?, ?)`)
    .bind(id, session.workspaceId, name, priority, graphNeedsConfig(graph) ? 1 : 0, JSON.stringify(graph)).run();
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
  const graph = toGraph(template.flow);
  await env.DB.prepare(`INSERT INTO automations2 (id, workspace_id, name, sector_key, status, priority, needs_config, flow_json) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
    .bind(id, session.workspaceId, name, sectorKey, priority, graphNeedsConfig(graph) ? 1 : 0, JSON.stringify(graph)).run();
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ?`).bind(id).first<AutomationRow>();
  return json(request, { automation: row ? rowToAutomation(row) : null });
}

async function updateAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<AutomationRow>();
  if (!existing) return json(request, { error: "Automation not found." }, 404);
  const body = await request.json() as { name?: string; status?: string; flow?: unknown; needsConfig?: boolean };
  const name = body.name !== undefined ? body.name.trim().slice(0, 120) || existing.name : existing.name;
  const status = body.status !== undefined && ["active", "draft", "inactive"].includes(body.status) ? body.status : existing.status;
  const graph = body.flow !== undefined ? (sanitizeGraph(body.flow) || toGraph(body.flow)) : toGraph(JSON.parse(existing.flow_json));
  const flowJson = JSON.stringify(graph);
  // needsConfig is always derived from the flow's real completeness — the badge clears itself once
  // every step's required field is filled in, and reappears if something is emptied.
  const needsConfig = graphNeedsConfig(graph) ? 1 : 0;
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

// Lets a business owner verify their "Collect & Link" URL template actually works against the real
// destination BEFORE it ever reaches a customer — real code does the substitution, same as production,
// so the preview is exactly what a customer would get, not a guess.
async function testLink(request: Request, env: AutomationsEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { template?: string; values?: Record<string, unknown> };
  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!template) return json(request, { error: "A link template is required." }, 400);
  const values = body.values && typeof body.values === "object" ? body.values : {};
  const url = buildUrlFromTemplate(template, values as Record<string, unknown>);
  try { new URL(url); } catch { return json(request, { error: "That template didn't produce a valid URL — check the base address." }, 400); }
  return json(request, { url });
}

function describeNodeEffect(node: AutomationNode): string {
  const c = node.config || {};
  switch (node.kind) {
    case "trigger": return `Trigger on: ${(c.channels || []).join(" + ") || "(no channels)"}`;
    case "message": return `Send message: "${(c.messageText || "").slice(0, 80) || "(empty)"}"`;
    case "buttons": return `Ask "${(c.messageText || "").slice(0, 50)}" with options: ${(c.options || []).map((o) => o.label).join(" / ") || "(none)"}`;
    case "question": return `Ask "${(c.messageText || "").slice(0, 50)}" → store as {${c.variableKey || "?"}}`;
    case "items": return `Show ${(c.itemIds || []).length} catalog item card(s)`;
    case "aiReply": return "Hand the conversation to the AI assistant";
    case "aiAction": return `AI reply with action: ${c.aiActionName || "(none selected)"}`;
    case "split": return `Branch on ${c.ruleType || "conditional"} rule`;
    case "wait": return `Wait ${c.waitAmount ?? 1} ${c.waitUnit || "hours"} (then continue)`;
    case "tag": return `Add tag: ${c.tagName || "(none)"}`;
    case "notify": return `Notify via ${(c.notifyChannels || []).join(" + ") || "(none)"}`;
    case "escalate": return `Escalate to ${c.escalateQueue || "Support queue"} (${c.escalatePriority || "Normal"})`;
    case "end": return "End the conversation flow";
  }
  return node.title;
}

// Dry-run: walk the real graph for a sample message and report the exact node sequence it would take
// until it stops to wait for the customer — with no sends and no side effects. Split rules are
// evaluated for real; A/B and frequency splits are inherently non-deterministic, so those are noted
// rather than presented as the one true answer.
async function dryRunAutomation(request: Request, env: AutomationsEnv, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureAutomationsSchema(env.DB);
  const row = await env.DB.prepare(`SELECT * FROM automations2 WHERE id = ? AND workspace_id = ?`).bind(id, session.workspaceId).first<AutomationRow>();
  if (!row) return json(request, { error: "Automation not found." }, 404);
  const body = await request.json().catch(() => ({})) as { message?: string };
  const message = (body.message || "").trim();
  const graph = toGraph(JSON.parse(row.flow_json));

  const noteFor = (node: AutomationNode): string | undefined => {
    if (node.kind !== "split") return undefined;
    const rt = node.config?.ruleType || "conditional";
    if (rt === "ab") return "A/B split — the branch is chosen at random per message";
    if (rt === "freq") return "Frequency cap — depends on this contact's recent send count";
    if (rt === "time") return "Time window — depends on the current day/time";
    return `Cases: ${(node.config?.cases || []).map((k) => `${k.label} if message contains "${k.match || ""}"`).join("; ") || "(none set)"}`;
  };

  const path: Array<{ label: string; note?: string; steps: string[] }> = [];
  const seen = new Set<string>();
  let currentId: string | null = graph.entryId;
  let guard = 0;

  while (currentId && guard++ < 40) {
    const node: AutomationNode | undefined = graph.nodes[currentId];
    if (!node) break;
    path.push({ label: node.title, note: noteFor(node), steps: [describeNodeEffect(node)] });
    // A cycle is legal at runtime (a customer taps "Main menu" again) but a trace must not loop.
    if (seen.has(node.id)) { path.push({ label: "↩ Loops back", note: "This path returns to a node already shown above", steps: [] }); break; }
    seen.add(node.id);

    if (node.kind === "split") { currentId = (await evaluateSplit(env.DB, session.workspaceId, row.id, node, message, "dry-run")).next; continue; }
    if (nodeAwaitsInput(node.kind)) {
      const waitLabel = node.kind === "buttons" ? "Waits for the customer to pick an option" : node.kind === "question" ? "Waits for the customer's answer" : "Waits for the customer's next message";
      path.push({ label: `⏸ ${waitLabel}`, steps: [] });
      break;
    }
    if (node.kind === "end") break;
    currentId = node.next ?? null;
  }

  return json(request, { path });
}

// ── Execution engine ──
// The engine now lives in worker/automation-engine.ts (graph walk, node execution, session cursor).
// Re-exported here so existing importers (worker/index.ts, worker/meta.ts, worker/widget.ts) keep
// working against the same module they always did.
export {
  runAutomations,
  runAutomationsForWidgetMessage,
  resumeDueAutomationWaits,
  type RunCtx,
  type RunChannel,
  type AutomationOutMessage,
  type AutomationRunResult,
} from "./automation-engine";

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
  if (url.pathname === "/api/automations/test-link" && request.method === "POST") return testLink(request, env);
  const reorderMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/reorder$/);
  if (reorderMatch && request.method === "POST") return reorderAutomation(request, env, reorderMatch[1]);
  const testMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/test$/);
  if (testMatch && request.method === "POST") return dryRunAutomation(request, env, testMatch[1]);
  const match = url.pathname.match(/^\/api\/automations\/([^/]+)$/);
  if (match && request.method === "PATCH") return updateAutomation(request, env, match[1]);
  if (match && request.method === "DELETE") return deleteAutomation(request, env, match[1]);
  return json(request, { error: "Not found" }, 404);
}
