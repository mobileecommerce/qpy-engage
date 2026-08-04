import { json, corsPreflight, allowedOrigin } from "./shared";
import { requireSession, type AuthEnv } from "./auth";
import { identityFrom } from "./leads";
import { qualifyConversation, type Channel } from "./conversations";

export interface IdentityEnv extends AuthEnv {
  DB: D1Database;
}

/* ================================================================================================
   Identity Resolution Engine — hub and spoke.

   The hub is crm_people: one row per human. The spokes are crm_identities: one row per way of
   reaching them. Before this, phone/email/handle were *columns* on the hub, which capped a person
   at exactly one of each and gave nowhere to record whether an identifier was actually verified.

   The hub is elevated in place rather than renamed to Customer_Profiles. Renaming a live table
   means every reader breaks the instant the migration lands — the opposite of zero downtime — and
   the name buys nothing the comment above does not. Every migration step here is additive.
   ============================================================================================== */

// `channel` records where an identifier came from. `kind` is what it *is*, and matching only ever
// happens on kind — which is what makes "treat WhatsApp numbers as phone identities" true rather
// than aspirational: a number captured on a web form and the same number arriving over WhatsApp
// are both kind='phone' and collide on sight.
export type IdentityChannel = "whatsapp" | "email" | "webchat_visitor" | "instagram" | "manual";
export type IdentityKind = "phone" | "email" | "handle" | "visitor";

const CHANNEL_KIND: Record<IdentityChannel, IdentityKind> = {
  whatsapp: "phone",
  email: "email",
  webchat_visitor: "visitor",
  instagram: "handle",
  manual: "phone",
};

// The market this platform actually serves. Used only to resolve local-format numbers that carry no
// country code ("0501234567"); anything already carrying one is untouched.
const DEFAULT_COUNTRY_CODE = "971";
const BACKFILL_BATCH = 60;

let schemaReady = false;

/* ------------------------------------------------------------------ migration (additive) */

