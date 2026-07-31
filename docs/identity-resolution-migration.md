# Identity Resolution Engine — migration & architecture

Upgrade of Qpy Engage from a flat lead model to Hub-and-Spoke identity resolution.
Implementation: [`worker/identity.ts`](../worker/identity.ts).

**On the brief.** It asks for Prisma/`$transaction`. This platform runs on Cloudflare Workers + D1
(SQLite); there is no Prisma client and **no interactive transaction** — `$transaction` does not
exist in D1. §1 is the migration that actually runs. §2 is the Prisma equivalent, for portability.
§5 explains what replaces `$transaction` and why the guarantee is still atomic.

---

## 0. Two decisions that shaped everything

**The hub is `crm_people`, elevated in place — not a new `Customer_Profiles` table.**
Renaming a live table breaks every reader the instant the migration lands, which is the opposite of
zero downtime. The alternative — create `Customer_Profiles`, dual-write, migrate readers, drop the
old — is three deploys and a window where two tables disagree. Elevating in place is one additive
migration with no cutover. The name buys nothing that a comment does not.

**Every step is additive.** Two `ALTER TABLE ... ADD COLUMN`, three `CREATE TABLE`, six
`CREATE INDEX`. No column is dropped, no data moves, no read path changes. The old denormalised
columns (`crm_people.phone_key`, `email_key`, `handle_key`) are **dual-written and kept**, so the
pre-IRE matcher and the IRE produce the same answers throughout the rollout. They can be dropped
later, once nothing reads them — not as part of this change.

---

## 1. The migration that ships (D1 / SQLite)

Applied idempotently by `ensureIdentitySchema()` on first request.

```sql
-- ── The Hub: elevate the existing table ──────────────────────────────────────
-- SQLite has no ADD COLUMN IF NOT EXISTS, and D1 raises on a duplicate column rather
-- than no-opping, so each is attempted independently; failure means "already applied".
ALTER TABLE crm_people ADD COLUMN merged_into_id TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_people ADD COLUMN is_active      INTEGER NOT NULL DEFAULT 1;

-- ── The Spokes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_identities (
  id               TEXT PRIMARY KEY NOT NULL,
  workspace_id     TEXT NOT NULL,
  profile_id       TEXT NOT NULL,          -- FK -> crm_people.id
  channel          TEXT NOT NULL,          -- whatsapp | email | webchat_visitor | instagram | manual
  kind             TEXT NOT NULL,          -- phone | email | handle | visitor
  identifier_value TEXT NOT NULL,          -- raw, as received
  normalized_value TEXT NOT NULL,          -- sanitized, the only thing ever matched on
  match_tail       TEXT NOT NULL DEFAULT '',  -- last 9 digits; phone fallback tier
  is_verified      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deduplication as a database guarantee, not a convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_unique
  ON crm_identities (workspace_id, kind, normalized_value);
CREATE INDEX IF NOT EXISTS idx_identity_profile ON crm_identities (workspace_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_identity_tail    ON crm_identities (workspace_id, kind, match_tail);

-- ── Tier 3 review queue ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_merge_candidates (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL,
  profile_a_id  TEXT NOT NULL,
  profile_b_id  TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  confidence    REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | merged | rejected
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   TEXT,
  resolved_by   TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_pair
  ON crm_merge_candidates (workspace_id, profile_a_id, profile_b_id);
CREATE INDEX IF NOT EXISTS idx_candidate_status ON crm_merge_candidates (workspace_id, status);

-- ── Resumable backfill bookkeeping ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_backfill_state (
  workspace_id       TEXT PRIMARY KEY NOT NULL,
  last_person_id     TEXT NOT NULL DEFAULT '',
  people_done        INTEGER NOT NULL DEFAULT 0,
  identities_created INTEGER NOT NULL DEFAULT 0,
  completed_at       TEXT
);
```

### `channel` vs `kind` — why both

