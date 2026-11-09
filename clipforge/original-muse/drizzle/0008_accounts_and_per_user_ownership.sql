CREATE TABLE `accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `viewer_key` text NOT NULL,
  `display_name` text NOT NULL DEFAULT 'Usuario',
  `role` text NOT NULL DEFAULT 'member',
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_viewer_key_unique` ON `accounts` (`viewer_key`);
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `owner_account_id` integer;
--> statement-breakpoint
ALTER TABLE `live_events` ADD COLUMN `owner_account_id` integer;
--> statement-breakpoint
CREATE TABLE `projects_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `video_id` text NOT NULL,
  `source_url` text NOT NULL,
  `title` text NOT NULL,
  `creator` text NOT NULL,
  `duration_sec` real DEFAULT 0 NOT NULL,
  `thumbnail_key` text,
  `avatar_url` text,
  `transcript_lang` text DEFAULT '' NOT NULL,
  `transcript_json` text DEFAULT '[]' NOT NULL,
  `source_kind` text DEFAULT 'video' NOT NULL,
  `owner_account_id` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `projects_new` (`id`, `video_id`, `source_url`, `title`, `creator`, `duration_sec`, `thumbnail_key`, `avatar_url`, `transcript_lang`, `transcript_json`, `source_kind`, `owner_account_id`, `created_at`) SELECT `id`, `video_id`, `source_url`, `title`, `creator`, `duration_sec`, `thumbnail_key`, `avatar_url`, `transcript_lang`, `transcript_json`, `source_kind`, `owner_account_id`, `created_at` FROM `projects`;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `projects_new` RENAME TO `projects`;
--> statement-breakpoint
CREATE INDEX `projects_video_idx` ON `projects` (`video_id`);
--> statement-breakpoint
CREATE INDEX `projects_owner_idx` ON `projects` (`owner_account_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `live_events_video_id_unique`;
--> statement-breakpoint
CREATE INDEX `live_events_video_idx` ON `live_events` (`video_id`);
--> statement-breakpoint
CREATE INDEX `live_events_owner_idx` ON `live_events` (`owner_account_id`);