export async function ensureIdentitySchema(db: D1Database): Promise<void> {
  if (schemaReady) return;

  // ALTER on the live hub. SQLite has no ADD COLUMN IF NOT EXISTS, and D1 surfaces a duplicate
  // column as an error rather than a no-op, so each is attempted independently and a failure here
  // means "already applied" — never a reason to abort the rest of the migration.
  for (const statement of [
    `ALTER TABLE crm_people ADD COLUMN merged_into_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE crm_people ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE crm_backfill_state ADD COLUMN last_submission_id INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE crm_backfill_state ADD COLUMN legacy_done INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE crm_backfill_state ADD COLUMN profiles_created INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try { await db.prepare(statement).run(); } catch { /* column already present */ }
  }

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_identities (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      match_tail TEXT NOT NULL DEFAULT '',
      is_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // The uniqueness that makes deduplication a database guarantee rather than a convention: one
    // normalized identifier of a given kind can belong to exactly one profile per workspace.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_unique
      ON crm_identities (workspace_id, kind, normalized_value)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_identity_profile ON crm_identities (workspace_id, profile_id)`),
    // Fallback lookup for phone numbers whose country code could not be resolved confidently.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_identity_tail ON crm_identities (workspace_id, kind, match_tail)`),

    db.prepare(`CREATE TABLE IF NOT EXISTS crm_merge_candidates (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      profile_a_id TEXT NOT NULL,
      profile_b_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_pair
      ON crm_merge_candidates (workspace_id, profile_a_id, profile_b_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_candidate_status ON crm_merge_candidates (workspace_id, status)`),

    // Records what the backfill has already processed so it can be re-run safely and resumed after
    // a Worker hits its CPU limit part-way through a large workspace.
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_backfill_state (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      last_person_id TEXT NOT NULL DEFAULT '',
      last_submission_id INTEGER NOT NULL DEFAULT 0,
      people_done INTEGER NOT NULL DEFAULT 0,
      identities_created INTEGER NOT NULL DEFAULT 0,
      legacy_done INTEGER NOT NULL DEFAULT 0,
      profiles_created INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    )`),
  ]);
  schemaReady = true;
}

/* ------------------------------------------------------------------ 2. normalization pipeline */

/**
 * Strict E.164 where the country code can be established, digits otherwise.
 *
 * A local number carries no country code, so turning "0501234567" into E.164 requires knowing the
 * market. Guessing wrongly would fabricate a number belonging to someone else, so anything that
 * cannot be resolved confidently is left as plain digits and matched via `phoneMatchTail` instead
 * of being forced into a shape it does not have.
 */
export function toE164(raw: string, countryCode: string = DEFAULT_COUNTRY_CODE): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D+/g, "");
  if (!digits) return "";

  if (hadPlus) return `+${digits}`;
  // 00 is the international prefix in most of the world — same meaning as a leading +.
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  // A national trunk prefix: drop the 0 and prepend the market's country code.
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
    return digits ? `+${countryCode}${digits}` : "";
  }
  // Already carries this market's country code.
  if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) return `+${digits}`;
  // Long enough to be a full international number in its own right.
  if (digits.length >= 11) return `+${digits}`;
  // A bare subscriber number in the platform's own market.
  if (digits.length >= 7) return `+${countryCode}${digits}`;
  return digits;
}

/**
 * The last 9 significant digits, used as a fallback when two records disagree about the country
 * code. This is what the pre-IRE matcher used exclusively, so keeping it as a lower tier means the
 * move to E.164 tightens matching without silently unlinking customers who already matched.
 */
export function phoneMatchTail(raw: string): string {
  const digits = (raw || "").replace(/\D+/g, "");
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

export function normalizeEmail(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

export function normalizeHandle(raw: string): string {
  return (raw || "").trim().toLowerCase().replace(/^@/, "");
}

/** Visitor tokens are opaque and already unique — preserved verbatim, only trimmed. */
export function normalizeVisitor(raw: string): string {
  return (raw || "").trim();
}

export function normalizeFor(kind: IdentityKind, raw: string): { normalized: string; matchTail: string } {
  switch (kind) {
    case "phone": return { normalized: toE164(raw), matchTail: phoneMatchTail(raw) };
    case "email": return { normalized: normalizeEmail(raw), matchTail: "" };
    case "handle": return { normalized: normalizeHandle(raw), matchTail: "" };
    case "visitor": return { normalized: normalizeVisitor(raw), matchTail: "" };
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/* ------------------------------------------------------------------ 3. waterfall */

export type ResolutionTier = "deterministic" | "session_upgrade" | "probabilistic_review" | "new_profile";

export interface ResolutionResult {
  profileId: string;
  tier: ResolutionTier;
  created: boolean;
  /** Populated on a Tier 3 outcome: profiles a human should look at, never merged automatically. */
  reviewCandidates: string[];
}

export interface ResolvePayload {
  name?: string;
  company?: string;
  /** The anonymous web chat token this identifier arrived through, if any. Drives Tier 2. */
  visitorId?: string;
  /** Whether the identifier is proven to belong to this person (arrived over the channel itself). */
  verified?: boolean;
}

interface IdentityRow {
  id: string; profile_id: string; kind: string; normalized_value: string; is_verified: number;
}

async function findByIdentity(db: D1Database, workspaceId: string, kind: IdentityKind, normalized: string): Promise<IdentityRow | null> {
  if (!normalized) return null;
  return db.prepare(`SELECT i.id, i.profile_id, i.kind, i.normalized_value, i.is_verified
    FROM crm_identities i JOIN crm_people p ON p.id = i.profile_id
    WHERE i.workspace_id = ? AND i.kind = ? AND i.normalized_value = ? AND p.is_active = 1
    LIMIT 1`).bind(workspaceId, kind, normalized).first<IdentityRow>();
}

async function findByPhoneTail(db: D1Database, workspaceId: string, tail: string): Promise<IdentityRow | null> {
  if (!tail) return null;
  return db.prepare(`SELECT i.id, i.profile_id, i.kind, i.normalized_value, i.is_verified
    FROM crm_identities i JOIN crm_people p ON p.id = i.profile_id
    WHERE i.workspace_id = ? AND i.kind = 'phone' AND i.match_tail = ? AND p.is_active = 1
    ORDER BY i.is_verified DESC, i.created_at ASC LIMIT 1`).bind(workspaceId, tail).first<IdentityRow>();
}

/** Follows a tombstone chain to whichever profile is live now. */
export async function resolveTombstone(db: D1Database, workspaceId: string, profileId: string): Promise<string> {
  let current = profileId;
  for (let hop = 0; hop < 8; hop++) {
    const row = await db.prepare(`SELECT merged_into_id, is_active FROM crm_people WHERE id = ? AND workspace_id = ?`)
      .bind(current, workspaceId).first<{ merged_into_id: string; is_active: number }>();
    if (!row || row.is_active === 1 || !row.merged_into_id) return current;
    current = row.merged_into_id;
  }
  return current;
}

async function attachIdentity(
  db: D1Database, workspaceId: string, profileId: string,
  channel: IdentityChannel, kind: IdentityKind, raw: string, normalized: string, matchTail: string, verified: boolean,
): Promise<void> {
  await db.prepare(`INSERT INTO crm_identities
    (id, workspace_id, profile_id, channel, kind, identifier_value, normalized_value, match_tail, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, kind, normalized_value) DO UPDATE SET
      is_verified = MAX(crm_identities.is_verified, excluded.is_verified),
      updated_at = CURRENT_TIMESTAMP`)
    .bind(newId("idn"), workspaceId, profileId, channel, kind, raw.slice(0, 200), normalized, matchTail, verified ? 1 : 0)
    .run();
}

/**
 * Tier 3. Weak overlap only — same name plus same company, with no identifier in common. Never
 * merges: two people at one company genuinely can share a name, and an automatic merge of the
 * wrong pair is far more expensive to undo than a review queue is to staff.
 */
async function flagProbabilisticCandidates(
  db: D1Database, workspaceId: string, profileId: string, name: string, company: string,
): Promise<string[]> {
  const cleanName = (name || "").trim();
  const cleanCompany = (company || "").trim();
  if (!cleanName || !cleanCompany) return [];

  const rows = await db.prepare(`SELECT id FROM crm_people
    WHERE workspace_id = ? AND is_active = 1 AND id != ?
      AND lower(trim(full_name)) = lower(?) AND lower(trim(company)) = lower(?) LIMIT 5`)
    .bind(workspaceId, profileId, cleanName, cleanCompany).all<{ id: string }>();
  const candidates = (rows.results || []).map((r) => r.id);

  for (const otherId of candidates) {
    // Stored with a stable ordering so the same pair cannot be queued twice from both directions.
    const [a, b] = [profileId, otherId].sort();
    await db.prepare(`INSERT INTO crm_merge_candidates (id, workspace_id, profile_a_id, profile_b_id, reason, confidence)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, profile_a_id, profile_b_id) DO NOTHING`)
      .bind(newId("mc"), workspaceId, a, b, `Same name and company: ${cleanName} at ${cleanCompany}`, 0.6)
      .run().catch(() => null);
  }
  return candidates;
}

/**
 * The waterfall. Runs before an inbound message is attached to anything.
 *
 * Tier 1 deterministic → Tier 2 web chat session upgrade → Tier 3 probabilistic (flag only) →
 * Tier 4 new profile.
 */
export async function resolveIdentity(
  db: D1Database,
  workspaceId: string,
  channel: IdentityChannel,
  rawIdentifier: string,
  payload: ResolvePayload = {},
): Promise<ResolutionResult | null> {
  await ensureIdentitySchema(db);
  const kind = CHANNEL_KIND[channel];
  const { normalized, matchTail } = normalizeFor(kind, rawIdentifier);
  if (!normalized) return null;
  const verified = payload.verified ?? channel !== "manual";

  /* ---- Tier 1: deterministic ---------------------------------------------------------------- */
  let hit = await findByIdentity(db, workspaceId, kind, normalized);
  // Only for phones, and only when the exact E.164 form missed: catches the same number stored once
  // with a country code and once without.
  if (!hit && kind === "phone") hit = await findByPhoneTail(db, workspaceId, matchTail);

  if (hit) {
    const profileId = await resolveTombstone(db, workspaceId, hit.profile_id);
    await attachIdentity(db, workspaceId, profileId, channel, kind, rawIdentifier, normalized, matchTail, verified);

    /* ---- Tier 2: web chat session upgrade --------------------------------------------------- */
    // An anonymous visitor who hands over a phone number mid-chat that already belongs to a
    // WhatsApp profile gets folded into that profile, instead of becoming a second lead for a
    // customer already in the pipeline.
    if (payload.visitorId) {
      const visitorNormalized = normalizeVisitor(payload.visitorId);
      const existingVisitor = await findByIdentity(db, workspaceId, "visitor", visitorNormalized);
      if (existingVisitor && existingVisitor.profile_id !== profileId) {
        await absorbProfile(db, workspaceId, existingVisitor.profile_id, profileId, "session_upgrade");
      } else {
        await attachIdentity(db, workspaceId, profileId, "webchat_visitor", "visitor", payload.visitorId, visitorNormalized, "", false);
      }
      await db.prepare(`UPDATE crm_conversations SET person_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND thread_key = ?`).bind(profileId, workspaceId, visitorNormalized).run();
      await enrichProfile(db, workspaceId, profileId, payload);
      return { profileId, tier: "session_upgrade", created: false, reviewCandidates: [] };
    }

    await enrichProfile(db, workspaceId, profileId, payload);
    return { profileId, tier: "deterministic", created: false, reviewCandidates: [] };
  }

  /* ---- Tier 2b: an anonymous visitor already has a profile ---------------------------------- */
  // The identifier is new but this browser session is already known, so the identifier belongs to
  // that existing profile rather than a new one.
  if (payload.visitorId) {
    const visitorHit = await findByIdentity(db, workspaceId, "visitor", normalizeVisitor(payload.visitorId));
    if (visitorHit) {
      const profileId = await resolveTombstone(db, workspaceId, visitorHit.profile_id);
      await attachIdentity(db, workspaceId, profileId, channel, kind, rawIdentifier, normalized, matchTail, verified);
      await enrichProfile(db, workspaceId, profileId, payload);
      return { profileId, tier: "session_upgrade", created: false, reviewCandidates: [] };
    }
  }

  /* ---- Tier 4: new profile ------------------------------------------------------------------ */
  const profileId = newId("per");
  const tone = Math.abs([...profileId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 6;
  await db.prepare(`INSERT INTO crm_people
    (id, workspace_id, full_name, phone, phone_key, email, email_key, instagram_handle, handle_key, company, avatar_tone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(profileId, workspaceId, (payload.name || "").trim(),
      kind === "phone" ? rawIdentifier.trim() : "", kind === "phone" ? matchTail : "",
      kind === "email" ? normalized : "", kind === "email" ? normalized : "",
      kind === "handle" ? normalized : "", kind === "handle" ? normalized : "",
      (payload.company || "").trim(), tone).run();

  await attachIdentity(db, workspaceId, profileId, channel, kind, rawIdentifier, normalized, matchTail, verified);
  if (payload.visitorId) {
    const v = normalizeVisitor(payload.visitorId);
    await attachIdentity(db, workspaceId, profileId, "webchat_visitor", "visitor", payload.visitorId, v, "", false);
    await db.prepare(`UPDATE crm_conversations SET person_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND thread_key = ?`).bind(profileId, workspaceId, v).run();
  }

  /* ---- Tier 3: probabilistic, flag only ----------------------------------------------------- */
  const reviewCandidates = await flagProbabilisticCandidates(db, workspaceId, profileId, payload.name || "", payload.company || "");
  return {
    profileId,
    tier: reviewCandidates.length ? "probabilistic_review" : "new_profile",
    created: true,
    reviewCandidates,
  };
}

/**
 * Keeps the hub's denormalised columns in step with the identities attached to it. Those columns
 * still back every existing read path, so they are dual-written throughout the transition rather
 * than dropped — that is what makes this migration safe to deploy without a coordinated cutover.
 */
async function enrichProfile(db: D1Database, workspaceId: string, profileId: string, payload: ResolvePayload): Promise<void> {
  const name = (payload.name || "").trim();
  const company = (payload.company || "").trim();
  if (!name && !company) return;
  // Blanks only: a value already present was either typed by a human or seen first.
  await db.prepare(`UPDATE crm_people SET
      full_name = CASE WHEN full_name = '' THEN ? ELSE full_name END,
      company   = CASE WHEN company   = '' THEN ? ELSE company   END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND workspace_id = ?`).bind(name, company, profileId, workspaceId).run();
}

/* ------------------------------------------------------------------ 4. safe merge */

export interface MergeOutcome {
  survivingProfileId: string;
  mergedProfileId: string;
  movedConversations: number;
  movedIdentities: number;
  leadAction: "folded" | "repointed" | "none";
}

/**
 * Merges `loserId` into `winnerId`.
 *
 * D1 has no interactive transaction — there is no `$transaction` to open, hold and commit across
 * awaits. What it does have is `db.batch()`, which runs its statements atomically: all of them
 * commit or none do. The whole merge is therefore composed as one batch, which is the strongest
 * guarantee this engine can actually offer rather than one it merely claims.
 */
export async function absorbProfile(
  db: D1Database, workspaceId: string, loserId: string, winnerId: string, reason: string,
): Promise<MergeOutcome> {
  await ensureIdentitySchema(db);
  if (loserId === winnerId) {
    return { survivingProfileId: winnerId, mergedProfileId: loserId, movedConversations: 0, movedIdentities: 0, leadAction: "none" };
  }

  const [loserLead, winnerLead, convCount, idnCount] = await Promise.all([
    db.prepare(`SELECT * FROM crm_leads WHERE workspace_id = ? AND person_id = ?`).bind(workspaceId, loserId).first<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM crm_leads WHERE workspace_id = ? AND person_id = ?`).bind(workspaceId, winnerId).first<Record<string, unknown>>(),
    db.prepare(`SELECT count(*) n FROM crm_conversations WHERE workspace_id = ? AND person_id = ?`).bind(workspaceId, loserId).first<{ n: number }>(),
    db.prepare(`SELECT count(*) n FROM crm_identities WHERE workspace_id = ? AND profile_id = ?`).bind(workspaceId, loserId).first<{ n: number }>(),
  ]);

  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE crm_conversations SET person_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND person_id = ?`).bind(winnerId, workspaceId, loserId),
    db.prepare(`UPDATE crm_identities SET profile_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND profile_id = ?`).bind(winnerId, workspaceId, loserId),
  ];

  // crm_leads is UNIQUE(workspace_id, person_id), so repointing the loser's lead onto a winner that
  // already has one violates the index and aborts the whole batch. When both exist the surviving
  // lead absorbs whatever fields it was missing and the loser's row is dropped; the sales record is
  // derived data, the conversations behind it are not.
  let leadAction: MergeOutcome["leadAction"] = "none";
  if (loserLead && winnerLead) {
    leadAction = "folded";
    const keep = (column: string) =>
      `${column} = CASE WHEN ${column} = '' OR ${column} IS NULL THEN ? ELSE ${column} END`;
    statements.push(
      db.prepare(`UPDATE crm_leads SET ${keep("priority")}, ${keep("segment")}, ${keep("source")}, ${keep("owner")}, ${keep("next_followup")},
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND person_id = ?`)
        .bind(String(loserLead.priority ?? ""), String(loserLead.segment ?? ""), String(loserLead.source ?? ""),
          String(loserLead.owner ?? ""), String(loserLead.next_followup ?? ""), workspaceId, winnerId),
      db.prepare(`DELETE FROM crm_leads WHERE workspace_id = ? AND person_id = ?`).bind(workspaceId, loserId),
    );
  } else if (loserLead) {
    leadAction = "repointed";
    statements.push(
      db.prepare(`UPDATE crm_leads SET person_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND person_id = ?`).bind(winnerId, workspaceId, loserId),
    );
  }

  statements.push(
    // Fill the winner's blank hub columns from the loser before it is tombstoned.
    db.prepare(`UPDATE crm_people SET
        full_name = CASE WHEN full_name = '' THEN (SELECT full_name FROM crm_people WHERE id = ?) ELSE full_name END,
        phone     = CASE WHEN phone     = '' THEN (SELECT phone     FROM crm_people WHERE id = ?) ELSE phone     END,
        phone_key = CASE WHEN phone_key = '' THEN (SELECT phone_key FROM crm_people WHERE id = ?) ELSE phone_key END,
        email     = CASE WHEN email     = '' THEN (SELECT email     FROM crm_people WHERE id = ?) ELSE email     END,
        email_key = CASE WHEN email_key = '' THEN (SELECT email_key FROM crm_people WHERE id = ?) ELSE email_key END,
        instagram_handle = CASE WHEN instagram_handle = '' THEN (SELECT instagram_handle FROM crm_people WHERE id = ?) ELSE instagram_handle END,
        handle_key = CASE WHEN handle_key = '' THEN (SELECT handle_key FROM crm_people WHERE id = ?) ELSE handle_key END,
        company   = CASE WHEN company   = '' THEN (SELECT company   FROM crm_people WHERE id = ?) ELSE company   END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?`)
      .bind(loserId, loserId, loserId, loserId, loserId, loserId, loserId, loserId, winnerId, workspaceId),

    // Tombstone, never delete. Historical webhook logs and any external system that recorded the old
    // id must keep resolving — resolveTombstone() follows the pointer to whoever is live now.
    db.prepare(`UPDATE crm_people SET is_active = 0, merged_into_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?`).bind(winnerId, loserId, workspaceId),

    db.prepare(`UPDATE crm_merge_candidates SET status = 'merged', resolved_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND (profile_a_id = ? OR profile_b_id = ?)`).bind(workspaceId, loserId, loserId),

    db.prepare(`INSERT INTO crm_events (workspace_id, kind, entity_id) VALUES (?, 'profile_merge', ?)`)
      .bind(workspaceId, `${loserId}->${winnerId}:${reason}`),
  );

  await db.batch(statements);
  return {
    survivingProfileId: winnerId,
    mergedProfileId: loserId,
    movedConversations: convCount?.n ?? 0,
    movedIdentities: idnCount?.n ?? 0,
    leadAction,
  };
}

/* ------------------------------------------------------------------ backfill */

export interface BackfillProgress {
  peopleProcessed: number; identitiesCreated: number; done: boolean; cursor: string;
  /** Phase A: historical captures converted into profiles. */
  legacyProcessed: number; profilesCreated: number; phase: "legacy" | "identities" | "done";
}

// Channels the legacy capture store used, mapped onto the conversation channels that exist now.
// 'test_studio_chat' is deliberately absent: those rows are the assistant test harness, not real
// customers, and importing them would put fake people in the pipeline.
const LEGACY_CHANNEL: Record<string, Channel> = {
  widget: "webchat", webchat: "webchat", whatsapp: "whatsapp", instagram: "instagram",
};

/**
 * Phase A — the actual legacy data.
 *
 * The flat lead history lives in `action_submissions`, not in `crm_people`: that table only ever
 * held profiles created after the Conversations module shipped, so a backfill that iterates it
 * finds nothing and reports success. This walks the real capture store instead.
 *
 * Each row is replayed through `qualifyConversation`, the same path a live capture takes. That
 * means the historical import inherits the waterfall, the dedup guarantee and lead creation rather
 * than growing a second implementation that could disagree with the first.
 */
async function backfillLegacyCaptures(
  db: D1Database, workspaceId: string, afterId: number, batchSize: number,
): Promise<{ processed: number; profiles: number; lastId: number; done: boolean }> {
  const rows = await db.prepare(`SELECT id, session_id, channel, data FROM action_submissions
    WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .bind(workspaceId, afterId, batchSize)
    .all<{ id: number; session_id: string; channel: string; data: string }>();
  const results = rows.results || [];

  let profiles = 0;
  let lastId = afterId;
  for (const row of results) {
    lastId = row.id;
    const channel = LEGACY_CHANNEL[(row.channel || "").trim()];
    if (!channel || !row.session_id) continue;
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { continue; }
    const hints = identityFrom(data);
    // A WhatsApp thread key is itself a reachable number even when the captured fields are thin.
    if (channel === "whatsapp" && !hints.phone) hints.phone = row.session_id;
    const outcome = await qualifyConversation(db, workspaceId, channel, row.session_id, hints).catch(() => null);
    if (outcome) profiles++;
  }
  return { processed: results.length, profiles, lastId, done: results.length < batchSize };
}

/**
 * One-time migration of the flat legacy shape into identity rows. Idempotent by construction —
 * every insert collides harmlessly on the unique index — and resumable via a stored cursor, because
 * a Worker invocation will not survive a workspace with tens of thousands of profiles in one pass.
 */
export async function runBackfill(db: D1Database, workspaceId: string, batchSize = BACKFILL_BATCH): Promise<BackfillProgress> {
  await ensureIdentitySchema(db);
  const state = await db.prepare(`SELECT last_person_id, last_submission_id, people_done, identities_created, legacy_done, profiles_created
    FROM crm_backfill_state WHERE workspace_id = ?`)
    .bind(workspaceId).first<{ last_person_id: string; last_submission_id: number; people_done: number; identities_created: number; legacy_done: number; profiles_created: number }>();
  const cursor = state?.last_person_id || "";
  const legacyDone = state?.legacy_done === 1;
  const priorProfiles = state?.profiles_created || 0;

  // Phase A must finish before phase B: it is what creates the profiles phase B then walks.
  if (!legacyDone) {
    const legacy = await backfillLegacyCaptures(db, workspaceId, state?.last_submission_id || 0, batchSize);
    await db.prepare(`INSERT INTO crm_backfill_state (workspace_id, last_submission_id, profiles_created, legacy_done)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET last_submission_id = excluded.last_submission_id,
        profiles_created = excluded.profiles_created, legacy_done = excluded.legacy_done`)
      .bind(workspaceId, legacy.lastId, priorProfiles + legacy.profiles, legacy.done ? 1 : 0).run();
    return {
      peopleProcessed: state?.people_done || 0,
      identitiesCreated: state?.identities_created || 0,
      legacyProcessed: legacy.lastId,
      profilesCreated: priorProfiles + legacy.profiles,
      done: false,
      cursor,
      phase: "legacy",
    };
  }

  const people = await db.prepare(`SELECT id, full_name, phone, email, instagram_handle, company
    FROM crm_people WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .bind(workspaceId, cursor, batchSize).all<{ id: string; full_name: string; phone: string; email: string; instagram_handle: string; company: string }>();
  const rows = people.results || [];

  const statements: D1PreparedStatement[] = [];
  let created = 0;
  const push = (profileId: string, channel: IdentityChannel, kind: IdentityKind, raw: string) => {
    if (!raw || !raw.trim()) return;
    const { normalized, matchTail } = normalizeFor(kind, raw);
    if (!normalized) return;
    created++;
    statements.push(db.prepare(`INSERT INTO crm_identities
      (id, workspace_id, profile_id, channel, kind, identifier_value, normalized_value, match_tail, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(workspace_id, kind, normalized_value) DO NOTHING`)
      .bind(newId("idn"), workspaceId, profileId, channel, kind, raw.slice(0, 200), normalized, matchTail));
  };

  for (const person of rows) {
    // A phone that arrived over WhatsApp and one typed into a form are the same identity kind, so
    // legacy phone columns are recorded as whatsapp-channel phone identities.
    push(person.id, "whatsapp", "phone", person.phone);
    push(person.id, "email", "email", person.email);
    push(person.id, "instagram", "handle", person.instagram_handle);
  }

  // Web chat threads already linked to a profile become visitor identities, which is what lets a
  // returning anonymous session resolve to the person it belongs to.
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const conversations = await db.prepare(`SELECT person_id, thread_key FROM crm_conversations
      WHERE workspace_id = ? AND channel = 'webchat' AND person_id IN (${ids.map(() => "?").join(",")})`)
      .bind(workspaceId, ...ids).all<{ person_id: string; thread_key: string }>();
    for (const conv of conversations.results || []) push(conv.person_id, "webchat_visitor", "visitor", conv.thread_key);
  }

  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));

  const nextCursor = rows.length ? rows[rows.length - 1].id : cursor;
  const done = rows.length < batchSize;
  const peopleDone = (state?.people_done || 0) + rows.length;
  const identitiesCreated = (state?.identities_created || 0) + created;
  await db.prepare(`INSERT INTO crm_backfill_state (workspace_id, last_person_id, people_done, identities_created, completed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET last_person_id = excluded.last_person_id,
      people_done = excluded.people_done, identities_created = excluded.identities_created,
      completed_at = excluded.completed_at`)
    .bind(workspaceId, nextCursor, peopleDone, identitiesCreated, done ? new Date().toISOString() : null).run();

  return {
    peopleProcessed: peopleDone, identitiesCreated, done, cursor: nextCursor,
    legacyProcessed: state?.last_submission_id || 0, profilesCreated: priorProfiles,
    phase: done ? "done" : "identities",
  };
}

