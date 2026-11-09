ALTER TABLE `accounts` ADD COLUMN `login_name` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_login_name_unique` ON `accounts` (`login_name`);
--> statement-breakpoint
ALTER TABLE `accounts` ADD COLUMN `password_hash` text;
--> statement-breakpoint
CREATE TABLE `sessions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`),
  `token_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
