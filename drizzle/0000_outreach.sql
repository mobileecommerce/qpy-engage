CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sector_id` integer NOT NULL,
	`place_id` text NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`city` text,
	`lat` real,
	`lng` real,
	`phone_raw` text,
	`phone_e164` text,
	`website` text,
	`email` text,
	`google_maps_url` text,
	`rating` real,
	`rating_count` integer,
	`status` text DEFAULT 'new' NOT NULL,
	`enrich_attempts` integer DEFAULT 0 NOT NULL,
	`touches` integer DEFAULT 0 NOT NULL,
	`last_contacted_at` text,
	`next_contact_at` text,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_place_id_unique` ON `leads` (`place_id`);--> statement-breakpoint
CREATE INDEX `leads_status_idx` ON `leads` (`status`);--> statement-breakpoint
CREATE INDEX `leads_sector_idx` ON `leads` (`sector_id`);--> statement-breakpoint
CREATE INDEX `leads_phone_idx` ON `leads` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `leads_email_idx` ON `leads` (`email`);--> statement-breakpoint
CREATE INDEX `leads_next_contact_idx` ON `leads` (`next_contact_at`);--> statement-breakpoint
CREATE TABLE `opt_outs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identifier` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opt_outs_identifier_unique` ON `opt_outs` (`identifier`);--> statement-breakpoint
CREATE TABLE `outreach_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`channel` text NOT NULL,
	`provider_message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`template` text,
	`body` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `outreach_messages` (`lead_id`);--> statement-breakpoint
CREATE INDEX `messages_provider_idx` ON `outreach_messages` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `outreach_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`summary` text
);
--> statement-breakpoint
CREATE TABLE `sectors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`search_query` text NOT NULL,
	`city` text,
	`region_code` text DEFAULT 'IN',
	`whatsapp_template` text,
	`email_subject` text,
	`email_body` text,
	`enabled` integer DEFAULT true NOT NULL,
	`max_new_leads_per_run` integer DEFAULT 40 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sectors_slug_unique` ON `sectors` (`slug`);