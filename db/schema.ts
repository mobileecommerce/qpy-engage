import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Outreach pipeline tables.
 *
 * A "sector" is one Google Maps search we run every day (for example
 * "dental clinics in Hyderabad"). Every business it returns becomes a "lead".
 * Each message we send to a lead is recorded in `outreach_messages` so a lead
 * is never messaged twice on the same day and never again after it replies or
 * opts out.
 */

export const sectors = sqliteTable("sectors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Stable machine name, e.g. `dental-hyd`. Used to upsert from JSON. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Free-text query sent to Google Places Text Search, e.g. `dental clinic in Hyderabad`. */
  searchQuery: text("search_query").notNull(),
  city: text("city"),
  /** ISO 3166-1 alpha-2, e.g. `IN`. Biases the search and phone parsing. */
  regionCode: text("region_code").default("IN"),
  /** Approved WhatsApp template name. Falls back to the global env template. */
  whatsappTemplate: text("whatsapp_template"),
  emailSubject: text("email_subject"),
  /** Plain-text email body. Supports {{business_name}}, {{city}}, {{sector}}, {{unsubscribe_url}}. */
  emailBody: text("email_body"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Cap on brand-new leads pulled from Google per run, to control API spend. */
  maxNewLeadsPerRun: integer("max_new_leads_per_run").notNull().default(40),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const LEAD_STATUSES = [
  "new", // discovered, not yet enriched
  "ready", // enriched, has at least one contact channel
  "contacted", // at least one message sent
  "replied", // they answered; stop automated outreach
  "opted_out", // asked us to stop
  "exhausted", // reached max touches without a reply
  "unreachable", // no phone and no email found
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sectorId: integer("sector_id")
      .notNull()
      .references(() => sectors.id, { onDelete: "cascade" }),
    /** Google Place ID. Unique so the same business is never imported twice. */
    placeId: text("place_id").notNull().unique(),
    name: text("name").notNull(),
    address: text("address"),
    city: text("city"),
    lat: real("lat"),
    lng: real("lng"),
    phoneRaw: text("phone_raw"),
    /** E.164 without the plus sign, as WhatsApp expects (e.g. 919876543210). */
    phoneE164: text("phone_e164"),
    website: text("website"),
    email: text("email"),
    googleMapsUrl: text("google_maps_url"),
    rating: real("rating"),
    ratingCount: integer("rating_count"),
    status: text("status").$type<LeadStatus>().notNull().default("new"),
    enrichAttempts: integer("enrich_attempts").notNull().default(0),
    touches: integer("touches").notNull().default(0),
    lastContactedAt: text("last_contacted_at"),
    /** Earliest time the next automated touch may be sent. */
    nextContactAt: text("next_contact_at"),
    discoveredAt: text("discovered_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    notes: text("notes"),
  },
  (t) => [
    index("leads_status_idx").on(t.status),
    index("leads_sector_idx").on(t.sectorId),
    index("leads_phone_idx").on(t.phoneE164),
    index("leads_email_idx").on(t.email),
    index("leads_next_contact_idx").on(t.nextContactAt),
  ],
);

export const MESSAGE_CHANNELS = ["whatsapp", "email"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const outreachMessages = sqliteTable(
  "outreach_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: text("channel").$type<MessageChannel>().notNull(),
    /** WhatsApp message id (wamid.…) or Resend email id. */
    providerMessageId: text("provider_message_id"),
    /** queued | sent | delivered | read | failed */
    status: text("status").notNull().default("queued"),
    template: text("template"),
    body: text("body"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("messages_lead_idx").on(t.leadId),
    index("messages_provider_idx").on(t.providerMessageId),
    index("messages_created_idx").on(t.createdAt),
  ],
);

export const optOuts = sqliteTable("opt_outs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Normalised phone (digits only) or lower-cased email. */
  identifier: text("identifier").notNull().unique(),
  /** whatsapp_reply | email_unsubscribe | manual */
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
});

export const runLogs = sqliteTable("run_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** discover | send */
  kind: text("kind").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  /** JSON summary of counts and errors. */
  summary: text("summary"),
});

export type Sector = typeof sectors.$inferSelect;
export type NewSector = typeof sectors.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type OutreachMessage = typeof outreachMessages.$inferSelect;
