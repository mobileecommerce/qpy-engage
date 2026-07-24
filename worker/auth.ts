import { encoder, arrayBuffer, sha256, safeEqual, bytesToBase64, base64ToBytes, json, corsPreflight, allowedOrigin } from "./shared";
import { grantPlanMessages } from "./messageBalance";

export interface AuthEnv {
  DB: D1Database;
}

export type Role = "Owner" | "Admin" | "Agent" | "Analyst";

export interface SessionContext {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  email: string;
  name: string | null;
  isSuperadmin: boolean;
  isImpersonating: boolean;
  workspaceStatus: "active" | "disabled";
  workspacePlan: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Impersonation sessions (minted by a superadmin to manage a customer's workspace) live much
// shorter than a normal login — they're meant for one admin task, not a standing session.
const IMPERSONATION_TTL_MS = 4 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ensureAuthSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Agent',
      status TEXT NOT NULL DEFAULT 'Invited',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, email)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`),
  ]);
  // Idempotent migrations for tables created before these columns existed.
  try { await db.prepare(`ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE sessions ADD COLUMN via_admin INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`).run(); } catch { /* already exists */ }
  try { await db.prepare(`ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'Free'`).run(); } catch { /* already exists */ }
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: arrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return { hash: bytesToBase64(new Uint8Array(derived)), salt: bytesToBase64(salt) };
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: arrayBuffer(base64ToBytes(salt)), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return safeEqual(bytesToBase64(new Uint8Array(derived)), hash);
}

function generateToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function tokenHash(token: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await sha256(token)));
}

export async function createSession(db: D1Database, userId: string, workspaceId: string, viaAdmin = false): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + (viaAdmin ? IMPERSONATION_TTL_MS : SESSION_TTL_MS)).toISOString();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at, via_admin) VALUES (?, ?, ?, ?, ?)")
    .bind(await tokenHash(token), userId, workspaceId, expiresAt, viaAdmin ? 1 : 0).run();
  return token;
}

async function loadSession(request: Request, env: AuthEnv): Promise<SessionContext | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const hash = await tokenHash(token);
  const row = await env.DB.prepare(`SELECT s.workspace_id as workspaceId, s.expires_at as expiresAt, s.via_admin as viaAdmin,
      u.id as userId, u.email as email, u.name as name, u.is_superadmin as isSuperadmin, w.name as workspaceName, w.status as workspaceStatus, w.plan as workspacePlan, m.role as role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN workspaces w ON w.id = s.workspace_id
    LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = u.id
    WHERE s.token_hash = ?`).bind(hash).first<{ userId: string; workspaceId: string; expiresAt: string; email: string; name: string | null; isSuperadmin: number; workspaceName: string; workspaceStatus: string | null; workspacePlan: string | null; role: Role | null; viaAdmin: number }>();
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  const isSuperadmin = row.isSuperadmin === 1;
  // A superadmin gets Owner-equivalent rights on any workspace they impersonate into, without
  // needing a real workspace_members row for every customer — the impersonate endpoint is the
  // actual access gate (worker/admin.ts), this just avoids being blocked by role checks once there.
  return { userId: row.userId, workspaceId: row.workspaceId, workspaceName: row.workspaceName, role: isSuperadmin ? "Owner" : (row.role || "Agent"), email: row.email, name: row.name, isSuperadmin, isImpersonating: row.viaAdmin === 1, workspaceStatus: row.workspaceStatus === "disabled" ? "disabled" : "active", workspacePlan: row.workspacePlan || "Free" };
}

export async function requireSession(request: Request, env: AuthEnv): Promise<SessionContext | Response> {
  const session = await loadSession(request, env);
  if (!session) return json(request, { error: "Sign in required." }, 401);
  // A superadmin can still access a disabled workspace (to review/re-enable it via
  // impersonation) — the block only applies to the customer's own normal login.
  if (session.workspaceStatus === "disabled" && !session.isSuperadmin) {
    return json(request, { error: "This workspace has been disabled. Contact support if you believe this is a mistake." }, 403);
  }
  return session;
}

export function requireRole(request: Request, session: SessionContext, roles: Role[]): Response | null {
  if (!roles.includes(session.role)) return json(request, { error: "You don't have permission to do that." }, 403);
  return null;
}

async function signup(request: Request, env: AuthEnv): Promise<Response> {
  const body = await request.json() as { email?: string; password?: string; name?: string; workspaceName?: string };
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const name = (body.name || "").trim() || null;
  if (!validEmail(email)) return json(request, { error: "Enter a valid email address." }, 400);
  if (password.length < 8) return json(request, { error: "Password must be at least 8 characters." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json(request, { error: "An account with this email already exists." }, 409);

  const userId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt, name) VALUES (?, ?, ?, ?, ?)").bind(userId, email, hash, salt, name).run();

  const userCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>();
  const isFirstUser = (userCount?.count ?? 0) <= 1;
  let workspaceId = crypto.randomUUID();
  const workspaceName = (body.workspaceName || "").trim() || (name ? `${name}'s workspace` : "My workspace");

