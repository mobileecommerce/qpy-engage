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
