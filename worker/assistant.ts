import { requireSession, type AuthEnv } from "./auth";
import { json, corsPreflight, allowedOrigin, callClaudeWithActions, sanitizeChatMessages, sanitizeActions, testAction } from "./shared";
import { saveSubmission } from "./leads";

export interface AssistantEnv extends AuthEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

async function respond(request: Request, env: AssistantEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!env.ANTHROPIC_API_KEY) return json(request, { error: "The AI assistant isn't configured yet. Add ANTHROPIC_API_KEY as a Cloudflare Worker secret." }, 503);

  const body = await request.json() as { systemPrompt?: string; messages?: unknown; actions?: unknown; channel?: unknown; sessionId?: unknown };
  const messages = sanitizeChatMessages(body.messages);
  if (!messages.length) return json(request, { error: "No message to respond to." }, 400);
  if (messages[messages.length - 1].role !== "user") return json(request, { error: "The last message must be from the customer." }, 400);
  const actions = sanitizeActions(body.actions);
  const channel = typeof body.channel === "string" && body.channel.trim() ? body.channel.trim().slice(0, 40) : "assistant_test";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 80) : "";
  const recordSubmission = env.DB ? (actionName: string, data: Record<string, unknown>) => saveSubmission(env.DB, session.workspaceId, sessionId, actionName, channel, data) : undefined;

  const result = await callClaudeWithActions(env.ANTHROPIC_API_KEY, body.systemPrompt || "", messages, actions, recordSubmission);
  if (result.error) return json(request, { error: result.error }, result.status || 502);
  return json(request, { reply: result.reply });
}

async function testActionHandler(request: Request, env: AssistantEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { action?: unknown; sampleInput?: unknown };
  const rawAction = body.action && typeof body.action === "object" ? body.action as Record<string, unknown> : {};
  const [action] = sanitizeActions([{ ...rawAction, enabled: true }]);
  if (!action) return json(request, { error: "Add an endpoint URL and action name before testing." }, 400);
  const input = body.sampleInput && typeof body.sampleInput === "object" ? body.sampleInput as Record<string, unknown> : {};
  const result = await testAction(action, input);
  return json(request, result);
}

export async function handleAssistantRequest(request: Request, env: AssistantEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/assistant/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/assistant/respond" && request.method === "POST") return respond(request, env);
  if (url.pathname === "/api/assistant/test-action" && request.method === "POST") return testActionHandler(request, env);
  return json(request, { error: "Not found" }, 404);
}
