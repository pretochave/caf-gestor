DROP INDEX `billing_checkouts_provider_session_id_unique`;--> statement-breakpoint
ALTER TABLE `billing_checkouts` ADD `livemode` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_checkouts_session_mode_unique` ON `billing_checkouts` (`provider_session_id`,`livemode`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_billing_customers` (
	`user_id` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`livemode` integer DEFAULT true NOT NULL,
	`trial_used` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `livemode`),
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_billing_customers`("user_id", "provider_customer_id", "livemode", "trial_used", "created_at") SELECT "user_id", "provider_customer_id", true, "trial_used", "created_at" FROM `billing_customers`;--> statement-breakpoint
DROP TABLE `billing_customers`;--> statement-breakpoint
ALTER TABLE `__new_billing_customers` RENAME TO `billing_customers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_provider_mode_unique` ON `billing_customers` (`provider_customer_id`,`livemode`);--> statement-breakpoint
DROP INDEX `payments_provider_payment_id_unique`;--> statement-breakpoint
ALTER TABLE `payments` ADD `livemode` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_mode_unique` ON `payments` (`provider_payment_id`,`livemode`);--> statement-breakpoint
DROP INDEX `subscriptions_provider_subscription_id_unique`;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `livemode` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_provider_mode_unique` ON `subscriptions` (`provider_subscription_id`,`livemode`);--> statement-breakpoint
ALTER TABLE `billing_webhook_events` ADD `livemode` integer DEFAULT true NOT NULL;
