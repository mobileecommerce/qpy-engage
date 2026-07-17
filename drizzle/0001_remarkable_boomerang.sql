CREATE TABLE `whatsapp_connections` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`business_id` text,
	`waba_id` text NOT NULL,
	`phone_number_id` text NOT NULL,
	`display_phone_number` text,
	`verified_name` text,
	`quality_rating` text,
	`status` text,
	`token_ciphertext` text NOT NULL,
	`token_iv` text NOT NULL,
	`token_expires_at` text,
	`webhook_subscribed` integer DEFAULT 0 NOT NULL,
	`connected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `whatsapp_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`wa_id` text,
	`phone_number_id` text,
	`message_type` text,
	`message_text` text,
	`status` text,
	`message_timestamp` text,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `whatsapp_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`object_type` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
