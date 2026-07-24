/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleMetaRequest, type MetaEnv } from "./meta";
import { handleAuthRequest, requireSession, type AuthEnv } from "./auth";
import { handleAssistantRequest, type AssistantEnv } from "./assistant";
import { handleKnowledgeRequest, type KnowledgeEnv } from "./knowledge";
import { handleWidgetRequest, type WidgetEnv } from "./widget";
import { handleLeadsRequest, type LeadsEnv } from "./leads";
import { handleAdminRequest, type AdminEnv } from "./admin";
import { handleCreditsRequest, type CreditsEnv } from "./credits";
import { handleContactsRequest, type ContactsEnv } from "./contacts";
import { handleCampaignsRequest, type CampaignsEnv } from "./campaigns";
import { handleOtpRequest, type OtpEnv } from "./otp";
import { handleItemsRequest, type ItemsEnv } from "./items";
import { handleFlowsRequest, type FlowsEnv } from "./flows";
import { json, corsPreflight, allowedOrigin } from "./shared";

interface Env extends MetaEnv, AuthEnv, AssistantEnv, KnowledgeEnv, WidgetEnv, LeadsEnv, AdminEnv, CreditsEnv, ContactsEnv, CampaignsEnv, OtpEnv, ItemsEnv, FlowsEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const authResponse = await handleAuthRequest(request, env);
    if (authResponse) return authResponse;

    const assistantResponse = await handleAssistantRequest(request, env);
    if (assistantResponse) return assistantResponse;

    const knowledgeResponse = await handleKnowledgeRequest(request, env);
    if (knowledgeResponse) return knowledgeResponse;

    const widgetResponse = await handleWidgetRequest(request, env);
    if (widgetResponse) return widgetResponse;

    const leadsResponse = await handleLeadsRequest(request, env);
    if (leadsResponse) return leadsResponse;

    const adminResponse = await handleAdminRequest(request, env);
    if (adminResponse) return adminResponse;

    const creditsResponse = await handleCreditsRequest(request, env);
    if (creditsResponse) return creditsResponse;

    const contactsResponse = await handleContactsRequest(request, env);
    if (contactsResponse) return contactsResponse;

    const campaignsResponse = await handleCampaignsRequest(request, env);
    if (campaignsResponse) return campaignsResponse;

    const otpResponse = await handleOtpRequest(request, env);
    if (otpResponse) return otpResponse;

    const itemsResponse = await handleItemsRequest(request, env);
    if (itemsResponse) return itemsResponse;

    const flowsResponse = await handleFlowsRequest(request, env);
    if (flowsResponse) return flowsResponse;

    const metaResponse = await handleMetaRequest(request, env);
    if (metaResponse) return metaResponse;

    if (url.pathname === "/api/state") {
      if (request.method === "OPTIONS") return corsPreflight(request);
      if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
      if (!env.DB) return json(request, { error: "Workspace database is unavailable" }, 503);
      const session = await requireSession(request, env);
      if (session instanceof Response) return session;
      const scopedKey = (key: string) => `${session.workspaceId}::${key}`;
      if (request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key || !/^[a-z0-9-]{1,80}$/i.test(key)) return json(request, { error: "A valid key is required" }, 400);
        const record = await env.DB.prepare("SELECT value FROM workspace_state WHERE key = ?").bind(scopedKey(key)).first<{ value: string }>();
        return json(request, { value: record ? JSON.parse(record.value) : null });
      }
      if (request.method === "PUT") {
        const payload = await request.json() as { key?: string; value?: unknown };
        if (!payload.key || !/^[a-z0-9-]{1,80}$/i.test(payload.key)) return json(request, { error: "A valid key is required" }, 400);
        await env.DB.prepare("INSERT INTO workspace_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(scopedKey(payload.key), JSON.stringify(payload.value)).run();
        return json(request, { saved: true });
      }
      return json(request, { error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
