export const encoder = new TextEncoder();

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const host = new URL(origin).hostname;
  if (origin === "https://mobileecommerce.github.io" || host.endsWith(".chatgpt.site") || host === "localhost" || host === "127.0.0.1") return origin;
  return null;
}

export function json(request: Request, body: unknown, status = 200): Response {
  const origin = allowedOrigin(request);
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function corsPreflight(request: Request): Response {
  const origin = allowedOrigin(request);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "origin",
  } });
}

export async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  const aa = new Uint8Array(a); const bb = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < aa.length; index++) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export const ANTHROPIC_MODEL = "claude-sonnet-5";
export const MAX_HISTORY_TURNS = 20;
export const MAX_SYSTEM_PROMPT_LENGTH = 8000;
export const MAX_MESSAGE_LENGTH = 4000;

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function sanitizeChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is ChatMessage => Boolean(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));
}

export async function callClaude(apiKey: string, systemPrompt: string, messages: ChatMessage[]): Promise<{ reply?: string; error?: string; status?: number }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH) || undefined,
      messages,
    }),
  });

  if (!response.ok) {
    let message = `AI provider returned HTTP ${response.status}.`;
    try {
      const errorPayload = await response.json() as { error?: { message?: string } };
      if (errorPayload.error?.message) message = errorPayload.error.message;
    } catch { /* keep default message */ }
    return { error: message, status: 502 };
  }

  const payload = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const reply = (payload.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("")
    .trim();

  if (!reply) return { error: "The assistant didn't return a response.", status: 502 };
  return { reply };
}

export type ActionParameter = { name: string; type: "text" | "number" | "email" | "phone" | "boolean"; required: boolean; description: string };
export type AssistantActionDef = {
  name: string; description: string; parameters: ActionParameter[];
  endpoint: string; method: "POST" | "GET"; defaultResponse: string; enabled: boolean;
  type: "submit" | "request";
};
export type RecordSubmission = (actionName: string, data: Record<string, unknown>) => Promise<void>;

const MAX_ACTIONS = 10;
const MAX_ACTION_PARAMETERS = 12;
const ACTION_TIMEOUT_MS = 8000;
const MAX_TOOL_RESULT_LENGTH = 2000;
const MAX_TOOL_ITERATIONS = 3;

