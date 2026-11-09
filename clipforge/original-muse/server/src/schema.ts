// Drizzle schema for SamuelClip.
//
// projects: one row per analyzed YouTube video. The parsed transcript cues
// are kept on the row (JSON) so re-scoring with different options does not
// need to refetch the subtitles.
// clips: the highlight moments chosen for a project, with exact second
// offsets into the source video, a viral score, and copy-ready cut text.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per person who opens the app (multi-user build, user request
// 2026-11-09: «cada usuario tenga su biblioteca aparte… yo seré admin
// y tendré el control de todas»). The row is keyed by the viewer's
// verified platform identity (ctx.viewer): local:<userId> inside
// Muse, cf:<tokenId> on a shared web link. The artifact's owner
// (isOwner) is promoted to role "admin" automatically; everyone else
// is a "member". An admin can view, manage and clear any account's
// library from the admin panel, and can block an account (a blocked
// account's actions are refused server-side).
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  viewerKey: text("viewer_key").notNull().unique(),
  displayName: text("display_name").notNull().default("Usuario"),
  // "admin" (the owner, Ronal) | "member"
  role: text("role").notNull().default("member"),
  // "active" | "blocked" (set by the admin from the admin panel)
  status: text("status").notNull().default("active"),
  // Login credentials (user request 2026-11-09: «mañana quiero ver un
  // login… cada usuario entra con su cuenta (usuario y contraseña, o
  // correo y contraseña)»). The login name is the normalized
  // (trimmed, lowercased) username or email the person chose; unique
  // when set. Null on accounts that have not created a login yet
  // (platform-identity accounts from before the login system).
  loginName: text("login_name").unique(),
  // "saltHex:hashHex" — PBKDF2-SHA256 (WebCrypto), never plaintext.
  passwordHash: text("password_hash"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per live login session. The client keeps the raw token in
// localStorage and sends it as `auth` on every action call; only the
// SHA-256 hash of the token is stored here, so a database leak does
// not hand out usable sessions. Sessions expire after 30 days.
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // NOT globally unique anymore: two different accounts can each have
  // their own project for the same YouTube video (per-user library).
  // Uniqueness is per (owner_account_id, video_id), enforced in code.
  videoId: text("video_id").notNull(),
  sourceUrl: text("source_url").notNull(),
  title: text("title").notNull(),
  creator: text("creator").notNull(),
  durationSec: real("duration_sec").notNull().default(0),
  thumbnailKey: text("thumbnail_key"),
  // The creator channel's avatar image URL (their face — for RDjavi his
  // official cartoon-face avatar), resolved lazily from the channel page
  // and burned into rendered clips as a small circular overlay in the
  // top-right corner. Null until resolved (or if the channel page does
  // not expose one); renders proceed without the overlay then.
  avatarUrl: text("avatar_url"),
  transcriptLang: text("transcript_lang").notNull().default(""),
  // JSON array of { s: startSec, e: endSec, t: text } cues.
  transcriptJson: text("transcript_json").notNull().default("[]"),
  // How this project was created: "video" = the normal subtitle-based
  // analysis; "live" = the live mode (moments detected from the stream's
  // live chat, because Alofoke's broadcasts carry no subtitles). Live
  // projects render with the full-frame layout, carry the live hashtag
  // set, and cannot be re-analyzed from a transcript they do not have.
  sourceKind: text("source_kind").notNull().default("video"),
  // The account whose private library this project belongs to. Null
  // only on rows created before the multi-user build; the admin's
  // account claims those legacy rows on first sight (they are his
  // library from the single-user era).
  ownerAccountId: integer("owner_account_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per live stream / scheduled premiere the user asked the app
// to keep an eye on (the "Directos seguidos" list). La Casa de Alofoke 3
// premieres as a scheduled YouTube live long before it starts, so the
// app registers it while it is still "upcoming" and a periodic check
// (checkLiveEvents) flips it to "live" when the broadcast begins.
export const liveEvents = sqliteTable("live_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Per-account like projects: each user's «Directos seguidos» list is
  // their own (the video_id index is no longer unique).
  videoId: text("video_id").notNull(),
  // The account following this stream; null only on legacy rows.
  ownerAccountId: integer("owner_account_id"),
  title: text("title").notNull(),
  creator: text("creator").notNull(),
  // "live" | "upcoming" | "ended" | "unknown" — last classified state.
  status: text("status").notNull().default("unknown"),
  // Human detail for the state, e.g. "Empieza en 14 días".
  detail: text("detail").notNull().default(""),
  // Wall-clock instant the app first saw this stream actually live;
  // used as the (approximate) stream-start anchor for clip times when
  // the stream's DASH manifest does not publish its start time.
  firstLiveAt: integer("first_live_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const clips = sqliteTable("clips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
  score: integer("score").notNull().default(0),
  reason: text("reason").notNull().default(""),
  excerpt: text("excerpt").notNull().default(""),
  subtitlesText: text("subtitles_text").notNull().default(""),
  // Blob key of the rendered vertical MP4 (9:16) for this clip, once the
  // user has asked for the direct download; null until then.
  videoKey: text("video_key"),
  // Burned-subtitle style version the stored MP4 was rendered with. When
  // the style changes, renders below the current version are dropped and
  // re-cut on the next download request.
  styleVersion: integer("style_version").notNull().default(0),
  // TikTok-ready post text for this clip: a suggested title/caption and
  // its hashtags, generated by AI on demand (generateTikTokCaption) and
  // editable by the user. Empty until generated; the API falls back to a
  // deterministic suggestion built from the clip itself.
  tiktokTitle: text("tiktok_title").notNull().default(""),
  tiktokHashtags: text("tiktok_hashtags").notNull().default(""),
  used: integer("used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
