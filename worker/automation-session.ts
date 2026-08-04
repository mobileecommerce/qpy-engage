// Per-conversation automation state: which node this contact is currently waiting at, plus the
// values collected from them so far.
//
// v1 could only remember "which of the two top-level branches did this session commit to" (and it
// stored that on widget_conversation_state, a web-chat-only table — so WhatsApp had no memory at
// all and re-classified every single message). A real menu tree needs to know the exact node the
// customer is sitting at, on every channel, so a tapped option reliably advances to the right
// place. This table is keyed by (workspace, contact) and is therefore channel-agnostic: contact_key
// is the widget session id for web chat, or the customer's number for WhatsApp.

export type AutomationSession = { automationId: string; nodeId: string; variables: Record<string, string> };

let sessionSchemaEnsured = false;

export async function ensureSessionSchema(db: D1Database): Promise<void> {
  if (sessionSchemaEnsured) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_sessions (
    workspace_id TEXT NOT NULL,
    contact_key TEXT NOT NULL,
    automation_id TEXT NOT NULL DEFAULT '',
    node_id TEXT NOT NULL DEFAULT '',
    variables TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, contact_key)
  )`).run();
  sessionSchemaEnsured = true;
}

type Row = { automation_id: string; node_id: string; variables: string };

export async function loadSession(db: D1Database, workspaceId: string, contactKey: string): Promise<AutomationSession | null> {
  await ensureSessionSchema(db);
  const row = await db.prepare(`SELECT automation_id, node_id, variables FROM automation_sessions WHERE workspace_id = ? AND contact_key = ?`)
    .bind(workspaceId, contactKey).first<Row>();
  if (!row) return null;
  let variables: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.variables || "{}");
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") variables[k] = v;
    }
  } catch { variables = {}; }
  return { automationId: row.automation_id, nodeId: row.node_id, variables };
}

export async function saveSession(db: D1Database, workspaceId: string, contactKey: string, session: AutomationSession): Promise<void> {
  await ensureSessionSchema(db);
  await db.prepare(`INSERT INTO automation_sessions (workspace_id, contact_key, automation_id, node_id, variables, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, contact_key) DO UPDATE SET
      automation_id = excluded.automation_id, node_id = excluded.node_id,
      variables = excluded.variables, updated_at = CURRENT_TIMESTAMP`)
    .bind(workspaceId, contactKey, session.automationId, session.nodeId, JSON.stringify(session.variables)).run();
}

// Clears the cursor (so the next message starts the automation fresh) but deliberately KEEPS the
// collected variables: a customer who finishes a booking and then asks a follow-up question
// shouldn't lose the dates they already gave us.
export async function clearCursor(db: D1Database, workspaceId: string, contactKey: string, variables: Record<string, string>): Promise<void> {
  await saveSession(db, workspaceId, contactKey, { automationId: "", nodeId: "", variables });
}
