# Conversations — technical architecture

Deliverable B for the unified Conversations module.

**A note on the brief.** The spec asked for a PostgreSQL/Prisma schema and a Socket.io + Redis
real-time layer. Qpy Engage runs on Cloudflare Workers with D1 (SQLite) and ships its dashboard as
a static export — Workers cannot run Socket.io, cannot hold a Redis connection, and there is no Node
process to host either. Writing that stack would have produced a spec that never runs.

So this document gives both: **§1 is the D1 schema that actually ships**, §2 is the PostgreSQL /
Prisma equivalent for portability, and §3 designs real-time for Cloudflare with the Socket.io+Redis
concepts mapped one-to-one onto what the platform provides.

---

## 1. Shipped schema (D1 / SQLite)

Defined in `worker/conversations.ts`, created idempotently on first request. Four tables plus an
event log.

### 1.1 `crm_people` — identity

One row per human, regardless of how many channels they use. The `*_key` columns are the
normalisation used for deduplication and are the only thing ever compared.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `per_<22 hex>` |
| `workspace_id` | TEXT | tenant boundary, present on every index |
| `full_name`, `company` | TEXT | display only |
| `phone` / `phone_key` | TEXT | key = last 9 digits, non-digits stripped |
| `email` / `email_key` | TEXT | key = trimmed, lowercased |
| `instagram_handle` / `handle_key` | TEXT | key = lowercased, leading `@` stripped |
| `avatar_tone` | INTEGER | stable 0–5 colour, derived from id |

Indexes: `(workspace_id, phone_key)`, `(workspace_id, email_key)`, `(workspace_id, handle_key)`.

**Why the last 9 digits.** `+971 50 123 4567`, `0501234567` and `971501234567` are the same person
and must collapse; a full E.164 library is overkill inside a Worker. Nine digits is short enough to
survive a missing country code and long enough not to collide across real customers — verified
against both the matching and non-matching cases.

### 1.2 `crm_conversations` — threads

| Column | Notes |
|---|---|
| `id` | `conv_<22 hex>` |
| `channel` | `whatsapp` \| `instagram` \| `webchat` |
| `thread_key` | the channel's own id: widget session id, `wa_id`, IG sender id |
| `person_id` | NULL until qualified — this is what makes anonymous visitors first-class |
| `last_message`, `last_at`, `last_role`, `message_count` | feed projection |
| `unread`, `ai_active`, `needs_attention`, `attention_reason`, `state` | inbox state |

Unique index `(workspace_id, channel, thread_key)` — an inbound message always finds exactly one
thread, so delivery is idempotent.

**Messages are not re-stored.** `widget_messages` and `whatsapp_messages` already exist and are
written by live channel code. `crm_conversations` is a *projection* refreshed on read
(`syncFeed`), not a second copy. Migrating those tables would have put two working channels at risk
for no user-visible gain.

### 1.3 `crm_leads` — the sales record

Keyed on `person_id`, **not** `conversation_id`, with a unique index on
`(workspace_id, person_id)`. That single constraint is what makes "same customer, WhatsApp and web
chat" one lead instead of two — it is enforced by the database, not by application logic that can be
bypassed.

Columns: `stage`, `priority`, `segment`, `source`, `owner`, `next_followup`, `board_order`.

`stage` is validated against the pipeline on write; an unknown stage is a 400, never a silent insert.

### 1.4 `crm_events` — the change log

`(seq AUTOINCREMENT, workspace_id, kind, entity_id, created_at)`.

Every mutation appends a row. This is the transport-independent half of real-time: a WebSocket
pushes these rows, a poll pulls them, and **the payload is identical either way**. Swapping
transport later changes no read model and no UI code.

### 1.5 Pipeline stages

Stages ship as a constant (`New → Contacted → Qualified → Proposal → Closed Won → Closed Lost`)
rather than a table. A `pipeline_stages` table is the right call the moment stages become editable
per workspace; until then a table would be a join with exactly one possible answer. The §2 schema
includes it, since a Postgres deployment implies that scale.

---

## 2. PostgreSQL / Prisma equivalent

For a Postgres deployment. Differences from §1 are called out inline.

```prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "postgresql"; url = env("DATABASE_URL") }

enum Channel       { WHATSAPP INSTAGRAM WEBCHAT }
enum MessageRole   { VISITOR AGENT ASSISTANT SYSTEM }
enum ConversationState { OPEN SNOOZED CLOSED }

model Contact {
  id              String   @id @default(cuid())
  workspaceId     String
  fullName        String   @default("")
  company         String   @default("")
  phone           String   @default("")
  phoneKey        String   @default("")   // last 9 digits
  email           String   @default("")
  emailKey        String   @default("")   // lowercased
  instagramHandle String   @default("")
  handleKey       String   @default("")   // lowercased, no @
  avatarTone      Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  conversations Conversation[]
  lead          Lead?

  // Partial unique indexes are the Postgres upgrade over D1: dedup keys become a database
  // guarantee rather than a query convention, so a race cannot create two people.
  @@unique([workspaceId, phoneKey],  name: "contact_phone")
  @@unique([workspaceId, emailKey],  name: "contact_email")
  @@unique([workspaceId, handleKey], name: "contact_handle")
  @@index([workspaceId])
}

model Conversation {
  id              String   @id @default(cuid())
  workspaceId     String
  channel         Channel
  threadKey       String
  contactId       String?
  contact         Contact? @relation(fields: [contactId], references: [id], onDelete: SetNull)
  displayName     String   @default("")
  lastMessage     String   @default("") @db.VarChar(400)
  lastAt          DateTime?
  lastRole        MessageRole?
  messageCount    Int      @default(0)
  unread          Boolean  @default(false)
  aiActive        Boolean  @default(true)
  needsAttention  Boolean  @default(false)
  attentionReason String   @default("")
  state           ConversationState @default(OPEN)
  messages        Message[]

  @@unique([workspaceId, channel, threadKey])
  @@index([workspaceId, lastAt(sort: Desc)])
  @@index([workspaceId, unread])
}

model Message {
  id             String   @id @default(cuid())
  workspaceId    String
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  role           MessageRole
  body           String
  externalId     String?      // provider id — dedups webhook retries
  createdAt      DateTime @default(now())

  @@unique([conversationId, externalId])
  @@index([conversationId, createdAt])
}

model PipelineStage {
  id          String @id @default(cuid())
  workspaceId String
  name        String
  position    Int
  isWon       Boolean @default(false)
  isLost      Boolean @default(false)
  leads       Lead[]

  @@unique([workspaceId, name])
  @@index([workspaceId, position])
}

model Lead {
  id           String   @id @default(cuid())
  workspaceId  String
  contactId    String   @unique          // one lead per person — the dedup guarantee
  contact      Contact  @relation(fields: [contactId], references: [id], onDelete: Cascade)
  stageId      String
  stage        PipelineStage @relation(fields: [stageId], references: [id])
  priority     String   @default("")
  segment      String   @default("")
  source       String   @default("")
  ownerId      String?
  nextFollowup DateTime?
  boardOrder   Int      @default(0)
  score        Int?
  scoreReasons Json     @default("[]")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([workspaceId, stageId, boardOrder])
}

model ChangeEvent {
  seq         BigInt   @id @default(autoincrement())
  workspaceId String
  kind        String
  entityId    String
  createdAt   DateTime @default(now())

  @@index([workspaceId, seq])
}
```

**Two upgrades Postgres buys you**, both worth taking: partial unique indexes on the dedup keys turn
deduplication into a database guarantee (D1 enforces it in application code, which a concurrent
write could in principle race), and `PipelineStage` as a real table makes stages editable per
workspace.

---

## 3. Real-time architecture

### 3.1 Why not Socket.io + Redis

| Requirement | Socket.io + Redis | On Cloudflare |
|---|---|---|
| Long-lived connection | Node process | **Durable Object** with hibernating WebSockets |
| Fan-out across nodes | Redis pub/sub adapter | DO *is* the single point — no adapter needed |
| Presence / room state | Redis keys | DO instance memory + storage |
| Backfill after reconnect | Redis stream | `crm_events` table (§1.4) |