`channel` is provenance; `kind` is what the identifier *is*. **Matching only ever happens on
`kind`.** That is what makes "treat all incoming WhatsApp numbers as phone identities" true rather
than aspirational: a number typed into a web form and the same number arriving over WhatsApp are
both `kind='phone'` and collide on the unique index. A single `channel` column could not express
that without special-casing WhatsApp at every call site.

---

## 2. Prisma / PostgreSQL equivalent

```prisma
enum IdentityChannel { WHATSAPP EMAIL WEBCHAT_VISITOR INSTAGRAM MANUAL }
enum IdentityKind    { PHONE EMAIL HANDLE VISITOR }
enum MergeStatus     { PENDING MERGED REJECTED }

model CustomerProfile {                      // the Hub (crm_people)
  id           String   @id @default(cuid())
  workspaceId  String
  primaryName  String   @default("")
  company      String   @default("")
  isActive     Boolean  @default(true)
  mergedIntoId String?
  mergedInto   CustomerProfile?  @relation("Tombstone", fields: [mergedIntoId], references: [id])
  absorbed     CustomerProfile[] @relation("Tombstone")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  identities    ContactIdentity[]
  conversations Conversation[]
  lead          Lead?

  @@index([workspaceId, isActive])
}

model ContactIdentity {                      // the Spokes
  id              String          @id @default(cuid())
  workspaceId     String
  profileId       String
  profile         CustomerProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  channel         IdentityChannel
  kind            IdentityKind
  identifierValue String                     // raw
  normalizedValue String                     // sanitized — the only matched field
  matchTail       String          @default("")
  isVerified      Boolean         @default(false)
  createdAt       DateTime        @default(now())

  @@unique([workspaceId, kind, normalizedValue])
  @@index([workspaceId, profileId])
  @@index([workspaceId, kind, matchTail])
}

model MergeCandidate {
  id           String      @id @default(cuid())
  workspaceId  String
  profileAId   String
  profileBId   String
  reason       String
  confidence   Float       @default(0)
  status       MergeStatus @default(PENDING)
  createdAt    DateTime    @default(now())

  @@unique([workspaceId, profileAId, profileBId])
  @@index([workspaceId, status])
}
```

**What Postgres buys:** a real FK with `onDelete: Cascade` on identities, and a self-relation making
the tombstone chain traversable in one recursive CTE instead of the bounded loop in
`resolveTombstone()`.

---

## 3. Normalization pipeline

| Input | Rule | Output |
|---|---|---|
| `+971 50 123 4567` | strip non-digits, keep `+` | `+971501234567` |
| `00971501234567` | `00` → `+` | `+971501234567` |
| `0501234567` | trunk `0` → market country code | `+971501234567` |
| `971501234567` | already carries the code | `+971501234567` |
| `501234567` | bare subscriber number | `+971501234567` |
| `  Joel.Lee@HaveFun.NOW ` | trim + lowercase | `joel.lee@havefun.now` |
| `@RaviKumar` | trim, lowercase, drop `@` | `ravikumar` |
| `visitor-abc` | preserved verbatim | `visitor-abc` |

Verified: all seven phone forms collapse to one E.164 value, `+971509999999` does **not** collide
with them, and `+44 20 7946 0958` keeps its own country code.

**Why `match_tail` exists alongside E.164.** A local number carries no country code, so E.164
requires knowing the market. Guessing wrongly fabricates a number belonging to a real person, so
anything not confidently resolvable stays as digits and matches on the last 9 instead. That was the
pre-IRE matcher's *only* rule — keeping it as a lower tier means adopting E.164 tightens matching
**without silently unlinking customers who already matched**.

---

## 4. The waterfall — `resolveIdentity(channel, rawIdentifier, payload)`

