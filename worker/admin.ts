import { requireSession, createSession, type AuthEnv, type SessionContext } from "./auth";
import { json, corsPreflight, allowedOrigin } from "./shared";

export interface AdminEnv extends AuthEnv {
  DB: D1Database;
}

async function requireSuperadmin(request: Request, env: AdminEnv): Promise<SessionContext | Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (!session.isSuperadmin) return json(request, { error: "Not authorized." }, 403);
  return session;
}

async function listWorkspaces(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;

  const result = await env.DB.prepare(`SELECT w.id, w.name, w.created_at as createdAt, u.email as ownerEmail
    FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id ORDER BY w.created_at DESC`)
    .all<{ id: string; name: string; createdAt: string; ownerEmail: string | null }>();
  const workspaces = result.results || [];
  const ids = workspaces.map((w) => w.id);

  const messageCounts = new Map<string, number>();
  const conversationCounts = new Map<string, number>();
  const whatsappConnected = new Set<string>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    try {
      const wc = await env.DB.prepare(`SELECT workspace_id, COUNT(*) as c, COUNT(DISTINCT session_id) as sessions FROM widget_messages WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id`)
        .bind(...ids).all<{ workspace_id: string; c: number; sessions: number }>();
      for (const r of wc.results || []) { messageCounts.set(r.workspace_id, r.c); conversationCounts.set(r.workspace_id, r.sessions); }
    } catch { /* widget_messages may not exist yet */ }
    try {
      const wa = await env.DB.prepare(`SELECT workspace_id FROM whatsapp_connections WHERE workspace_id IN (${placeholders})`)
        .bind(...ids).all<{ workspace_id: string }>();
      for (const r of wa.results || []) whatsappConnected.add(r.workspace_id);
    } catch { /* whatsapp_connections may not exist yet */ }
  }

  return json(request, {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ownerEmail: w.ownerEmail,
      createdAt: w.createdAt,
      webChatMessageCount: messageCounts.get(w.id) || 0,
      webChatConversationCount: conversationCounts.get(w.id) || 0,
      whatsappConnected: whatsappConnected.has(w.id),
    })),
  });
}

async function impersonate(request: Request, env: AdminEnv): Promise<Response> {
  const session = await requireSuperadmin(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { workspaceId?: string };
  const workspaceId = (body.workspaceId || "").trim();
  if (!workspaceId) return json(request, { error: "Missing workspaceId." }, 400);
  const workspace = await env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>();
  if (!workspace) return json(request, { error: "Workspace not found." }, 404);

  const token = await createSession(env.DB, session.userId, workspaceId, true);
  return json(request, { token, workspace: { id: workspace.id, name: workspace.name } });
}

export async function handleAdminRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/admin/workspaces" && request.method === "GET") return listWorkspaces(request, env);
  if (url.pathname === "/api/admin/impersonate" && request.method === "POST") return impersonate(request, env);
  return json(request, { error: "Not found" }, 404);
}