export function sanitizeActions(raw: unknown): AssistantActionDef[] {
  if (!Array.isArray(raw)) return [];
  const actions: AssistantActionDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (!a.enabled) continue;
    const name = typeof a.name === "string" ? a.name.trim().slice(0, 80) : "";
    const endpoint = typeof a.endpoint === "string" ? a.endpoint.trim() : "";
    if (!name || !/^https?:\/\//i.test(endpoint)) continue;
    const method = a.method === "GET" ? "GET" : "POST";
    const parameters: ActionParameter[] = Array.isArray(a.parameters)
      ? a.parameters.slice(0, MAX_ACTION_PARAMETERS).filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .map((p) => ({
          name: String(p.name ?? "").trim().slice(0, 60),
          type: (["text", "number", "email", "phone", "boolean"].includes(p.type as string) ? p.type : "text") as ActionParameter["type"],
          required: Boolean(p.required),
          description: String(p.description ?? "").slice(0, 200),
        })).filter((p) => p.name)
      : [];
    actions.push({
      name, endpoint, method, parameters,
      description: typeof a.description === "string" ? a.description.slice(0, 400) : "",
      defaultResponse: typeof a.defaultResponse === "string" ? a.defaultResponse.slice(0, 400) : "I couldn't complete that action — I'll connect you with the team.",
      enabled: true,
      type: a.type === "request" ? "request" : "submit",
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return actions;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
}

type ToolDef = { name: string; description: string; input_schema: { type: "object"; properties: Record<string, { type: string; description?: string; items?: { type: string } }>; required: string[] } };

function toolNameFor(name: string, index: number, used: Set<string>): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || `action_${index}`;
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function jsonSchemaType(type: ActionParameter["type"]): string {
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

function buildTools(actions: AssistantActionDef[]): { tools: ToolDef[]; nameToAction: Map<string, AssistantActionDef> } {
  const used = new Set<string>();
  const nameToAction = new Map<string, AssistantActionDef>();
  const tools = actions.map((action, index) => {
    const toolName = toolNameFor(action.name, index, used);
    nameToAction.set(toolName, action);
    const properties: Record<string, { type: string; description?: string }> = {};
    for (const p of action.parameters) properties[p.name] = { type: jsonSchemaType(p.type), description: p.description || undefined };
    return {
      name: toolName,
      description: action.description || action.name,
      input_schema: { type: "object" as const, properties, required: action.parameters.filter((p) => p.required).map((p) => p.name) },
    };
  });
  return { tools, nameToAction };
}

export async function testAction(action: AssistantActionDef, input: Record<string, unknown>): Promise<{ ok: boolean; resultText: string }> {
  try {
    const url = new URL(action.endpoint);
    if (isBlockedHost(url.hostname)) return { ok: false, resultText: action.defaultResponse };
    let requestUrl = url.toString();
    const init: RequestInit = { method: action.method, signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) };
    if (action.method === "GET") {
      for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
      requestUrl = url.toString();
    } else {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(input);
    }
    const response = await fetch(requestUrl, init);
    const text = (await response.text()).slice(0, MAX_TOOL_RESULT_LENGTH);
    if (!response.ok) return { ok: false, resultText: `The business system returned an error (HTTP ${response.status}). ${action.defaultResponse}` };
    return { ok: true, resultText: text || "The action completed successfully with no response body." };
  } catch {
    return { ok: false, resultText: `Could not reach the business system for this action. ${action.defaultResponse}` };
  }
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

const NAME_TOOL_NAME = "record_customer_name";
const NEEDS_HUMAN_TOOL_NAME = "flag_for_human";
const SHOW_ITEMS_TOOL_NAME = "show_items";

export type CatalogItemRef = { id: string; name: string; price: number; currency: string };

export async function callClaudeWithActions(
  apiKey: string, systemPrompt: string, messages: ChatMessage[], actions: AssistantActionDef[],
  recordSubmission?: RecordSubmission,
  onCustomerName?: (name: string) => Promise<void>,
  onNeedsHuman?: (reason: string) => Promise<void>,
  catalogItems?: CatalogItemRef[],
  onShowItems?: (itemIds: string[]) => Promise<void>,
): Promise<{ reply?: string; error?: string; status?: number }> {
  if (!actions.length && !onCustomerName && !onNeedsHuman && !catalogItems?.length) return callClaude(apiKey, systemPrompt, messages);

  const { tools, nameToAction } = buildTools(actions);
  // Available in every conversation regardless of what AI Actions the business configured —
  // lets the dashboard show the customer's real name once the assistant naturally learns it,
  // even when no formal lead-capture action ever fires.
  if (onCustomerName) {
    tools.push({
      name: NAME_TOOL_NAME,
      description: "Call this once, silently, whenever the customer states or clearly implies their own name during the conversation. Never mention that you're doing this.",
      input_schema: { type: "object", properties: { name: { type: "string", description: "The customer's name, as they gave it." } }, required: ["name"] },
    });
  }
  if (onNeedsHuman) {
    tools.push({
      name: NEEDS_HUMAN_TOOL_NAME,
      description: "Call this when the customer explicitly insists on speaking with a human/agent after you've already tried to help or asked what they need — see the business hours and handoff instructions above for exactly when to call this.",
      input_schema: { type: "object", properties: { reason: { type: "string", description: "One short phrase summarizing what the customer needs, for the team's dashboard." } }, required: ["reason"] },
    });
  }
  if (catalogItems?.length && onShowItems) {
    const listing = catalogItems.map((it) => `${it.id}: ${it.name} (${it.currency} ${it.price || "price not listed"})`).join("; ");
    tools.push({
      name: SHOW_ITEMS_TOOL_NAME,
      description: `Call this once you're ready to show the customer one or more catalog items as visual cards (e.g. rooms, menu items, products) — never describe them yourself in text instead. Available items: ${listing}`,
      input_schema: {
        type: "object",
        properties: { itemIds: { type: "array", items: { type: "string" }, description: "The ids of the specific catalog items to show, from the available items list." } },
        required: ["itemIds"],
      },
    });
  }
  const conversation: AnthropicMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system: systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH) || undefined,
        messages: conversation,
        tools,
      }),
    });

    if (!response.ok) {
      let message = `AI provider returned HTTP ${response.status}.`;
      try {
        const errorPayload = await response.json() as { error?: { message?: string } };
        if (errorPayload.error?.message) message = errorPayload.error.message;
      } catch { /* keep default message */ }
      return { error: message, status: 502 };
    }

    const payload = await response.json() as { content?: AnthropicContentBlock[] };
    const blocks = payload.content || [];
    const toolUses = blocks.filter((b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use");

    if (!toolUses.length) {
      const reply = blocks.filter((b): b is Extract<AnthropicContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
      if (!reply) return { error: "The assistant didn't return a response.", status: 502 };
      return { reply };
    }

    conversation.push({ role: "assistant", content: blocks });
    const results: AnthropicContentBlock[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === NAME_TOOL_NAME) {
        const name = typeof toolUse.input?.name === "string" ? toolUse.input.name : "";
        if (name && onCustomerName) { try { await onCustomerName(name); } catch { /* don't let a storage failure break the reply */ } }
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Noted." });
        continue;
      }
      if (toolUse.name === NEEDS_HUMAN_TOOL_NAME) {
        const reason = typeof toolUse.input?.reason === "string" ? toolUse.input.reason : "Customer asked for a human.";
        if (onNeedsHuman) { try { await onNeedsHuman(reason); } catch { /* don't let a storage failure break the reply */ } }
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Noted — the team has been flagged." });
        continue;
      }
      if (toolUse.name === SHOW_ITEMS_TOOL_NAME) {
        const itemIds = Array.isArray(toolUse.input?.itemIds) ? toolUse.input.itemIds.filter((id): id is string => typeof id === "string") : [];
        if (itemIds.length && onShowItems) { try { await onShowItems(itemIds); } catch { /* don't let a storage failure break the reply */ } }
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Shown to the customer as cards — do not repeat their details in text." });
        continue;
      }
      const action = nameToAction.get(toolUse.name);
      if (!action) { results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "That action is not available.", is_error: true }); continue; }
      if (action.type === "submit" && recordSubmission) {
        try { await recordSubmission(action.name, toolUse.input || {}); } catch { /* don't let a storage failure break the reply */ }
      }
      const { ok, resultText } = await testAction(action, toolUse.input || {});
      // The customer never sees raw webhook diagnostics (HTTP codes, "could not reach the
      // business system", etc.) — testAction's resultText is for the dashboard's Test button.
      // A failed "submit" action still succeeded from the customer's point of view: their
      // details are already saved locally above as a safety net, so treat it as a success here
      // rather than let the model improvise an explanation or an alternate contact method.
      // A failed "request" action has no real data to report, so relay only the business's own
      // configured fallback message, verbatim, with no technical or invented details added.
      const content = ok
        ? resultText
        : action.type === "submit"
          ? "The information was saved successfully. Confirm this to the customer exactly as you would for any normal successful submission — do not mention any system, process, delay, issue, or alternate way to reach the business; there is nothing unusual to report."
          : `This request could not be completed. Tell the customer exactly this and nothing more, with no added technical detail or invented workaround: "${action.defaultResponse}"`;
      const isError = !ok && action.type !== "submit";
      results.push({ type: "tool_result", tool_use_id: toolUse.id, content, is_error: isError });
    }
    conversation.push({ role: "user", content: results });
  }

  return { error: "The assistant took too many steps to complete this request.", status: 502 };
}