/* ------------------------------------------------------------------ HTTP surface */

async function listIdentities(request: Request, env: IdentityEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const profileId = (new URL(request.url).searchParams.get("profileId") || "").trim();
  if (!profileId) return json(request, { error: "Missing profileId." }, 400);
  await ensureIdentitySchema(env.DB);
  const rows = await env.DB.prepare(`SELECT id, channel, kind, identifier_value, normalized_value, is_verified, created_at
    FROM crm_identities WHERE workspace_id = ? AND profile_id = ? ORDER BY created_at ASC`)
    .bind(session.workspaceId, profileId).all<{ id: string; channel: string; kind: string; identifier_value: string; normalized_value: string; is_verified: number; created_at: string }>();
  return json(request, {
    identities: (rows.results || []).map((r) => ({
      id: r.id, channel: r.channel, kind: r.kind, value: r.identifier_value,
      normalized: r.normalized_value, verified: r.is_verified === 1, createdAt: r.created_at,
    })),
  });
}

async function listMergeCandidates(request: Request, env: IdentityEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  await ensureIdentitySchema(env.DB);
  const rows = await env.DB.prepare(`SELECT c.id, c.profile_a_id, c.profile_b_id, c.reason, c.confidence, c.created_at,
      a.full_name a_name, a.company a_company, b.full_name b_name, b.company b_company
    FROM crm_merge_candidates c
    JOIN crm_people a ON a.id = c.profile_a_id
    JOIN crm_people b ON b.id = c.profile_b_id
    WHERE c.workspace_id = ? AND c.status = 'pending' AND a.is_active = 1 AND b.is_active = 1
    ORDER BY c.confidence DESC, c.created_at ASC LIMIT 100`)
    .bind(session.workspaceId).all<Record<string, string | number>>();
  return json(request, {
    candidates: (rows.results || []).map((r) => ({
      id: r.id,
      reason: r.reason,
      confidence: r.confidence,
      createdAt: r.created_at,
      a: { id: r.profile_a_id, name: r.a_name, company: r.a_company },
      b: { id: r.profile_b_id, name: r.b_name, company: r.b_company },
    })),
  });
}

