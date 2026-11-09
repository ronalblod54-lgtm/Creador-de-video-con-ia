# Data Plan

## Context provenance
- `Y oye lo que tú harás créame como una web con ese sistema de creación de clip con IA.` (verbatim build request: a NEW web carrying the same AI clip-creation system as the existing «Ronal Clip» app, slug `samuelclip`, in this same workspace)
- `pon en otro apartado la cosa de sacar clip de los en vivo y substitulo que quiero utilizar como en la imágenes que te mandé` (prior user statement: live-stream clipping must live in its OWN separate section/apartado, and clips must carry the burned TikTok-style subtitles shown in the TalentClip screenshots the user sent)
- `que cuando ponga el link lo lea rápido sin tener que darme error` (prior user statement: pasting a link — including live links — must read fast and must not dead-end in the old «no tiene subtítulos» / «YouTube está limitando» errors)
- `También facilítame y automatizado para lo clip porfa solo yo tenga que descargarlo y ya.` (prior user statement: the flow must be automated end to end; the user's only job is downloading the finished clips)
- Prior build findings carried in the parent conversation: Alofoke live streams carry NO caption track (verified again below), so live moments are detected from the live chat exploding; finished live broadcasts become replays whose full frame can be cut; La Casa de Alofoke 3 premieres 2026-11-23 on the Alofoke Radio Show channel (UCvDvBAOuJIHKWK59duvM0JQ).
- TalentClip screenshots (user-sent images in the parent conversation): dark editor UI, «Todos los clips» library grid of vertical 9:16 thumbnails with burned word-by-word captions (white uppercase, keyword in yellow), per-clip score badges — the visual reference for the library and caption style.

## Tested sources
### YouTube oEmbed (fast link identity)
**Used by**: analyzeVideo, resolveLiveTarget — first, fast read of any pasted link (title, channel) before any heavier fetch, so the UI confirms what the link is within ~1 s.
**Test command**: `curl -s 'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=ydSzm84vJrs&format=json'`
**Sample output**: `{"title":"EL TRIO AMOROSO Y DE AMISTAD DEL SEÑOR JIMENEZ QUE INVOLUCRA A PAMELA INFANTE Y KARLA ALVAREZ","author_name":"Alofokeradioshow", ...}` — the exact live link from the user's error screenshot resolves fine.
**Processing**: parse video id from any YouTube URL shape (watch, youtu.be, /live/, /shorts/); oEmbed gives instant title/channel; classification (normal video vs live vs upcoming vs ended) comes from Invidious fields below.

### Invidious public API (metadata, captions, stream formats)
**Used by**: analyzeVideo (captions WebVTT + duration), prepareClipDownload / live rendering (adaptiveFormats stream URLs resolved by the privileged ffmpeg worker), resolveLiveTarget / checkLiveEvents (liveNow / isUpcoming classification).
**Test command**: `curl -s 'https://yt.chocolatemoo53.com/api/v1/videos/ydSzm84vJrs'`
**Sample output**: HTTP 200, 72 KB JSON: title as above, `liveNow: False`, `isUpcoming: False`, `captions: []` (confirms Alofoke broadcasts have no caption track), `adaptiveFormats: 22` entries.
**Processing**: instances tried in order [`yt.chocolatemoo53.com`, `inv.nadeko.net`]; Spanish caption track preferred, then any Spanish, then English; rolling-window auto-captions de-duplicated into clean cues stored on the project row so re-scoring never refetches.

### YouTube live chat (live moment detection)
**Used by**: startLiveWatch / pollLiveWatch / makeLiveClips in the En vivo apartado.
**Test command**: mechanism proven in the existing `samuelclip` build on this same host (chat polling buckets messages in 10 s windows; spikes = moments). No Alofoke stream is live tonight (premiere is 2026-11-23), so a live-chat probe cannot return real messages today — recorded honestly as untestable until a real broadcast.
**Processing**: while a followed stream is live, a server listener counts chat messages per 10 s bucket; «Sacar clips» turns the biggest explosions into clips scored by spike size, titled from the words the chat repeated most; burned captions for live clips are built from the chat's real messages in that window (never invented dialogue). MP4 cutting is enabled once the broadcast ends and exists as a replay.

### Server-side inference (ctx.inference)
**Used by**: analyzeVideo scoring (best moments, viral score, titles), generateTikTokCaption.
**Processing**: transcript chunked (≤4 × 15 000 chars); model returns candidate moments with start/end/score/reason validated against the real cue times — moments can only land where actual words were said.

### ffmpeg render pipeline (privileged worker)
**Used by**: prepareClipDownload for both apartados.
**Test command**: `ffmpeg -version` → 8.1.2 on this host; pipeline architecture (detached worker, DASH-segment download in retried chunks, chunked MP4 hand-back) is the one already proven in production in `samuelclip` on this host and is ported, not reinvented.
**Processing**: vertical 1080×1920 MP4, x264 medium / crf 18, AAC 192k; split layout (creator facecam band on top, content below) for regular videos, full-frame-over-blurred-cover layout for live shows; captions burned with libass as an ASS document — white uppercase bold, black outline, keyword word highlighted yellow, TalentClip style.

## Multi-user accounts (edit 2026-11-09)
- `La quiero así que cada usuario tenga su biblioteca aparte y funcione 100%. Cada cuenta tendra su espacio aparte pero yo seré admin y tendré el control de todas.` (verbatim edit request)
- **Identity source**: the platform's verified viewer (`ctx.viewer` from `@hatch/space-sdk`): `local:<userId>` inside Muse, `cf:<tokenId>` on a shared web link. No passwords are collected by the app; the account is created automatically on first sight, keyed by `accounts.viewer_key`.
- **Roles**: `viewer.isOwner` (the artifact's owner, Ronal) is promoted to `admin` automatically; everyone else is a `member`. Only admin actions (`listAccountsAdmin`, `adminListLibrary`, `adminSetAccountStatus`, `adminClearLibrary`) can cross account boundaries, and they re-check the role server-side on every call.
- **Isolation**: `projects.owner_account_id` and `live_events.owner_account_id` scope every read/write; clip actions verify the clip's project owner (owner or admin). The old global `UNIQUE(video_id)` constraints were dropped in migration `0008` (table rebuild for projects, index drop for live_events) so two accounts can each keep their own project for the same video. Live-chat watch files on disk are per-account (`watch-<accountId>-<videoId>`).
- **Legacy data**: rows with `owner_account_id IS NULL` (the single-user era) are claimed by the admin account the first time it appears — verified in the sandbox: the pre-existing live event and library landed on Ronal's admin account, not on any other.
- **Blocked accounts**: an admin can block a member; blocked accounts get empty library reads and a refusal (`BLOCKED_ERROR`) from every mutating action, while their data stays stored and returns intact on reactivation. The admin cannot block himself or another admin.
- **Known limit of the identity source**: on a public web share link, the platform identifies the share token, not a named person — everyone opening the app with their own Muse account gets a fully separate space, which is the primary route; a shared link's token shares one space.

## First-load account race fix (edit 2026-11-09, user: «Pues no veo que nada cambio en verdad»)
- **Evidence**: the pre-dispatch inspection capture of a fresh viewer identity showed three HTTP 500s on `/actions`, a missing «Mi espacio» region, and the library stuck on «No pude cargar la biblioteca». Later captures with the same identity passed clean — the failure only happens on a viewer's FIRST load, which is exactly the multi-user first-open every new account hits.
- **Root cause**: on first load the client fires `getMySpace` + `listLibrary` (+ `listLiveEvents`) in parallel, and every action calls `ensureAccount`, which did select-then-plain-insert. Two racing first requests both saw no account row and both inserted; the loser died on the `accounts.viewer_key` UNIQUE constraint → 500. The shared query client only auto-retries pre-invocation failures, never a handler 500, so the dead screen never healed by itself.
- **Fix**: `ensureAccount` now inserts with `onConflictDoNothing({ target: viewerKey })` and re-reads the row the winning request created; the first-load queries (`listLibrary`, `getMySpace`, `listLiveEvents`) carry explicit retries with backoff; a failed account load shows a visible error card with «Reintentar» instead of silently hiding the account card; and the «Mi espacio» card now renders FIRST, above the install/permission cards, so the per-account change (and the admin's panel button) is the first thing seen on open instead of sitting below two tall cards on a phone.

## Login system (edit 2026-11-09, user: «mañana quiere ver un login / inicio de sesión para cada usuario… cada usuario entra con su cuenta (usuario y contraseña, o correo y contraseña) y llega a su propio espacio/biblioteca aparte. Ronal sigue siendo el admin»)
- **Gate**: the exported `App` renders ONLY the login screen («Iniciar sesión» / «Crear cuenta») when the browser holds no session token — the main app's queries do not even fire. With a token, `getSession` validates it server-side before `MainApp` mounts; a dead/expired token is dropped and the login screen returns with a notice. Signing in or out clears the whole query cache so one account's library never bleeds into the next account's screen on a shared phone.
- **Credentials**: `accounts.login_name` (normalized trim+lowercase username OR email, unique when set) + `accounts.password_hash` as `saltHex:hashHex`, PBKDF2-SHA256 via WebCrypto, 120 000 iterations, per-account random salt — never plaintext, never logged. Passwords are chosen by each user in the app's own form (minimum 6 characters); nobody else picks or sees them.
- **Sessions**: `sessions` table (migration `0009`) stores only the SHA-256 hash of a 32-byte random token, 30-day expiry; the raw token lives in the browser's localStorage and the client injects it as `auth` into every action call (see `client/src/api.ts`). `resolveAccount(ctx, args)` is the single resolution door: a valid session token wins; without one, the platform-identity path (`ensureAccount`) resolves exactly as before, which keeps the scheduled `checkLiveEvents` cron (global, no account resolution) and the owner's agent calls working untouched.
- **Owner attach**: when the platform owner (Ronal, `viewer.isOwner`) registers from his own browser, the credentials attach to his EXISTING admin account (same row: his library, followed live events and admin panel), instead of creating a new member account. Any other visitor registering gets a fresh member account (`viewer_key = cred:<login>`) with an empty library. Blocked accounts cannot sign in (`BLOCKED_ERROR`); the admin panel lists login accounts like any other and can block/clear them.
- **Kept honest**: the login gates the web UI. Server calls that carry no session (the artifact's own scheduler/agent) still resolve by platform identity — that is what keeps the automatic live checks running; the per-account isolation of every library read/write is unchanged and now keyed by the signed-in account when a session exists.

## Long-term data behavior
- **Refresh policy**: followed live events re-classified by a scheduled `checkLiveEvents` run every 30 min (space_action cron owned by this artifact) plus an on-open check; rendered MP4s are cached as blobs and re-cut automatically only when the caption style version changes.
- **Growth**: one project row per analyzed video/stream, clips beneath it; transcripts stored once per project; deleting a project/clip removes its stored MP4 blobs (no orphan files).
- **Ordering**: library lists newest projects first; clips inside a project by score desc; live clips grid by score desc.
- **Time semantics**: clip times are second offsets into the source video (event-relative, no timezone); live-event «starts in N days» detail is computed from the scheduled start in the viewer's timezone (America/Santo_Domingo).

## Rejected approaches
- **Tried**: `inv.nadeko.net` as an Invidious instance.
  **Why rejected**: probe returned `Endpoint disabled` for the videos API; kept only as a last-resort fallback behind chocolatemoo53, which returned full data.
- **Tried**: reading live streams through the normal subtitle pipeline.
  **Why rejected**: Alofoke broadcasts return `captions: []` (probed above, and the cause of the errors in the user's screenshots); live detection must come from the chat, and live links must route to the En vivo apartado instead of erroring.
- **Tried**: inventing burned subtitles for live clips from nothing.
  **Why rejected**: no caption track and no audio transcription exist for these streams; live captions are built only from real chat messages captured during the moment.
