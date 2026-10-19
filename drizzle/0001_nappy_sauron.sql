CREATE TABLE `billing_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`period` text NOT NULL,
	`plan_snapshot` text NOT NULL,
	`provider_customer_id` text,
	`provider_session_id` text,
	`checkout_url` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "billing_checkouts_amount_check" CHECK("billing_checkouts"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_checkouts_provider_session_id_unique` ON `billing_checkouts` (`provider_session_id`);--> statement-breakpoint
CREATE INDEX `billing_checkouts_user_idx` ON `billing_checkouts` (`user_id`);--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider_customer_id` text NOT NULL,
	`trial_used` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_provider_customer_id_unique` ON `billing_customers` (`provider_customer_id`);--> statement-breakpoint
CREATE TABLE `billing_locks` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`resource_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
ALTER TABLE `payments` ADD `provider_invoice_id` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `refunded_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `sync_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `provider_customer_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `checkout_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `cancel_at_period_end` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_revision` integer DEFAULT 0 NOT NULL;