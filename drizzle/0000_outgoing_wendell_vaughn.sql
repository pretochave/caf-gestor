CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_user_idx` ON `contacts` (`user_id`);--> statement-breakpoint
CREATE TABLE `crm` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crm_user_id_unique` ON `crm` (`user_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`user_id` text,
	`message` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`farm_id` text NOT NULL,
	`plot_id` text,
	`season_id` text,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`farm_id`,`owner_id`) REFERENCES `farms`(`id`,`owner_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plot_id`,`farm_id`,`owner_id`) REFERENCES `plots`(`id`,`farm_id`,`owner_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`season_id`,`owner_id`) REFERENCES `seasons`(`id`,`owner_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `expenses_owner_farm_idx` ON `expenses` (`owner_id`,`farm_id`);--> statement-breakpoint
CREATE TABLE `farms` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `farms_owner_idx` ON `farms` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `farms_id_owner_unique` ON `farms` (`id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text,
	`provider_payment_id` text NOT NULL,
	`amount` real NOT NULL,
	`status` text NOT NULL,
	`paid_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "payments_amount_check" CHECK("payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_payment_id_unique` ON `payments` (`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`farm_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`farm_id`,`owner_id`) REFERENCES `farms`(`id`,`owner_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plots_owner_farm_idx` ON `plots` (`owner_id`,`farm_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plots_id_farm_owner_unique` ON `plots` (`id`,`farm_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `productions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`farm_id` text NOT NULL,
	`plot_id` text,
	`season_id` text,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`farm_id`,`owner_id`) REFERENCES `farms`(`id`,`owner_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plot_id`,`farm_id`,`owner_id`) REFERENCES `plots`(`id`,`farm_id`,`owner_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`season_id`,`owner_id`) REFERENCES `seasons`(`id`,`owner_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `productions_owner_farm_idx` ON `productions` (`owner_id`,`farm_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_access` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "profiles_status_check" CHECK("profiles"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `profiles_email_idx` ON `profiles` (`email`);--> statement-breakpoint
CREATE TABLE `revenues` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`farm_id` text NOT NULL,
	`plot_id` text,
	`season_id` text,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`farm_id`,`owner_id`) REFERENCES `farms`(`id`,`owner_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`season_id`,`owner_id`) REFERENCES `seasons`(`id`,`owner_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `revenues_owner_farm_idx` ON `revenues` (`owner_id`,`farm_id`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seasons_owner_idx` ON `seasons` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_id_owner_unique` ON `seasons` (`id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`provider_subscription_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` real NOT NULL,
	`period` text DEFAULT 'monthly' NOT NULL,
	`current_period_end` text NOT NULL,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "subscriptions_amount_check" CHECK("subscriptions"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_provider_subscription_id_unique` ON `subscriptions` (`provider_subscription_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tickets_owner_idx` ON `tickets` (`owner_id`);