  if (isFirstUser) {
    try {
      const legacy = await env.DB.prepare("SELECT workspace_id FROM whatsapp_connections WHERE workspace_id = 'default'").first();
      if (legacy) {
        workspaceId = "default";
        try { await env.DB.prepare("ALTER TABLE whatsapp_messages ADD COLUMN workspace_id TEXT").run(); } catch { /* column already exists */ }
        await env.DB.prepare("UPDATE whatsapp_messages SET workspace_id = 'default' WHERE workspace_id IS NULL").run();
      }
    } catch { /* whatsapp_connections doesn't exist yet on a fresh deployment; nothing to claim */ }
  }

  await env.DB.prepare("INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)").bind(workspaceId, workspaceName, userId).run();
  await env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, email, role, status) VALUES (?, ?, ?, 'Owner', 'Active')
    ON CONFLICT(workspace_id, email) DO UPDATE SET user_id = excluded.user_id, role = 'Owner', status = 'Active'`).bind(workspaceId, userId, email).run();

  await env.DB.prepare("UPDATE workspace_members SET user_id = ?, status = 'Active' WHERE email = ? AND status = 'Invited'").bind(userId, email).run();

  const token = await createSession(env.DB, userId, workspaceId);
  await grantPlanMessages(env.DB, workspaceId, "Free");
  return json(request, { token, user: { id: userId, email, name, isSuperadmin: false }, workspace: { id: workspaceId, name: workspaceName, plan: "Free" }, role: "Owner" });
}

async function login(request: Request, env: AuthEnv): Promise<Response> {
  const body = await request.json() as { email?: string; password?: string };
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!email || !password) return json(request, { error: "Enter your email and password." }, 400);

  const user = await env.DB.prepare("SELECT id, email, name, password_hash, password_salt, is_superadmin FROM users WHERE email = ?").bind(email)
    .first<{ id: string; email: string; name: string | null; password_hash: string; password_salt: string; is_superadmin: number }>();
  if (!user || !(await verifyPassword(password, user.password_hash, user.password_salt))) return json(request, { error: "Incorrect email or password." }, 401);

  const membership = await env.DB.prepare(`SELECT workspace_id as workspaceId, role FROM workspace_members
    WHERE user_id = ? AND status = 'Active' ORDER BY CASE role WHEN 'Owner' THEN 0 ELSE 1 END LIMIT 1`).bind(user.id)
    .first<{ workspaceId: string; role: Role }>();
  if (!membership) return json(request, { error: "This account isn't attached to a workspace yet." }, 409);
  const workspace = await env.DB.prepare("SELECT name, plan FROM workspaces WHERE id = ?").bind(membership.workspaceId).first<{ name: string; plan: string | null }>();

  const token = await createSession(env.DB, user.id, membership.workspaceId);
  return json(request, { token, user: { id: user.id, email: user.email, name: user.name, isSuperadmin: user.is_superadmin === 1 }, workspace: { id: membership.workspaceId, name: workspace?.name || "Workspace", plan: workspace?.plan || "Free" }, role: user.is_superadmin === 1 ? "Owner" : membership.role });
}

async function logout(request: Request, env: AuthEnv): Promise<Response> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
  return json(request, { loggedOut: true });
}

async function sessionInfo(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  return json(request, { user: { id: session.userId, email: session.email, name: session.name, isSuperadmin: session.isSuperadmin }, workspace: { id: session.workspaceId, name: session.workspaceName, plan: session.workspacePlan }, role: session.role, isImpersonating: session.isImpersonating });
}

async function listMembers(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const result = await env.DB.prepare(`SELECT user_id as userId, email, role, status FROM workspace_members WHERE workspace_id = ?
    ORDER BY CASE role WHEN 'Owner' THEN 0 WHEN 'Admin' THEN 1 WHEN 'Agent' THEN 2 ELSE 3 END, email`).bind(session.workspaceId)
    .all<{ userId: string | null; email: string; role: Role; status: string }>();
  const rows = result.results || [];
  const ids = rows.map((r) => r.userId).filter((v): v is string => Boolean(v));
  const names = new Map<string, string | null>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const usersResult = await env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; name: string | null }>();
    for (const u of usersResult.results || []) names.set(u.id, u.name);
  }
  return json(request, {
    members: rows.map((r) => ({
      id: r.userId || r.email,
      userId: r.userId,
      name: (r.userId && names.get(r.userId)) || r.email.split("@")[0],
      email: r.email,
      role: r.role,
      status: r.status,
    })),
  });
}

async function inviteMember(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const denied = requireRole(request, session, ["Owner", "Admin"]);
  if (denied) return denied;
  const body = await request.json() as { email?: string; role?: Role };
  const email = (body.email || "").trim().toLowerCase();
  const role = body.role || "Agent";
  if (!validEmail(email)) return json(request, { error: "Enter a valid email address." }, 400);
  if (!["Admin", "Agent", "Analyst"].includes(role)) return json(request, { error: "Invalid role." }, 400);

  const existingUser = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  await env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, email, role, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, email) DO UPDATE SET role = excluded.role, status = excluded.status, user_id = excluded.user_id`)
    .bind(session.workspaceId, existingUser?.id || null, email, role, existingUser ? "Active" : "Invited").run();
  return json(request, { invited: true, status: existingUser ? "Active" : "Invited" });
}