async function mergeProfiles(request: Request, env: IdentityEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { sourceProfileId?: string; targetProfileId?: string };
  const loserId = (body.sourceProfileId || "").trim();
  const winnerId = (body.targetProfileId || "").trim();
  if (!loserId || !winnerId) return json(request, { error: "Both sourceProfileId and targetProfileId are required." }, 400);
  if (loserId === winnerId) return json(request, { error: "A profile cannot be merged into itself." }, 400);
  await ensureIdentitySchema(env.DB);

  // Both must exist in *this* workspace — the id alone is not authority to touch a row.
  const rows = await env.DB.prepare(`SELECT id, is_active FROM crm_people WHERE workspace_id = ? AND id IN (?, ?)`)
    .bind(session.workspaceId, loserId, winnerId).all<{ id: string; is_active: number }>();
  const found = new Map((rows.results || []).map((r) => [r.id, r]));
  if (!found.has(loserId) || !found.has(winnerId)) return json(request, { error: "Profile not found in this workspace." }, 404);
  if (found.get(winnerId)!.is_active !== 1) return json(request, { error: "The target profile has already been merged into another." }, 409);

  const outcome = await absorbProfile(env.DB, session.workspaceId, loserId, winnerId, `manual:${session.email}`);
  return json(request, { ok: true, ...outcome });
}