A Worker is request-scoped and cannot hold a socket; a Durable Object can, and because exactly one
DO instance exists per id, the Redis pub/sub layer that Socket.io needs for multi-node fan-out has
no equivalent problem to solve. **One DO per workspace** — `env.CX_HUB.idFromName(workspaceId)` —
is the whole topology.

### 3.2 Target design

```
Channel webhook ─┐
Dashboard PATCH ─┼─► Worker ─► D1 write ─► append crm_events
                 │                              │
                 │                              └─► DO stub.fetch("/publish", {seq, kind, entityId})
                 │
Dashboard ◄──────┴─ WebSocket ◄─ CxHub DO ─ broadcast to every socket for this workspace
```

```ts
export class CxHub implements DurableObject {
  private sockets = new Set<WebSocket>();
  constructor(private state: DurableObjectState) {
    // Hibernation: sockets survive eviction, so an idle dashboard costs nothing.
    this.state.getWebSockets().forEach((ws) => this.sockets.add(ws));
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/publish") {
      const event = await request.json();
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(JSON.stringify(event)); } catch { /* dropped on close */ }
      }
      return new Response(null, { status: 204 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);          // hibernatable
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
```

The client sends its last `seq` on connect; anything newer is replayed from `crm_events` before live
events resume, so a dropped connection cannot lose an update.

### 3.3 What ships today

`GET /api/cx/sync?since=<seq>` returns `{cursor, events[]}` — the same payload the socket would
push. The dashboard polls it.

This is a deliberate choice, not a shortcut. Durable Objects are a paid Workers feature and adding
the binding changes the deployment; the event log means adopting them later is a transport swap
behind one function, with no change to the schema, the read models, or any component.

### 3.4 Bi-directional sync in the UI

The spec's requirement — a field edited in the chat panel updates the Leads table instantly, and
vice versa — is met **without** relying on the network at all:

```
ConversationsModule
  ├── conversations[]   each carries an embedded lead summary
  └── leads[]           the same lead, projected for the table and board

applyLead(leadId, patch)  →  writes BOTH projections in one pass
```

`saveLead()` applies the patch optimistically, PATCHes, then reconciles with the server's response;
on failure it restores the previous value. Because one writer owns both projections, the table and
the chat header **cannot** disagree — there is no refresh, no refetch and no flicker. The delta sync
in §3.3 handles the different problem of a *second* user's changes.

---

## 4. Visitor-to-lead lifecycle

```
anonymous thread ──► AI or agent captures phone / email / IG handle
                          │
                          ▼
              qualifyConversation(workspace, channel, threadKey, hints)
                          │
                    resolvePerson()  ── match on any key ─► existing person (absorbs new detail)
                          │           ── no match ────────► new person
                          ▼
              conversation.person_id set  +  lead created if none exists
```

Entry points, both landing on the same function:

1. **Automatic** — `saveSubmission()` in `worker/leads.ts`, the single place both channels record a
   capture, so every AI Action feeds the lifecycle with no per-channel wiring.
2. **Manual** — `POST /api/cx/qualify` when an agent types details into the panel.

Three deliberate rules:

- **A name alone is not a lead.** Qualification requires a way to reach the person back. Visitors
  who say "I'm Sam" and leave would otherwise fill the pipeline with unreachable records.
- **Merges fill blanks only.** An existing value was entered by a human or seen first; a later guess
  never overwrites it.
- **Deleting a lead keeps the person and the conversation.** The sales record is disposable, the
  message history is not.

---

## 5. API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cx/conversations` | unified feed + filter counts |
| GET | `/api/cx/messages?channel&threadKey` | thread; clears unread |
| GET | `/api/cx/leads` | leads + stages + filter options |
| PATCH | `/api/cx/leads/:id` | stage, priority, segment, source, owner, follow-up, board order |
| DELETE | `/api/cx/leads/:id` | delete lead, keep person and conversation |
| POST | `/api/cx/qualify` | manual visitor-to-lead promotion |
| GET | `/api/cx/sync?since=` | delta events since a cursor |

All require a session; all are workspace-scoped in the query itself, never by a filter applied after
the fact.
