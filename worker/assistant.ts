import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin, callClaude, sanitizeChatMessages } from "./shared";

export interface AssistantEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

async function respond(request: Request, env: AssistantEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!env.ANTHROPIC_API_KEY) return json(request, { error: "The AI assistant isn't configured yet. Add ANTHROPIC_API_KEY as a Cloudflare Worker secret." }, 503);

  const body = await request.json() as { systemPrompt?: string; messages?: unknown };
  const messages = sanitizeChatMessages(body.messages);
  if (!messages.length) return json(request, { error: "No message to respond to." }, 400);
  if (messages[messages.length - 1].role !== "user") return json(request, { error: "The last message must be from the customer." }, 400);

  const result = await callClaude(env.ANTHROPIC_API_KEY, body.systemPrompt || "", messages);
  if (result.error) return json(request, { error: result.error }, result.status || 502);
  return json(request, { reply: result.reply });
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
