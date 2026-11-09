ALTER TABLE `projects` ADD COLUMN `source_kind` text DEFAULT 'video' NOT NULL;
--> statement-breakpoint
CREATE TABLE `live_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `video_id` text NOT NULL,
  `title` text NOT NULL,
  `creator` text NOT NULL,
  `status` text NOT NULL DEFAULT 'unknown',
  `detail` text NOT NULL DEFAULT '',
  `first_live_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_events_video_id_unique` ON `live_events` (`video_id`);
