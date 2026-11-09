DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  creator TEXT NOT NULL,
  duration_sec REAL NOT NULL DEFAULT 0,
  thumbnail_key TEXT,
  transcript_lang TEXT NOT NULL DEFAULT '',
  transcript_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  subtitles_text TEXT NOT NULL DEFAULT '',
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX clips_project_idx ON clips (project_id);