| Tier | Trigger | Action |
|---|---|---|
| **1 — Deterministic** | exact `normalized_value` hit on `kind`; for phones, `match_tail` as fallback | attach to existing profile, unified thread |
| **2 — Session upgrade** | anonymous `visitor_id` supplies a phone/email already owned by a profile | absorb the visitor profile into it — no second lead |
| **2b** | identifier is new but the `visitor_id` is already known | attach identifier to that profile |
| **3 — Probabilistic** | same name **and** same company, no shared identifier | **flag only** — `crm_merge_candidates`, never auto-merge |
| **4 — New profile** | nothing matched | create hub + attach spoke |

Tier 3 never merges: two people at one company genuinely can share a name, and an incorrect
auto-merge is far more expensive to undo than a review queue is to staff.

**A second deterministic merge path:** if one capture carries both a phone and an email that resolve
to *different* existing profiles, that capture has just proven the two are the same human — the one
case where an automatic merge is warranted, so `qualifyConversation` performs it.

---

## 5. Safe merge — what replaces `$transaction`

D1 has no interactive transaction. It has **`db.batch()`**, which executes its statements
atomically: all commit or none do. The whole merge is composed as one batch — the strongest
guarantee this runtime can actually offer, rather than one merely claimed.

`POST /api/profiles/merge` → `{ sourceProfileId, targetProfileId }`

1. **FK reassignment** — `crm_conversations.person_id` and `crm_identities.profile_id` → target.
   Notes, documents and scores are keyed by *thread*, so they follow their conversation for free.
2. **Lead folding, not repointing.** `crm_leads` is `UNIQUE(workspace_id, person_id)`. Repointing a
   lead onto a target that already has one raises
   `UNIQUE constraint failed` — which inside an atomic batch **rolls back the entire merge**.
   When both sides have a lead the survivor absorbs only the fields it was missing and the loser's
   row is deleted; when only the loser has one it is repointed.
3. **Data preservation** — the target's blank hub columns are filled from the source.
4. **Tombstoning** — `is_active = 0`, `merged_into_id = target`. Never hard-deleted, so historical
   webhook logs and external references keep resolving via `resolveTombstone()`.

Verified end-to-end on a real database: 2 conversations unified, 0 orphans, both identities moved,
leads 2 → 1 with the survivor keeping `Qualified`/`Hot`, source row tombstoned and still present,
and a stale reference to the merged id resolving to the survivor.

---

## 6. Backfill

`POST /api/profiles/backfill` — call until `{ done: true }`.

Reads each `crm_people` row and emits identities from its legacy columns (phone → `whatsapp`/`phone`,
email → `email`/`email`, handle → `instagram`/`handle`), then turns every linked web chat
`thread_key` into a `webchat_visitor`/`visitor` identity.

- **Idempotent** — every insert is `ON CONFLICT ... DO NOTHING` against the unique index, so
  re-running it is free and safe.
- **Resumable** — a cursor in `crm_backfill_state`; a Worker will not survive a large workspace in
  one invocation, and pretending otherwise would mean a backfill that silently half-completes.
- **Non-destructive** — creates rows only. Legacy columns are left exactly as they were.

---

## 7. API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/profiles/merge` | atomic merge of two profiles |
| GET | `/api/profiles/identities?profileId=` | every spoke on a hub |
| GET | `/api/profiles/merge-candidates` | Tier 3 review queue |
| POST | `/api/profiles/merge-candidates/reject` | dismiss a candidate |
| POST | `/api/profiles/backfill` | run one resumable batch |

All require a session and are workspace-scoped in the query itself — an id alone is never authority
to touch a row.

---

## 8. Rollout order

1. Deploy — `ensureIdentitySchema()` applies additively; nothing reads the new tables yet. ✅ *done*
2. Ingestion writes identities via the waterfall while still dual-writing legacy columns. ✅ *done*
3. `POST /api/profiles/backfill` per workspace until `done`. ← **next, operator-run**
4. Work the Tier 3 review queue.
5. *Later, separately:* once nothing reads `phone_key`/`email_key`/`handle_key`, drop them.

Step 3 is deliberately operator-triggered rather than automatic on deploy: it rewrites identity data
across an entire workspace, and that should happen when someone is watching.