async function rejectCandidate(request: Request, env: IdentityEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await request.json() as { candidateId?: string };
  const candidateId = (body.candidateId || "").trim();
  if (!candidateId) return json(request, { error: "Missing candidateId." }, 400);
  await ensureIdentitySchema(env.DB);
  await env.DB.prepare(`UPDATE crm_merge_candidates SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
    WHERE workspace_id = ? AND id = ?`).bind(session.email, session.workspaceId, candidateId).run();
  return json(request, { ok: true });
}

async function backfill(request: Request, env: IdentityEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const progress = await runBackfill(env.DB, session.workspaceId);
  return json(request, progress);
}

export async function handleIdentityRequest(request: Request, env: IdentityEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/profiles")) return null;
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (request.headers.get("origin") && !allowedOrigin(request)) return json(request, { error: "Origin not allowed" }, 403);
  if (!env.DB) return json(request, { error: "Workspace database is unavailable." }, 503);

  if (url.pathname === "/api/profiles/merge" && request.method === "POST") return mergeProfiles(request, env);
  if (url.pathname === "/api/profiles/identities" && request.method === "GET") return listIdentities(request, env);
  if (url.pathname === "/api/profiles/merge-candidates" && request.method === "GET") return listMergeCandidates(request, env);
  if (url.pathname === "/api/profiles/merge-candidates/reject" && request.method === "POST") return rejectCandidate(request, env);
  if (url.pathname === "/api/profiles/backfill" && request.method === "POST") return backfill(request, env);
  return null;
}
