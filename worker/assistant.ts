import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface AssistantEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

const ANTHROPIC_MODEL = "claude-sonnet-5";
const MAX_HISTORY_TURNS = 20;
const MAX_SYSTEM_PROMPT_LENGTH = 8000;
const MAX_MESSAGE_LENGTH = 4000;

type ChatMessage = { role: "user" | "assistant"; content: string };

async function respond(request: Request, env: AssistantEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!env.ANTHROPIC_API_KEY) return json(request, { error: "The AI assistant isn't configured yet. Add ANTHROPIC_API_KEY as a Cloudflare Worker secret." }, 503);

  const body = await request.json() as { systemPrompt?: string; messages?: ChatMessage[] };
  const systemPrompt = (body.systemPrompt || "").slice(0, MAX_SYSTEM_PROMPT_LENGTH);
  const messages = (body.messages || [])
    .filter((m): m is ChatMessage => Boolean(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));

  if (!messages.length) return json(request, { error: "No message to respond to." }, 400);
  if (messages[messages.length - 1].role !== "user") return json(request, { error: "The last message must be from the customer." }, 400);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt || undefined,
      messages,
    }),
  });

  if (!response.ok) {
    let message = `AI provider returned HTTP ${response.status}.`;
    try {
      const errorPayload = await response.json() as { error?: { message?: string } };
      if (errorPayload.error?.message) message = errorPayload.error.message;
    } catch { /* keep default message */ }
    return json(request, { error: message }, 502);
  }

  const payload = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const reply = (payload.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("")
    .trim();

  if (!reply) return json(request, { error: "The assistant didn't return a response." }, 502);
  return json(request, { reply });
}

export async function handleAssistantRequest(request: Request, env: AssistantEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/assistant/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/assistant/respond" && request.method === "POST") return respond(request, env);
  return json(request, { error: "Not found" }, 404);
}