async function updateMemberRole(request: Request, env: AuthEnv, email: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const denied = requireRole(request, session, ["Owner", "Admin"]);
  if (denied) return denied;
  const body = await request.json() as { role?: Role };
  const role = body.role;
  if (!role || !["Admin", "Agent", "Analyst"].includes(role)) return json(request, { error: "Invalid role." }, 400);
  const target = await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?").bind(session.workspaceId, email).first<{ role: Role }>();
  if (!target) return json(request, { error: "Member not found." }, 404);
  if (target.role === "Owner") return json(request, { error: "The workspace owner's role cannot be changed." }, 400);
  await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND email = ?").bind(role, session.workspaceId, email).run();
  return json(request, { updated: true });
}

async function removeMember(request: Request, env: AuthEnv, email: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const denied = requireRole(request, session, ["Owner", "Admin"]);
  if (denied) return denied;
  const target = await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?").bind(session.workspaceId, email).first<{ role: Role }>();
  if (!target) return json(request, { error: "Member not found." }, 404);
  if (target.role === "Owner") return json(request, { error: "The workspace owner cannot be removed." }, 400);
  await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND email = ?").bind(session.workspaceId, email).run();
  return json(request, { removed: true });
}

export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/api/workspace/")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);
  await ensureAuthSchema(env.DB);

  if (url.pathname === "/api/auth/signup" && request.method === "POST") return signup(request, env);
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (url.pathname === "/api/auth/session" && request.method === "GET") return sessionInfo(request, env);
  if (url.pathname === "/api/workspace/members" && request.method === "GET") return listMembers(request, env);
  if (url.pathname === "/api/workspace/members" && request.method === "POST") return inviteMember(request, env);
  const memberMatch = url.pathname.match(/^\/api\/workspace\/members\/([^/]+)$/);
  if (memberMatch && request.method === "PATCH") return updateMemberRole(request, env, decodeURIComponent(memberMatch[1]));
  if (memberMatch && request.method === "DELETE") return removeMember(request, env, decodeURIComponent(memberMatch[1]));
  return json(request, { error: "Not found" }, 404);
}
