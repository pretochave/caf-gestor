CREATE TABLE `firebase_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`uid` text NOT NULL,
	`email` text NOT NULL,
	`kind` text NOT NULL,
	`encrypted_tokens` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `firebase_sessions_owner_idx` ON `firebase_sessions` (`owner_id`);--> statement-breakpoint
CREATE INDEX `firebase_sessions_email_idx` ON `firebase_sessions` (`email`);--> statement-breakpoint
CREATE INDEX `firebase_sessions_expiry_idx` ON `firebase_sessions` (`expires_at`);