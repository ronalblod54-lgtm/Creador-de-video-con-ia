// Actions for SamuelClip — a YouTube clip finder.
//
// Flow: the user pastes a YouTube video (or live) URL -> we read the video's
// subtitles through the Piped API (the plain YouTube watch page is blocked
// from this network), an AI editor picks the strongest moments with a viral
// score, and each clip is saved with its exact start/end seconds, a YouTube
// deep link and copy-ready subtitle text for cutting in CapCut. A channel
// URL resolves through the channel page + its RSS feed to the recent
// videos, and the user picks one to analyze.
//
// Everything is original code written for this web version; no license or
// activation exists anywhere in the app.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

// ---------------------------------------------------------------- utilities

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type Cue = { s: number; e: number; t: string };

function fmtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "es,en;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al leer ${url}`);
  return res.text();
}

type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "channel"; url: string }
  | null;

function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return { kind: "video", videoId: input };
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: "video", videoId: id } : null;
  }
  if (host !== "youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }
  const path = url.pathname;
  const watchId = url.searchParams.get("v");
  if (path === "/watch" && watchId && /^[A-Za-z0-9_-]{11}$/.test(watchId)) {
    return { kind: "video", videoId: watchId };
  }
  const seg = path.split("/").filter(Boolean);
  const first = seg[0] ?? "";
  const second = seg[1] ?? "";
  if (
    (first === "shorts" || first === "live" || first === "embed" || first === "v") &&
    /^[A-Za-z0-9_-]{11}$/.test(second)
  ) {
    return { kind: "video", videoId: second };
  }
  if (first.startsWith("@") || first === "channel" || first === "c" || first === "user") {
    return { kind: "channel", url: `https://www.youtube.com${path}` };
  }
  return null;
}

// ------------------------------------------------------- channel resolution

const channelVideo = z.object({
  videoId: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  url: z.string(),
});

async function resolveChannelVideos(channelUrl: string) {
  const html = await fetchText(channelUrl, 25000);
  const channelId =
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ??
    html.match(/channel_id=(UC[A-Za-z0-9_-]{22})/)?.[1] ??
    html.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1];
  if (!channelId) {
    throw new Error("No pude encontrar ese canal. Revisa el link e inténtalo de nuevo.");
  }
  const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  const channelName = ogTitle ? decodeEntities(ogTitle) : "Canal de YouTube";
  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    20000,
  );
  const videos: z.infer<typeof channelVideo>[] = [];
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = entry[1] ?? "";
    const videoId = block.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/)?.[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1] ?? "";
    if (videoId && title) {
      videos.push({
        videoId,
        title: decodeEntities(title.trim()),
        publishedAt: published,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }
    if (videos.length >= 15) break;
  }
  if (videos.length === 0) {
    throw new Error("Ese canal no muestra videos recientes que pueda leer.");
  }
  return { channelName, videos };
}

// ------------------------------------------------------------ video reading

type PipedSubtitle = {
  url?: string;
  code?: string;
  name?: string;
  autoGenerated?: boolean;
};

type VideoData = {
  title: string;
  creator: string;
  durationSec: number;
  cues: Cue[];
  lang: string;
};

async function fetchOembed(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string };
    if (!j.title) return null;
    return { title: j.title, author: j.author_name ?? "" };
  } catch {
    return null;
  }
}

function parseTtmlTime(value: string): number | null {
  const v = value.trim();
  if (v.endsWith("ms")) {
    const n = Number.parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n / 1000 : null;
  }
  if (v.endsWith("s") && !v.includes(":")) {
    const n = Number.parseFloat(v.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const parts = v.split(":").map((p) => Number.parseFloat(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseTtml(xml: string): Cue[] {
  const cues: Cue[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = m[1] ?? "";
    const begin = attrs.match(/begin="([^"]+)"/)?.[1];
    const end = attrs.match(/end="([^"]+)"/)?.[1];
    if (!begin || !end) continue;
    const s = parseTtmlTime(begin);
    const e = parseTtmlTime(end);
    if (s == null || e == null || e <= s) continue;
    const rawText = (m[2] ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "");
    const text = decodeEntities(rawText).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const prev = cues[cues.length - 1];
    if (prev && prev.t.toLowerCase() === text.toLowerCase()) continue;
    cues.push({ s, e, t: text });
  }
  return cues;
}

function pickSubtitle(subs: PipedSubtitle[]): PipedSubtitle | null {
  const usable = subs.filter((s) => typeof s.url === "string" && s.url.length > 0);
  if (usable.length === 0) return null;
  const langOf = (s: PipedSubtitle) => (s.code ?? "").toLowerCase();
  const isEs = (s: PipedSubtitle) => langOf(s).startsWith("es");
  const isEn = (s: PipedSubtitle) => langOf(s).startsWith("en");
  return (
    usable.find((s) => isEs(s) && !s.autoGenerated) ??
    usable.find((s) => isEs(s)) ??
    usable.find((s) => isEn(s) && !s.autoGenerated) ??
    usable.find((s) => isEn(s)) ??
    usable.find((s) => !s.autoGenerated) ??
    usable[0] ??
    null
  );
}

// WebVTT from Invidious. YouTube auto-captions come as a rolling window:
// each cue repeats the previous line and appends the new one, so we keep
// only the new suffix of each cue to rebuild clean segments.
function parseVttTime(value: string): number | null {
  const parts = value.trim().split(":").map((p) => Number.parseFloat(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx < 0) continue;
    const timing = lines[timingIdx] ?? "";
    const [rawStart = "", rawEnd = ""] = timing.split("-->").map((p) => p.trim().split(/\s+/)[0] ?? "");
    const s = parseVttTime(rawStart);
    const e = parseVttTime(rawEnd);
    if (s == null || e == null || e <= s) continue;
    const rawText = lines
      .slice(timingIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "");
    const text = decodeEntities(rawText).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const prev = cues[cues.length - 1];
    if (prev) {
      if (text === prev.t) continue;
      if (text.startsWith(prev.t)) {
        const suffix = text.slice(prev.t.length).trim();
        if (!suffix) continue;
        cues.push({ s, e, t: suffix });
        continue;
      }
    }
    cues.push({ s, e, t: text });
  }
  return cues;
}

type InvidiousCaption = {
  label?: string;
  languageCode?: string;
  language_code?: string;
  url?: string;
};

// Invidious instances used only as a fallback when Piped cannot read the
// video (YouTube bot-blocks some videos for the Piped instance's IP while
// others still answer). yt.chocolatemoo53.com verified 2026-11-08: metadata
// + full WebVTT caption content for the exact video Piped refused.
const INVIDIOUS_INSTANCES = ["https://yt.chocolatemoo53.com", "https://inv.nadeko.net"];

function pickInvidiousCaption(caps: InvidiousCaption[]): InvidiousCaption | null {
  const usable = caps.filter((c) => typeof c.url === "string" && c.url.length > 0);
  if (usable.length === 0) return null;
  const langOf = (c: InvidiousCaption) => (c.languageCode ?? c.language_code ?? "").toLowerCase();
  const isAuto = (c: InvidiousCaption) => (c.label ?? "").toLowerCase().includes("auto");
  const isEs = (c: InvidiousCaption) => langOf(c).startsWith("es");
  const isEn = (c: InvidiousCaption) => langOf(c).startsWith("en");
  return (
    usable.find((c) => isEs(c) && !isAuto(c)) ??
    usable.find((c) => isEs(c)) ??
    usable.find((c) => isEn(c) && !isAuto(c)) ??
    usable.find((c) => isEn(c)) ??
    usable.find((c) => !isAuto(c)) ??
    usable[0] ??
    null
  );
}

type FetchOutcome =
  | { status: "ok"; data: VideoData }
  | { status: "no-subtitles" }
  | { status: "unreachable" };

async function fetchFromInvidious(base: string, videoId: string): Promise<FetchOutcome> {
  type VideosJson = {
    title?: string;
    author?: string;
    lengthSeconds?: number;
    captions?: InvidiousCaption[];
  };
  let info: VideosJson;
  try {
    const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { status: "unreachable" };
    info = (await res.json()) as VideosJson;
  } catch {
    return { status: "unreachable" };
  }
  const caption = pickInvidiousCaption(info.captions ?? []);
  if (!caption?.url) return { status: "no-subtitles" };
  let vtt: string;
  try {
    vtt = await fetchText(new URL(caption.url, base).toString(), 25000);
  } catch {
    return { status: "unreachable" };
  }
  const cues = parseVtt(vtt);
  if (cues.length < 4) return { status: "no-subtitles" };
  const lastCue = cues[cues.length - 1];
  return {
    status: "ok",
    data: {
      title: info.title || "Video de YouTube",
      creator: info.author || "Canal de YouTube",
      durationSec:
        info.lengthSeconds && info.lengthSeconds > 0 ? info.lengthSeconds : (lastCue?.e ?? 0),
      cues,
      lang: caption.languageCode ?? caption.language_code ?? "",
    },
  };
}

async function fetchFromPiped(videoId: string): Promise<FetchOutcome> {
  type StreamsJson = {
    title?: string;
    uploader?: string;
    duration?: number;
    subtitles?: PipedSubtitle[];
  };
  let streams: StreamsJson | null = null;
  for (let attempt = 0; attempt < 2 && !streams; attempt++) {
    try {
      const res = await fetch(`https://api.piped.private.coffee/streams/${videoId}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      streams = (await res.json()) as StreamsJson;
    } catch {
      streams = null;
    }
  }
  if (!streams) return { status: "unreachable" };
  const subtitle = pickSubtitle(streams.subtitles ?? []);
  if (!subtitle?.url) return { status: "no-subtitles" };
  let cues: Cue[];
  try {
    const ttml = await fetchText(subtitle.url, 25000);
    cues = parseTtml(ttml);
  } catch {
    return { status: "unreachable" };
  }
  if (cues.length < 4) return { status: "no-subtitles" };
  let title = streams.title ?? "";
  let creator = streams.uploader ?? "";
  if (!title || !creator) {
    const oe = await fetchOembed(videoId);
    if (oe) {
      title = title || oe.title;
      creator = creator || oe.author;
    }
  }
  const lastCue = cues[cues.length - 1];
  const durationSec = streams.duration && streams.duration > 0 ? streams.duration : (lastCue?.e ?? 0);
  return {
    status: "ok",
    data: {
      title: title || "Video de YouTube",
      creator: creator || "Canal de YouTube",
      durationSec,
      cues,
      lang: subtitle.code ?? "",
    },
  };
}

async function fetchVideoData(videoId: string): Promise<VideoData> {
  // Primary: Piped. YouTube intermittently bot-blocks the Piped instance's
  // IP per video ("Sign in to confirm you're not a bot", HTTP 500), so fall
  // back to Invidious instances before giving up.
  let sawNoSubtitles = false;
  const piped = await fetchFromPiped(videoId);
  if (piped.status === "ok") return piped.data;
  if (piped.status === "no-subtitles") sawNoSubtitles = true;
  for (const base of INVIDIOUS_INSTANCES) {
    const inv = await fetchFromInvidious(base, videoId);
    if (inv.status === "ok") return inv.data;
    if (inv.status === "no-subtitles") sawNoSubtitles = true;
  }
  if (sawNoSubtitles) {
    throw new Error(
      "Este video no tiene subtítulos que pueda leer, y sin subtítulos no puedo detectar los mejores momentos. Prueba con otro video. Si es un EN VIVO o su repetición, ábrelo en la pestaña «🔴 En vivo»: ahí la app trabaja con el chat del directo y no con subtítulos.",
    );
  }
  // Before the generic "YouTube is limiting us" message, check whether
  // this is actually a live stream or a scheduled premiere — the two
  // links in the user's 2026-11-09 screenshots failed with exactly
  // that misleading message when one was a live with no captions yet
  // and the other was the La Casa de Alofoke 3 premiere, still 14 days
  // out. Both have their own honest explanation and their own section.
  const live = await classifyLiveVideo(videoId).catch(() => null);
  if (live?.status === "upcoming") {
    throw new Error(
      `Este link es un en vivo programado que todavía no empieza (${live.detail.toLowerCase()}). No hay nada que recortar todavía: déjalo registrado en la pestaña «🔴 En vivo · La Casa» y la app te lo marca EN VIVO cuando empiece, para sacarle los clips del chat en directo.`,
    );
  }
  if (live?.status === "live") {
    throw new Error(
      "Este video está EN VIVO ahora mismo, y mientras transmite YouTube no expone sus subtítulos a la app. Para sacarle clips usa la pestaña «🔴 En vivo · La Casa»: ahí la app escucha el chat del directo y marca los momentos en que el chat explota.",
    );
  }
  throw new Error(
    "YouTube está limitando la lectura automática de este video en este momento y no pude leerlo. Espera unos minutos e inténtalo de nuevo, o prueba con otro video.",
  );
}

// ------------------------------------------------------------ live mode
//
// "Sacar clips de en vivo para La Casa de Alofoke 3" (user, 2026-11-09).
// What the probes established (all 2026-11-09, recorded in DATA-PLAN):
// - La Casa de Alofoke airs on the Alofoke Radio Show channel
//   (UCvDvBAOuJIHKWK59duvM0JQ). Its /live page answers 200 from this
//   network and its canonical URL names the current live — or the
//   next scheduled premiere, which is what it points to right now.
// - The channel's streams carry NO subtitles: six ended replays list
//   zero caption tracks on Invidious, Piped bot-blocks its videos and
//   timedtext answers empty — the normal analysis can never read
//   them, live or replayed. The live mode therefore detects moments
//   from the LIVE CHAT instead: the chat explodes exactly when
//   something happens in the house.
// - The chat is reachable: the video's live_chat popout page gives an
//   Innertube API key + continuation, and get_live_chat answers 200
//   with real messages and rotating continuations.
// - Clip times anchor to the stream's start: the DASH manifest's
//   availabilityStartTime when Invidious publishes one (exact); else
//   the first instant the app itself saw the stream live (stored on
//   the live_events row; the session is flagged approximate and the
//   existing "Corregir tiempos" editor is the safety net).

const ALOFOKE_CHANNEL_ID = "UCvDvBAOuJIHKWK59duvM0JQ";
const ALOFOKE_LIVE_PAGE = `https://www.youtube.com/channel/${ALOFOKE_CHANNEL_ID}/live`;

type LiveStatus = "live" | "upcoming" | "ended" | "unknown";

type LiveInfo = {
  videoId: string;
  title: string;
  creator: string;
  status: LiveStatus;
  detail: string;
  durationSec: number;
};

// Translate Invidious's "will begin in …" phrasing into the app's
// Spanish ("in 14 days" -> "Empieza en 14 días").
function translateBeginWhen(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.includes("few moments") || t.includes("moment")) return "Empieza en unos momentos";
  const m = t.match(/(\d+)\s*(day|hour|minute|week|month|second)/);
  if (m) {
    const n = m[1] ?? "";
    const unit =
      m[2] === "day"
        ? Number(n) === 1
          ? "día"
          : "días"
        : m[2] === "hour"
          ? Number(n) === 1
            ? "hora"
            : "horas"
          : m[2] === "minute"
            ? Number(n) === 1
              ? "minuto"
              : "minutos"
            : m[2] === "week"
              ? Number(n) === 1
                ? "semana"
                : "semanas"
              : m[2] === "month"
                ? Number(n) === 1
                  ? "mes"
                  : "meses"
                : "segundos";
    return `Empieza en ${n} ${unit}`;
  }
  return "Todavía no empieza";
}

async function classifyLiveVideo(videoId: string): Promise<LiveInfo> {
  // Fast read (user, 2026-11-09: «que cuando ponga el link lo lea
  // rápido sin tener que darme error»): oEmbed and Invidious are asked
  // IN PARALLEL with short timeouts, so classifying a pasted link
  // takes seconds, not the old sequential ~30 s worst case — and when
  // a source does not answer, the link still resolves as "unknown"
  // instead of failing.
  const invPromise = (async (): Promise<{ ok: boolean; bodyText: string } | null> => {
    try {
      const res = await fetch(`https://yt.chocolatemoo53.com/api/v1/videos/${videoId}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(9000),
      });
      return { ok: res.ok, bodyText: await res.text() };
    } catch {
      return null;
    }
  })();
  const [oe, inv] = await Promise.all([fetchOembed(videoId), invPromise]);
  // NOTE: for upcoming/live videos YouTube's oEmbed answers 200 with a
  // REDUCED payload (only the embed html — no title/author_name), and
  // Invidious refuses them, so title/creator legitimately come back
  // empty here; callers merge in what other pages gave them and only
  // overwrite stored values with non-empty ones.
  let title = oe?.title ?? "";
  let creator = oe?.author ?? "";
  let status: LiveStatus = "unknown";
  let detail = "";
  let durationSec = 0;
  if (inv?.ok) {
    try {
      const j = JSON.parse(inv.bodyText) as {
        title?: string;
        author?: string;
        lengthSeconds?: number;
        liveNow?: boolean;
        isUpcoming?: boolean;
      };
      title = title || j.title || "";
      creator = creator || j.author || "";
      durationSec = typeof j.lengthSeconds === "number" ? j.lengthSeconds : 0;
      if (j.liveNow) {
        status = "live";
        detail = "Transmitiendo ahora mismo";
      } else if (j.isUpcoming) {
        status = "upcoming";
        detail = "Todavía no empieza";
      } else {
        status = "ended";
        detail = "Este directo ya terminó";
      }
    } catch {
      // Unparseable body: keep oEmbed's data and "unknown".
    }
  } else if (inv) {
    const beginMatch = inv.bodyText.match(/will begin in ([^".]+)/i);
    if (beginMatch?.[1]) {
      status = "upcoming";
      detail = translateBeginWhen(beginMatch[1]);
    }
  }
  return {
    videoId,
    title,
    creator,
    status,
    detail,
    durationSec,
  };
}

// The current live (or next premiere) of a channel, from its /live
// page: the page answers 200 from this network even though watch
// pages 429, its canonical link names the video, and its <title> is
// the video's own title ("<title> - YouTube") — the only title source
// that works for upcoming videos, whose oEmbed payload is reduced.
async function resolveChannelLiveVideoId(
  channelLiveUrl: string,
): Promise<{ videoId: string; pageTitle: string } | null> {
  const html = await fetchText(channelLiveUrl, 15000);
  const canon = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/,
  )?.[1];
  const og = html.match(
    /<meta property="og:url" content="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/,
  )?.[1];
  const videoId = canon ?? og;
  if (!videoId) return null;
  const rawTitle = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
  const pageTitle = decodeEntities(rawTitle.replace(/\s*-\s*YouTube\s*$/, "").trim());
  return { videoId, pageTitle };
}

// Resolve the target of the live mode and register/update it in the
// "Directos seguidos" list. Input empty = the Alofoke preset.
async function resolveLiveTargetInternal(
  ctx: Ctx,
  rawInput: string,
  accountId: number,
): Promise<{ info: LiveInfo; eventId: number }> {
  const input = rawInput.trim();
  let videoId: string | null = null;
  let pageTitle = "";
  let creatorHint = "";
  if (!input) {
    const found = await resolveChannelLiveVideoId(ALOFOKE_LIVE_PAGE);
    if (!found) {
      throw new Error(
        "El canal de Alofoke no muestra un en vivo ni un estreno programado en este momento. Pega el link del directo cuando lo tengas.",
      );
    }
    videoId = found.videoId;
    pageTitle = found.pageTitle;
    // The channel behind the hardcoded preset ID: its name as YouTube
    // itself reports it (Invidious author of its videos + its public
    // channel name) — used only when no source yields a creator.
    creatorHint = "Alofoke Radio Show";
  } else {
    const parsed = parseInput(input);
    if (parsed?.kind === "video") {
      videoId = parsed.videoId;
    } else if (parsed?.kind === "channel") {
      const found = await resolveChannelLiveVideoId(`${parsed.url}/live`);
      if (!found) {
        throw new Error("Ese canal no muestra un en vivo ni un estreno programado ahora mismo.");
      }
      videoId = found.videoId;
      pageTitle = found.pageTitle;
    } else {
      throw new Error(
        "Ese link no parece de YouTube. Pega el link del en vivo (youtube.com/live/…) o el del canal.",
      );
    }
  }
  const classified = await classifyLiveVideo(videoId);
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.liveEvents)
    .where(
      and(
        eq(schema.liveEvents.videoId, videoId),
        eq(schema.liveEvents.ownerAccountId, accountId),
      ),
    )
    .limit(1);
  const row = existing[0];
  const info: LiveInfo = {
    ...classified,
    title: classified.title || pageTitle || row?.title || "Directo de YouTube",
    creator: classified.creator || creatorHint || row?.creator || "Canal de YouTube",
  };
  const now = new Date();
  let eventId: number;
  if (row) {
    eventId = row.id;
    await db
      .update(schema.liveEvents)
      .set({
        title: info.title || row.title,
        creator: info.creator || row.creator,
        status: info.status,
        detail: info.detail,
        firstLiveAt:
          info.status === "live" && !row.firstLiveAt ? now : row.firstLiveAt,
        updatedAt: now,
      })
      .where(eq(schema.liveEvents.id, row.id));
  } else {
    const inserted = await db
      .insert(schema.liveEvents)
      .values({
        videoId,
        ownerAccountId: accountId,
        title: info.title,
        creator: info.creator,
        status: info.status,
        detail: info.detail,
        firstLiveAt: info.status === "live" ? now : null,
      })
      .returning({ id: schema.liveEvents.id });
    const ins = inserted[0];
    if (!ins) throw new Error("No pude registrar ese directo.");
    eventId = ins.id;
  }
  return { info, eventId };
}

// The chat session seed for a video: its live_chat popout page carries
// the Innertube API key, the first continuation and the client
// version (verified 2026-11-09 — the page answers 200 and
// get_live_chat accepts what it gives).
async function resolveChatSession(
  videoId: string,
): Promise<{ apiKey: string; continuation: string; clientVersion: string } | null> {
  let html: string;
  try {
    html = await fetchText(`https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`, 15000);
  } catch {
    return null;
  }
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const continuation =
    html.match(/"reloadContinuationData":\{"continuation":"([^"]+)"/)?.[1] ??
    html.match(/"timedContinuationData":\{"[^}]*"continuation":"([^"]+)"/)?.[1] ??
    html.match(/"continuation":"([^"]{60,})"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? "2.20251101.00.00";
  if (!apiKey || !continuation) return null;
  return { apiKey, continuation, clientVersion };
}

// The stream's start instant, for turning chat timestamps into
// seconds-into-the-stream: the live DASH manifest's
// availabilityStartTime is exact by spec. Invidious refuses
// upcoming/live videos intermittently, so this is best-effort; the
// caller falls back to the app's own first-live sighting.
async function resolveStreamAnchorMs(videoId: string): Promise<number> {
  try {
    const res = await fetch(`https://yt.chocolatemoo53.com/api/v1/videos/${videoId}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return 0;
    const j = (await res.json()) as { dashUrl?: string };
    if (!j.dashUrl) return 0;
    const mpd = await fetchText(new URL(j.dashUrl, "https://yt.chocolatemoo53.com").toString(), 15000);
    const ast = mpd.match(/availabilityStartTime="([^"]+)"/)?.[1];
    if (!ast) return 0;
    const ms = Date.parse(ast);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}

function liveWorkPrefix(ctx: Ctx, videoId: string, accountId: number): string {
  // Per account: two users listening to the same stream never share a
  // chat session on disk (their moments and clips are separate).
  return `${ctx.spaceDir}/.live/watch-${accountId}-${videoId}`;
}

type LiveBucket = { startSec: number; count: number; top: string[]; samples: string[] };

type LiveWindow = {
  start: number;
  end: number;
  peak: number;
  median: number;
  score: number;
  topWords: string[];
  samples: string[];
  // Real chat messages with their second inside the stream, from the
  // hot buckets of this window. Saved on the clip as its caption
  // lines so the MP4 burns the chat's own text in the TikTok caption
  // style (the user asked for the TalentClip-style burned subtitles
  // on live clips too). These are the chat's words at that second —
  // never presented as the show's dialogue, which has no track.
  lines: { at: number; text: string }[];
};

// Turn the listener's 10-second buckets into clip windows: buckets
// whose message count explodes against the session median (>= 2.2x
// and a real floor), merged when adjacent, padded to a watchable
// clip (lead-in before the explosion, tail after it), bounded by the
// user's duration options. Scores are deterministic from the spike
// strength — they measure chat explosion, not dialogue quality, and
// the clip's reason says so with the real numbers.
function liveWindowsFromBuckets(
  buckets: LiveBucket[],
  opts: ClipOptions,
): LiveWindow[] {
  if (buckets.length < 6) return [];
  const counts = buckets.map((b) => b.count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const threshold = Math.max(10, median * 2.2);
  const hot = buckets.filter((b) => b.count >= threshold);
  if (hot.length === 0) return [];
  const groups: LiveBucket[][] = [];
  for (const b of hot) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (g && last && b.startSec - last.startSec <= 20) g.push(b);
    else groups.push([b]);
  }
  const windows: LiveWindow[] = groups.map((g) => {
    const first = g[0];
    const lastB = g[g.length - 1];
    const peak = Math.max(...g.map((b) => b.count));
    const topWords: string[] = [];
    for (const b of g) {
      for (const w of b.top) {
        if (!topWords.includes(w)) topWords.push(w);
        if (topWords.length >= 5) break;
      }
      if (topWords.length >= 5) break;
    }
    const samples: string[] = [];
    for (const b of g) {
      for (const s of b.samples) {
        if (!samples.includes(s)) samples.push(s);
        if (samples.length >= 6) break;
      }
      if (samples.length >= 6) break;
    }
    const lines: { at: number; text: string }[] = [];
    for (const b of g) {
      b.samples.slice(0, 2).forEach((s, i) => {
        lines.push({ at: b.startSec + i * 3, text: s });
      });
    }
    lines.sort((a, b) => a.at - b.at);
    const start = Math.max(0, (first?.startSec ?? 0) - 8);
    let end = (lastB?.startSec ?? 0) + 10 + 12;
    if (end - start < opts.minSec) end = start + opts.minSec;
    if (end - start > opts.maxSec) end = start + opts.maxSec;
    const ratio = median > 0 ? peak / median : peak / 5;
    const score = Math.max(55, Math.min(99, Math.round(56 + 13 * Math.max(0, ratio - 1))));
    return { start, end, peak, median, score, topWords, samples, lines };
  });
  return windows.sort((a, b) => b.score - a.score);
}

const liveTitlesSchema = z.object({
  titles: z.array(z.object({ index: z.number(), title: z.string() })).max(10),
});



function slugifyTitle(title: string): string {
  const clean = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "clip";
}

// ------------------------------------------------------- TikTok post text

// TikTok gives third-party apps no silent background posting: its
// Content Posting API requires the creator's own OAuth connection and
// an audited developer app, and this artifact has no TikTok connector.
// So the publish flow is: the app writes the post text (title +
// hashtags) and cuts the MP4, then hands both to TikTok in one tap via
// the phone's share sheet (or TikTok's own upload page on desktop).
// The title comes from the clip (or an AI rewrite on demand); the
// hashtags are the fixed set below on every clip.

// Fixed hashtag set for every clip's TikTok post (user, 2026-11-08:
// «que arregle los # y le ponga esto #rdjavi #viral #fyp #gta5 #clipviral
// solo eso 5 # en todos»). Exactly these five, in this order, on all
// clips — no per-clip, AI-generated or user-edited tags anywhere.
const FIXED_TIKTOK_HASHTAGS = "#rdjavi #viral #fyp #gta5 #clipviral";

// Hashtag set for LIVE projects (La Casa de Alofoke): the fixed RDjavi
// set would be wrong on a reality-show clip (#gta5!), so live projects
// carry their own five, in the same fixed-set spirit — the user asked
// for the live mode "para la casa de alofoke 3" specifically.
const LIVE_TIKTOK_HASHTAGS = "#lacasadealofoke #alofoke #viral #fyp #clipviral";

function hashtagsForKind(sourceKind: string | null | undefined): string {
  return sourceKind === "live" ? LIVE_TIKTOK_HASHTAGS : FIXED_TIKTOK_HASHTAGS;
}

function tiktokPostText(title: string, hashtags: string): string {
  return hashtags.trim() ? `${title.trim()}\n\n${hashtags.trim()}` : title.trim();
}

// Version of the burned-in subtitle style (see buildClipAss). Stored on
// each clip with its rendered MP4; a render below this version is stale
// and gets re-cut with the current style on the next download request.
// v3 (2026-11-08): the exact style of the user's reference TikTok —
// v2 was plain bold white SRT captions, which the user rejected.
// v4 (2026-11-08): same style, ~1/3 smaller type (cap height ~2.5% of
// the frame height) and the MP4 rendered in HD 1080x1920 instead of
// 720x1280 — the user said the v3 captions looked too big and asked
// for more quality / HD.
// v5 (2026-11-08): same captions, new framing — the user asked to pull
// the video back a little ("aleja el video un poco más") while keeping
// 9:16 and not losing quality: the render worker now composes a wider
// 4:5 foreground over a blurred 9:16 cover of itself instead of the
// tight center crop (see privileged.ts). Renders below v5 are stale
// and re-cut with the pulled-back framing on the next download.
// v6 (2026-11-08): same captions and framing, plus the creator's face
// (the channel avatar — RDjavi's cartoon face) burned in as a small
// circular overlay in the top-right corner of every clip, as the user
// asked («que salga en un ladito... que salga la cara de él, no tan
// grande»). Renders below v6 are stale and re-cut with the overlay.
// v7 (2026-11-08): the user rejected the v6 pasted image («la faltó
// la cara y no hablo de la imagen que pusiste») and sent the format he
// actually wants (TikTok https://www.tiktok.com/t/ZTPFrhFSb/, an
// RDjavi clip by @perezclips21): «rdjavi arriba y el video abajo con
// mucha calidad». The render is now a split screen — the creator's
// real facecam, cropped out of the source frame's top-left corner
// (his videos carry it there as a framed box) and enlarged across
// the top 1080x810 of the frame, with the game in the 1080x1110
// below — cut from the 1080p source at crf 21 for quality, and no
// pasted avatar image anywhere. Renders below v7 are stale and
// re-cut with the split layout on the next download request.
// v8 (2026-11-08): the user liked the v7 split but asked to refine
// it — «poner la cámara centrada y más grande que este en 30%. Y que
// no se vea lo que está en el fondo, también quiero que los
// subtitulos lo baje más para abajo para que no se tapen los
// movimientos». The camera band grows ~30% (1080x1054) with a ~30%
// tighter crop centered on his face (measured on real frames), so
// he fills the band and his room behind him is cropped out; the
// game crop starts right of the facecam box so the box never peeks
// into the game band; and the captions drop from a ~72% base to
// ~88% (MarginV 230) so they stop covering the action. Renders
// below v8 are stale and re-cut with the new layout on the next
// download request.
// v9 (2026-11-08): the user reversed the v8 enlargement — «la cara
// de rdjavi sale demasiado grande y solo la quiero arriba no tan
// para abajo en verdad, ponla más para arriba y pequeña solo que
// salga su cara». The camera band shrinks from 1080x1054 (~55% of
// the frame) to 1080x600 (only the top ~31%) and the facecam crop
// opens up around his face (iw*0.22 x iw*0.1222 centered on his
// measured face position), so his face renders small — ~370x290 px
// on screen instead of ~450x630 — with just his face showing; the
// game band grows to 1080x1320 below. Captions unchanged (base
// still ~88%). Renders below v9 are stale and re-cut with the new
// layout on the next download request.
// v10 (2026-11-09): quality + full-review pass at the user's
// request («ponla ready para mañana, revisa todo bien que no haya
// errores en ningún lado y ponle más calidad a los video que aún le
// falta»). Same v9 layout and captions; the render worker now
// encodes libx264 preset medium at crf 18 (was veryfast/crf 21),
// AAC 192k (was 160k), pins yuv420p, and adds a gentle unsharp to
// the heavily upscaled facecam band — and it now prefers the
// Spanish audio track when the DASH manifest carries several
// languages (before, the highest-bandwidth track won, which could
// be a dub in the wrong language). Size caps rose to match the
// bigger files. Renders below v10 are stale and re-cut with the
// higher quality on the next download request.
const SUBTITLE_STYLE_VERSION = 10;

// Spanish function words that never carry the yellow keyword highlight.
const KEYWORD_STOPWORDS = new Set([
  "EL", "LA", "LOS", "LAS", "UN", "UNA", "UNOS", "UNAS", "DE", "DEL", "EN",
  "Y", "O", "A", "QUE", "SE", "SU", "SUS", "AL", "LO", "CON", "POR", "PARA",
  "ESTO", "ESTA", "ESTE", "ESO", "ESA", "ESE", "COMO", "CUANDO", "DONDE",
  "MUY", "MAS", "MÁS", "TAMBIEN", "TAMBIÉN", "PORQUE", "ENTONCES", "BUENO",
  "VAMOS", "ESTA", "ESTÁN", "ESTOY", "ERES", "SOMOS",
]);

// Build the clip's captions as an ASS document (times rebased to 0) in the
// exact style of the user's reference TikTok
// (https://www.tiktok.com/t/ZTPNpxXTt/): ALL CAPS in a black-weight
// sans-serif (Noto Sans Black, ~900), pure white with ONE keyword per
// phrase in vivid yellow (#FFD400), a thick uniform black outline with a
// soft drop shadow, no background box, one single line centered near
// the bottom of the frame (text base at ~88% of the frame height since
// v8 — it sat at ~72% through v7, and the user asked to lower it so the
// captions stop covering the movements), and short phrases
// of 2-3 words that appear whole with hard cuts — never word by word.
// An empty string means the clip has no caption lines to burn.
function buildClipAss(
  subtitlesText: string,
  startSec: number,
  endSec: number,
  marginV: number = 230,
): string {
  const parseLabel = (label: string): number | null => {
    const parts = label.split(":").map((p) => Number(p));
    if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };
  const assStamp = (sec: number): string => {
    const totalCs = Math.max(0, Math.round(sec * 100));
    const cs = totalCs % 100;
    const total = Math.floor(totalCs / 100);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${Math.floor(total / 3600)}:${p2(Math.floor(total / 60) % 60)}:${p2(total % 60)}.${String(cs).padStart(2, "0")}`;
  };
  const cues = subtitlesText
    .split("\n")
    .map((line) => {
      const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (!m) return null;
      const at = parseLabel(m[1] ?? "");
      const text = (m[2] ?? "").trim();
      return at != null && text ? { at, text } : null;
    })
    .filter((x): x is { at: number; text: string } => x !== null);
  if (cues.length === 0) return "";

  // Word timeline: each stored cue covers until the next cue starts (the
  // last one until the clip ends); its span is shared between its words
  // in proportion to their length, like speech pacing.
  type Word = { text: string; start: number; end: number };
  const words: Word[] = [];
  cues.forEach((cue, i) => {
    const cueEnd = i + 1 < cues.length ? (cues[i + 1]?.at ?? endSec) : endSec;
    const span = Math.max(0.3, cueEnd - cue.at);
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const totalChars = parts.reduce((acc, w) => acc + w.length + 1, 0) || 1;
    let t = cue.at;
    for (const w of parts) {
      const share = ((w.length + 1) / totalChars) * span;
      words.push({ text: w, start: t, end: t + share });
      t += share;
    }
  });
  if (words.length === 0) return "";

  // Group words into short phrases of 2-3 words (the reference never
  // shows more on its single line). A silence longer than a second, a
  // fourth word, or a line that would run too wide starts a new phrase.
  const phrases: Word[][] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length > 0) phrases.push(current);
    current = [];
  };
  for (const w of words) {
    const prev = current[current.length - 1];
    if (prev) {
      const chars =
        current.reduce((acc, x) => acc + x.text.length + 1, 0) + w.text.length;
      if (current.length >= 3 || w.start - prev.end > 1.0 || chars > 19) flush();
    }
    current.push(w);
  }
  flush();
  // A lone trailing word reads better joined to the previous phrase when
  // that phrase still has room and there was no real pause.
  const lastPhrase = phrases[phrases.length - 1];
  const prevPhrase = phrases[phrases.length - 2];
  if (lastPhrase && prevPhrase && lastPhrase.length === 1 && prevPhrase.length < 3) {
    const lone = lastPhrase[0];
    const tail = prevPhrase[prevPhrase.length - 1];
    if (lone && tail && lone.start - tail.end <= 1.0) {
      prevPhrase.push(lone);
      phrases.pop();
    }
  }

  const YELLOW = "&H00D4FF&"; // #FFD400 in ASS BGR byte order
  const WHITE = "&HFFFFFF&";
  const cleanWord = (w: string) =>
    w.toLocaleUpperCase("es").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

  const events = phrases
    .map((phrase, i) => {
      const first = phrase[0];
      const last = phrase[phrase.length - 1];
      if (!first || !last) return null;
      const start = Math.max(0, first.start - startSec);
      const next = phrases[i + 1]?.[0];
      const nextStart = next ? Math.max(0, next.start - startSec) : endSec - startSec;
      if (nextStart <= start) return null;
      // The phrase stays up until the next one cuts in (hard cut, no
      // fade), with a short minimum on screen.
      const end = Math.min(
        Math.max(last.end - startSec, start + 0.55),
        Math.max(nextStart, start + 0.3),
      );
      // The keyword is the strongest content word of the phrase: the
      // longest word that is not a function word (ties go to the later
      // word). Single-word phrases stay white, like the reference.
      let hi = -1;
      let best = 0;
      if (phrase.length > 1) {
        phrase.forEach((w, wi) => {
          const letters = w.text.toLocaleUpperCase("es").replace(/[^A-ZÁÉÍÓÚÜÑ]/g, "");
          if (letters.length < 4 || KEYWORD_STOPWORDS.has(letters)) return;
          if (letters.length >= best) {
            best = letters.length;
            hi = wi;
          }
        });
      }
      const text = phrase
        .map((w, wi) => {
          const t = cleanWord(w.text);
          return wi === hi ? `{\\c${YELLOW}}${t}{\\c${WHITE}}` : t;
        })
        .join(" ");
      return `Dialogue: 0,${assStamp(start)},${assStamp(end)},Default,,0,0,0,,${text}`;
    })
    .filter((x): x is string => x !== null);
  if (events.length === 0) return "";

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Noto Sans Black (weight 900), FontSize 75 at 1080x1920 ≈ 2.5% cap
    // height — about a third smaller than the v3 style (FontSize 80 at
    // 720x1280 ≈ 4% cap height, which the user found too big). Outline 7
    // keeps the same thick black border relative to the smaller type.
    // MarginV 230 puts the text base at ~88% of the frame height —
    // lowered in v8 from 518 (~72%, mid game band, where the captions
    // covered the characters) at the user's request, so the line now
    // sits low in the game band, over the ground instead of the action.
    // (The full-frame "full" layout passes marginV 518 instead: its
    // picture band is centered, so the ~72% base of the old v5 framing
    // is what lands on the picture there.)
    `Style: Default,Noto Sans Black,75,&HFFFFFF,&HFFFFFF,&H000000,&H50000000,-1,0,0,0,100,100,0,0,1,7,2,2,24,24,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ------------------------------------------------------------- AI clip pick

const candidatesSchema = z.object({
  clips: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        title: z.string(),
        score: z.number(),
        reason: z.string(),
      }),
    )
    .max(12),
});

type Candidate = z.infer<typeof candidatesSchema>["clips"][number];

type ClipOptions = {
  minSec: number;
  maxSec: number;
  minScore: number;
  clipCount: number;
};

const MAX_CHUNKS = 4;
const CHUNK_CHARS = 15000;

async function inferChunk(
  ctx: Ctx,
  videoTitle: string,
  chunkText: string,
  chunkFrom: number,
  chunkTo: number,
  opts: ClipOptions,
  want: number,
): Promise<Candidate[]> {
  const prompt = [
    "Eres el editor de clips virales de SamuelClip. Tu trabajo: encontrar los momentos de un video que, cortados tal cual, funcionarían como clips cortos de TikTok/Reels.",
    "",
    `Video: «${videoTitle}»`,
    `Ventana de la transcripción: del segundo ${Math.round(chunkFrom)} al ${Math.round(chunkTo)}.`,
    `Cada clip debe durar entre ${opts.minSec} y ${opts.maxSec} segundos. Devuelve hasta ${want} clips, solo los que de verdad valgan la pena.`,
    "",
    "Qué hace grande a un clip (puntúa con eso en mente, escala 0 a 100, entera):",
    "- Gancho en los primeros 3 segundos: una frase que detenga el scroll.",
    "- Emoción, sorpresa, risa, enojo o una revelación; un mini-arco con principio y cierre.",
    "- Una frase memorable o quotable que la gente quiera compartir.",
    "- 90 o más = potencial viral casi seguro; 70-89 = muy bueno; 50-69 = decente; menos de 50 = relleno, no lo devuelvas si no aporta.",
    "",
    "Reglas:",
    "- «start» es el segundo exacto donde empieza la frase del gancho (usa las marcas [segundo] de la transcripción) y «end» donde el momento cierra natural; no cortes a mitad de frase.",
    "- Los clips no deben solaparse entre sí.",
    "- «title»: título gancho en español, estilo TikTok, máximo 70 caracteres, sin hashtags.",
    "- «reason»: una frase breve en español explicando por qué funciona.",
    "- Si la transcripción está en otro idioma, el título y la razón van en español igual.",
    "",
    "Transcripción (marca = segundo de inicio de cada línea):",
    chunkText,
  ].join("\n");
  const out = await ctx.inference.complete(prompt, {
    schema: candidatesSchema,
    timeout_secs: 240,
  });
  return out.clips;
}

function snapAndShape(
  cand: Candidate,
  cues: Cue[],
  durationSec: number,
  opts: ClipOptions,
): Candidate | null {
  let start = Math.max(0, Math.min(cand.start, durationSec));
  let end = Math.max(0, Math.min(cand.end, durationSec));
  if (end <= start) return null;
  // Snap to cue boundaries so the cut never lands mid-sentence.
  const startCue = cues.find((c) => c.e > start);
  if (startCue && startCue.s <= start + 2) start = startCue.s;
  const endCues = cues.filter((c) => c.s < end);
  const lastEndCue = endCues[endCues.length - 1];
  if (lastEndCue && lastEndCue.e >= end - 2) end = lastEndCue.e;
  // Enforce duration window.
  if (end - start > opts.maxSec) {
    const target = start + opts.maxSec;
    const inside = cues.filter((c) => c.s < target && c.e <= target + 1.5);
    const lastInside = inside[inside.length - 1];
    end = lastInside && lastInside.e - start >= opts.minSec ? lastInside.e : target;
  }
  if (end - start < opts.minSec && durationSec >= opts.minSec) {
    const target = Math.min(durationSec, start + opts.minSec);
    const reach = cues.filter((c) => c.e <= target + 4 && c.e > end);
    const lastReach = reach[reach.length - 1];
    end = lastReach ? Math.max(end, lastReach.e) : target;
  }
  if (end - start < 5) return null;
  if (end > durationSec) end = durationSec;
  return {
    start,
    end,
    title: cand.title.trim().slice(0, 90) || "Momento destacado",
    score: Math.max(0, Math.min(100, Math.round(cand.score))),
    reason: cand.reason.trim().slice(0, 300),
  };
}

function overlapRatio(a: Candidate, b: Candidate): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
}

type SavedClip = {
  title: string;
  startSec: number;
  endSec: number;
  score: number;
  reason: string;
  excerpt: string;
  subtitlesText: string;
};

function materialize(cand: Candidate, cues: Cue[]): SavedClip {
  const inside = cues.filter((c) => c.e > cand.start && c.s < cand.end);
  const excerpt = inside
    .map((c) => c.t)
    .join(" ")
    .slice(0, 420);
  const subtitlesText = inside
    .slice(0, 60)
    .map((c) => `[${fmtTime(c.s)}] ${c.t}`)
    .join("\n");
  return {
    title: cand.title,
    startSec: cand.start,
    endSec: cand.end,
    score: cand.score,
    reason: cand.reason,
    excerpt,
    subtitlesText,
  };
}

async function pickClips(
  ctx: Ctx,
  videoTitle: string,
  cues: Cue[],
  durationSec: number,
  opts: ClipOptions,
): Promise<{ clips: SavedClip[]; note: string | null }> {
  const lines = cues.map((c) => `[${c.s.toFixed(1)}] ${c.t}`);
  const fullText = lines.join("\n");
  const chunks: { text: string; from: number; to: number }[] = [];
  if (fullText.length <= CHUNK_CHARS) {
    chunks.push({ text: fullText, from: cues[0]?.s ?? 0, to: durationSec });
  } else {
    let current: string[] = [];
    let currentLen = 0;
    let currentFrom = cues[0]?.s ?? 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (currentLen + line.length > CHUNK_CHARS && current.length > 0) {
        const lastCue = cues[i - 1];
        chunks.push({ text: current.join("\n"), from: currentFrom, to: lastCue?.e ?? durationSec });
        current = [];
        currentLen = 0;
        currentFrom = cues[i]?.s ?? 0;
        if (chunks.length >= MAX_CHUNKS) break;
      }
      current.push(line);
      currentLen += line.length + 1;
    }
    if (current.length > 0 && chunks.length < MAX_CHUNKS) {
      chunks.push({ text: current.join("\n"), from: currentFrom, to: durationSec });
    }
  }

  const raw: Candidate[] = [];
  for (const chunk of chunks) {
    try {
      const found = await inferChunk(
        ctx,
        videoTitle,
        chunk.text,
        chunk.from,
        chunk.to,
        opts,
        chunks.length === 1 ? opts.clipCount : 4,
      );
      raw.push(...found);
    } catch {
      // A failed chunk should not sink the whole analysis; the others count.
    }
  }

  const shaped = raw
    .map((c) => snapAndShape(c, cues, durationSec, opts))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.score - a.score);

  const deduped: Candidate[] = [];
  for (const cand of shaped) {
    if (deduped.some((kept) => overlapRatio(kept, cand) > 0.4)) continue;
    deduped.push(cand);
  }

  const passing = deduped.filter((c) => c.score >= opts.minScore);
  const note =
    deduped.length > 0 && passing.length === 0
      ? `Encontré ${deduped.length} momento(s), pero ninguno llegó al puntaje mínimo de ${opts.minScore}. Baja el puntaje mínimo y pulsa «Reanalizar».`
      : deduped.length === 0
        ? "La IA no encontró momentos con fuerza suficiente en este video. Prueba bajando el puntaje mínimo o con otro video."
        : null;
  return { clips: passing.slice(0, opts.clipCount).map((c) => materialize(c, cues)), note };
}

// ------------------------------------------------------------------ schemas

const optionsShape = {
  minSec: z.number().int().min(10).max(300).default(30),
  maxSec: z.number().int().min(15).max(600).default(90),
  minScore: z.number().int().min(0).max(100).default(0),
  clipCount: z.number().int().min(1).max(10).default(5),
};

// Carried on EVERY action request: the login session token (see the
// login system in the accounts section). The client injects it
// automatically from localStorage after signing in; a valid token
// makes the action resolve the caller's account from the login.
// Calls without one (the scheduled live check, the owner's agent)
// resolve from the platform identity exactly as before.
const authShape = {
  auth: z.string().max(200).optional(),
};

// Shared response for registerAccount / loginAccount.
const authResultShape = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  token: z.string().nullable(),
  displayName: z.string(),
  isAdmin: z.boolean(),
});

const clipShape = z.object({
  id: z.number(),
  title: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  startLabel: z.string(),
  endLabel: z.string(),
  durationLabel: z.string(),
  score: z.number(),
  reason: z.string(),
  excerpt: z.string(),
  subtitlesText: z.string(),
  used: z.boolean(),
  hasVideo: z.boolean(),
  // Direct URL of the stored rendered MP4 (null until the clip has been
  // cut with the current subtitle style). The client plays it in a
  // native <video> element and offers it through a real download link:
  // the YouTube embed and programmatic JS downloads both fail silently
  // inside some phone webviews, which is how the user ended up unable
  // to watch or save a clip the server had already cut.
  videoUrl: z.string().nullable(),
  watchUrl: z.string(),
  tiktokTitle: z.string(),
  tiktokHashtags: z.string(),
  tiktokText: z.string(),
  hasTikTokCaption: z.boolean(),
});

const projectShape = z.object({
  id: z.number(),
  videoId: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  creator: z.string(),
  durationSec: z.number(),
  durationLabel: z.string(),
  thumbnailUrl: z.string().nullable(),
  isLive: z.boolean(),
  createdAt: z.string(),
  clips: z.array(clipShape),
});

type ClipRow = typeof schema.clips.$inferSelect;

function clipToApi(
  row: ClipRow,
  videoId: string,
  videoUrl: string | null,
  sourceKind: string = "video",
): z.infer<typeof clipShape> {
  const start = Math.floor(row.startSec);
  const storedTitle = (row.tiktokTitle ?? "").trim();
  const tiktokTitle = storedTitle || row.title;
  // Hashtags are a fixed set per project kind (see FIXED_TIKTOK_HASHTAGS
  // and LIVE_TIKTOK_HASHTAGS); whatever an older build stored on the
  // row no longer applies.
  const tiktokHashtags = hashtagsForKind(sourceKind);
  return {
    id: row.id,
    title: row.title,
    startSec: row.startSec,
    endSec: row.endSec,
    startLabel: fmtTime(row.startSec),
    endLabel: fmtTime(row.endSec),
    durationLabel: fmtTime(row.endSec - row.startSec),
    score: row.score,
    reason: row.reason,
    excerpt: row.excerpt,
    subtitlesText: row.subtitlesText,
    used: row.used === 1,
    // True only when the stored MP4 is current (listLibrary passes a
    // null videoUrl for stale-style renders): the client's button must
    // say "Cortar y descargar" — not "Descargar" — when tapping it
    // will actually re-cut the clip first.
    hasVideo: videoUrl != null,
    videoUrl,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}&t=${start}s`,
    tiktokTitle,
    tiktokHashtags,
    tiktokText: tiktokPostText(tiktokTitle, tiktokHashtags),
    hasTikTokCaption: storedTitle.length > 0,
  };
}

async function storeThumbnail(ctx: Ctx, videoId: string): Promise<string | null> {
  const key = `thumb-${videoId}.jpg`;
  try {
    if (await ctx.blobs.head(key)) return key;
    const res = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    await ctx.blobs.put(key, bytes, { contentType: "image/jpeg" });
    return key;
  } catch {
    return null;
  }
}

// (v6's ensureCreatorAvatarUrl — resolving the channel's avatar image
// for the pasted corner circle — was removed in v7: the user rejected
// the pasted image, and the creator's face now comes from the facecam
// cropped out of the source video itself. The projects.avatar_url
// column stays in the schema, unused by the render path.)

async function replaceProjectClips(
  ctx: Ctx,
  projectId: number,
  clips: SavedClip[],
): Promise<void> {
  const db = ctx.db<typeof schema>();
  // The replaced clips' rendered MP4s go with their rows: leaving the
  // blobs behind orphaned one full HD MP4 per replaced clip in
  // storage forever (found in the 2026-11-09 full review).
  const oldClips = await db
    .select({ videoKey: schema.clips.videoKey })
    .from(schema.clips)
    .where(eq(schema.clips.projectId, projectId));
  for (const old of oldClips) {
    if (old.videoKey) {
      try {
        await ctx.blobs.delete(old.videoKey);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  await db.delete(schema.clips).where(eq(schema.clips.projectId, projectId));
  if (clips.length > 0) {
    await db.insert(schema.clips).values(
      clips.map((c) => ({
        projectId,
        title: c.title,
        startSec: c.startSec,
        endSec: c.endSec,
        score: c.score,
        reason: c.reason,
        excerpt: c.excerpt,
        subtitlesText: c.subtitlesText,
        styleVersion: SUBTITLE_STYLE_VERSION,
        used: 0,
      })),
    );
  }
}


// ------------------------------------------------------------- cuentas
//
// Multi-user (user, 2026-11-09: «cada usuario tenga su biblioteca
// aparte… yo seré admin y tendré el control de todas»). Every action
// resolves the caller to an account row keyed by the viewer's
// verified platform identity (ctx.viewer): `local:<userId>` inside
// Muse, `cf:<tokenId>` on a shared web link. The artifact's owner
// (viewer.isOwner) is the admin; everyone else is a member. All
// library reads and writes are filtered by owner_account_id, and
// clip-level actions verify the clip's project belongs to the caller
// (or the caller is the admin, who controls every account).

type AccountRow = typeof schema.accounts.$inferSelect;

const BLOCKED_ERROR =
  "Tu cuenta está bloqueada por el administrador, así que no puedes usar la app por ahora. Habla con el administrador si crees que es un error.";

function viewerInfo(ctx: Ctx): { viewerKey: string; isOwner: boolean } {
  const v = ctx.viewer;
  if (!v) return { viewerKey: "system:owner", isOwner: true };
  if (v.source === "local") return { viewerKey: `local:${v.userId}`, isOwner: v.isOwner };
  return { viewerKey: `cf:${v.tokenId}`, isOwner: v.isOwner };
}

function isBlocked(acc: AccountRow): boolean {
  return acc.status === "blocked" && acc.role !== "admin";
}

function canAccess(acc: AccountRow, ownerAccountId: number | null | undefined): boolean {
  if (acc.role === "admin") return true;
  return ownerAccountId != null && ownerAccountId === acc.id;
}

async function ensureAccount(ctx: Ctx): Promise<AccountRow> {
  const db = ctx.db<typeof schema>();
  const { viewerKey, isOwner } = viewerInfo(ctx);
  const now = new Date();
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.viewerKey, viewerKey))
    .limit(1);
  let acc = rows[0];
  if (!acc) {
    // First sight of this viewer. On first load the client fires
    // getMySpace + listLibrary (+ listLiveEvents) in parallel and
    // EVERY one of them lands here at the same time, so a plain
    // insert races itself: one request creates the account and the
    // others die on the viewer_key UNIQUE constraint with a 500
    // ("No pude cargar la biblioteca", the «Mi espacio» card never
    // renders — the user sees the old page and reports that nothing
    // changed). onConflictDoNothing makes the losers of that race
    // fall through to re-reading the row the winner just created.
    await db
      .insert(schema.accounts)
      .values({
        viewerKey,
        displayName: isOwner ? "Ronal" : "Usuario",
        role: isOwner ? "admin" : "member",
        status: "active",
        lastSeenAt: now,
      })
      .onConflictDoNothing({ target: schema.accounts.viewerKey });
    const after = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.viewerKey, viewerKey))
      .limit(1);
    acc = after[0];
    if (!acc) throw new Error("No pude crear tu cuenta en la app.");
    // Touch the row exactly like the existing-account path below, so
    // a raced-in account still gets its role/lastSeen normalized.
    const role = isOwner ? "admin" : acc.role;
    await db
      .update(schema.accounts)
      .set({ role, lastSeenAt: now })
      .where(eq(schema.accounts.id, acc.id));
    acc = { ...acc, role, lastSeenAt: now };
  } else {
    const role = isOwner ? "admin" : acc.role;
    await db
      .update(schema.accounts)
      .set({ role, lastSeenAt: now })
      .where(eq(schema.accounts.id, acc.id));
    acc = { ...acc, role, lastSeenAt: now };
  }
  if (acc.role === "admin") {
    // The single-user era left rows with no owner, and system calls
    // (schedule/agent) may have created a placeholder admin account:
    // all of that is the admin's own library, so he claims it.
    await db
      .update(schema.projects)
      .set({ ownerAccountId: acc.id })
      .where(isNull(schema.projects.ownerAccountId));
    await db
      .update(schema.liveEvents)
      .set({ ownerAccountId: acc.id })
      .where(isNull(schema.liveEvents.ownerAccountId));
    const placeholders = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.viewerKey, "system:owner"));
    for (const ph of placeholders) {
      if (ph.id === acc.id) continue;
      await db
        .update(schema.projects)
        .set({ ownerAccountId: acc.id })
        .where(eq(schema.projects.ownerAccountId, ph.id));
      await db
        .update(schema.liveEvents)
        .set({ ownerAccountId: acc.id })
        .where(eq(schema.liveEvents.ownerAccountId, ph.id));
      await db.delete(schema.accounts).where(eq(schema.accounts.id, ph.id));
    }
  }
  return acc;
}

// ------------------------------------------------------------- login
//
// Login system (user, 2026-11-09: «un login / inicio de sesión para
// cada usuario… cada usuario entra con su cuenta (usuario y
// contraseña, o correo y contraseña) y llega a su propio
// espacio/biblioteca aparte. Ronal sigue siendo el admin»).
// Passwords are PBKDF2-SHA256 hashes (WebCrypto) with a per-account
// random salt — never stored or logged in plaintext. A successful
// register/login mints a session token; only its SHA-256 hash is
// stored (sessions table, 30-day expiry), and the client sends the
// raw token as `auth` on every action call. resolveAccount is the
// single door every handler uses: a valid session token wins;
// without one, the platform identity resolves the account exactly as
// before (that path keeps the scheduled checkLiveEvents cron and the
// owner's in-Muse use working untouched).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    key,
    256,
  );
  return `${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 120_000, hash: "SHA-256" },
    key,
    256,
  );
  const candidate = bytesToHex(new Uint8Array(bits));
  let diff = candidate.length ^ hashHex.length;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ (hashHex.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function normalizeLogin(raw: string): string {
  return raw.trim().toLowerCase();
}

async function createSession(ctx: Ctx, accountId: number): Promise<string> {
  const db = ctx.db<typeof schema>();
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  await db.insert(schema.sessions).values({
    accountId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

async function accountForSessionToken(ctx: Ctx, token: string): Promise<AccountRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, await sha256Hex(token)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
    return null;
  }
  const accs = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, session.accountId))
    .limit(1);
  return accs[0] ?? null;
}

async function resolveAccount(ctx: Ctx, args: { auth?: string }): Promise<AccountRow> {
  const token = args.auth?.trim();
  if (token) {
    const acc = await accountForSessionToken(ctx, token);
    if (acc) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db
        .update(schema.accounts)
        .set({ lastSeenAt: now })
        .where(eq(schema.accounts.id, acc.id));
      return { ...acc, lastSeenAt: now };
    }
    throw new Error(
      "Tu sesión venció o no es válida. Vuelve a iniciar sesión para entrar a tu espacio.",
    );
  }
  return ensureAccount(ctx);
}

async function projectOwnerId(ctx: Ctx, projectId: number): Promise<number | null | undefined> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ ownerAccountId: schema.projects.ownerAccountId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows[0]?.ownerAccountId;
}

async function clipProjectOwnerId(ctx: Ctx, clipId: number): Promise<number | null | undefined> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ projectId: schema.clips.projectId })
    .from(schema.clips)
    .where(eq(schema.clips.id, clipId))
    .limit(1);
  const clip = rows[0];
  if (!clip) return undefined;
  return projectOwnerId(ctx, clip.projectId);
}

// The library payload for ONE account's space — used by listLibrary
// (the caller's own) and by adminListLibrary (the admin viewing any
// account), so both always render the exact same shape.
async function buildLibrary(ctx: Ctx, ownerAccountId: number) {
  const db = ctx.db<typeof schema>();
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.ownerAccountId, ownerAccountId))
    .orderBy(desc(schema.projects.createdAt));
  const clipRows = await db
    .select()
    .from(schema.clips)
    .orderBy(desc(schema.clips.score), asc(schema.clips.startSec));
  const projectIds = new Set(projectRows.map((p) => p.id));
  const clipsByProject = new Map<number, ClipRow[]>();
  for (const row of clipRows) {
    if (!projectIds.has(row.projectId)) continue;
    const list = clipsByProject.get(row.projectId) ?? [];
    list.push(row);
    clipsByProject.set(row.projectId, list);
  }
  const byCreator = new Map<string, z.infer<typeof projectShape>[]>();
  for (const p of projectRows) {
    const thumbnailUrl = p.thumbnailKey ? await ctx.blobs.getUrl(p.thumbnailKey) : null;
    const apiClips: z.infer<typeof clipShape>[] = [];
    for (const c of clipsByProject.get(p.id) ?? []) {
      const freshVideo =
        typeof c.videoKey === "string" &&
        c.videoKey.length > 0 &&
        c.styleVersion >= SUBTITLE_STYLE_VERSION;
      const videoUrl = freshVideo ? await ctx.blobs.getUrl(c.videoKey as string) : null;
      apiClips.push(clipToApi(c, p.videoId, videoUrl, p.sourceKind));
    }
    const apiProject: z.infer<typeof projectShape> = {
      id: p.id,
      videoId: p.videoId,
      sourceUrl: p.sourceUrl,
      title: p.title,
      creator: p.creator,
      durationSec: p.durationSec,
      durationLabel: fmtTime(p.durationSec),
      thumbnailUrl,
      isLive: p.sourceKind === "live",
      createdAt: p.createdAt.toISOString(),
      clips: apiClips,
    };
    const list = byCreator.get(p.creator) ?? [];
    list.push(apiProject);
    byCreator.set(p.creator, list);
  }
  return {
    creators: [...byCreator.entries()].map(([creator, projects]) => ({ creator, projects })),
  };
}

async function accountCounts(
  ctx: Ctx,
  accountId: number,
): Promise<{ projectsCount: number; clipsCount: number; liveEventsCount: number }> {
  const db = ctx.db<typeof schema>();
  const projectRows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.ownerAccountId, accountId));
  const ids = new Set(projectRows.map((r) => r.id));
  const clipRows = await db.select({ projectId: schema.clips.projectId }).from(schema.clips);
  const liveRows = await db
    .select({ id: schema.liveEvents.id })
    .from(schema.liveEvents)
    .where(eq(schema.liveEvents.ownerAccountId, accountId));
  return {
    projectsCount: projectRows.length,
    clipsCount: clipRows.filter((c) => ids.has(c.projectId)).length,
    liveEventsCount: liveRows.length,
  };
}

// ------------------------------------------------------------------ actions

export const Actions = {
  resolveChannel: defineAction({
    description:
      "Resuelve el link de un canal de YouTube a su nombre y sus videos más recientes, para elegir cuál analizar.",
    request: z.object({ ...authShape, url: z.string().min(5).max(500) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      channelName: z.string(),
      videos: z.array(channelVideo),
    }),
    async handler(_ctx, args) {
      const parsed = parseInput(args.url);
      if (!parsed || parsed.kind !== "channel") {
        return {
          ok: false,
          error: "Ese link no parece de un canal de YouTube. Pega el link del canal, por ejemplo youtube.com/@canal.",
          channelName: "",
          videos: [],
        };
      }
      try {
        const { channelName, videos } = await resolveChannelVideos(parsed.url);
        return { ok: true, error: null, channelName, videos };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "No pude leer ese canal.",
          channelName: "",
          videos: [],
        };
      }
    },
  }),

  analyzeVideo: defineAction({
    description:
      "Analiza un video de YouTube (link o ID): lee sus subtítulos, detecta los mejores momentos con puntaje viral y los guarda como clips listos para cortar.",
    request: z.object({ ...authShape, input: z.string().min(5).max(500), ...optionsShape }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      projectId: z.number().nullable(),
      title: z.string(),
      creator: z.string(),
      clipsFound: z.number(),
      note: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const parsed = parseInput(args.input);
      if (!parsed || parsed.kind !== "video") {
        return {
          ok: false,
          error:
            "Ese link no parece de un video de YouTube. Pega el link del video (o el del canal para elegir uno de sus videos).",
          projectId: null,
          title: "",
          creator: "",
          clipsFound: 0,
          note: null,
        };
      }
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return {
          ok: false,
          error: BLOCKED_ERROR,
          projectId: null,
          title: "",
          creator: "",
          clipsFound: 0,
          note: null,
        };
      }
      const opts: ClipOptions = {
        minSec: Math.min(args.minSec, args.maxSec),
        maxSec: Math.max(args.minSec, args.maxSec),
        minScore: args.minScore,
        clipCount: args.clipCount,
      };
      try {
        ctx.emit({ step: "leyendo", label: "Leyendo el video y sus subtítulos…" });
        const data = await fetchVideoData(parsed.videoId);
        ctx.emit({ step: "analizando", label: "La IA está buscando los mejores momentos…" });
        const { clips: found, note } = await pickClips(
          ctx,
          data.title,
          data.cues,
          data.durationSec,
          opts,
        );
        ctx.emit({ step: "guardando", label: "Guardando tus clips en la biblioteca…" });
        const thumbnailKey = await storeThumbnail(ctx, parsed.videoId);
        const db = ctx.db<typeof schema>();
        const existing = await db
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.videoId, parsed.videoId),
              eq(schema.projects.ownerAccountId, acc.id),
            ),
          )
          .limit(1);
        let projectId: number;
        const existingRow = existing[0];
        if (existingRow) {
          projectId = existingRow.id;
          await db
            .update(schema.projects)
            .set({
              title: data.title,
              creator: data.creator,
              durationSec: data.durationSec,
              thumbnailKey: thumbnailKey ?? existingRow.thumbnailKey,
              transcriptLang: data.lang,
              transcriptJson: JSON.stringify(data.cues),
            })
            .where(eq(schema.projects.id, projectId));
        } else {
          const inserted = await db
            .insert(schema.projects)
            .values({
              videoId: parsed.videoId,
              ownerAccountId: acc.id,
              sourceUrl: `https://www.youtube.com/watch?v=${parsed.videoId}`,
              title: data.title,
              creator: data.creator,
              durationSec: data.durationSec,
              thumbnailKey,
              transcriptLang: data.lang,
              transcriptJson: JSON.stringify(data.cues),
            })
            .returning({ id: schema.projects.id });
          const row = inserted[0];
          if (!row) throw new Error("No pude guardar el proyecto.");
          projectId = row.id;
        }
        await replaceProjectClips(ctx, projectId, found);
        ctx.invalidateQueries();
        return {
          ok: true,
          error: null,
          projectId,
          title: data.title,
          creator: data.creator,
          clipsFound: found.length,
          note,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Algo falló analizando el video.",
          projectId: null,
          title: "",
          creator: "",
          clipsFound: 0,
          note: null,
        };
      }
    },
  }),

  reanalyzeProject: defineAction({
    description:
      "Vuelve a puntuar los momentos de un video ya analizado con otras opciones (duración/puntaje/cantidad), sin volver a descargar los subtítulos.",
    request: z.object({ ...authShape, projectId: z.number().int().positive(), ...optionsShape }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      clipsFound: z.number(),
      note: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return { ok: false, error: BLOCKED_ERROR, clipsFound: 0, note: null };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.projectId))
        .limit(1);
      const project = rows[0];
      if (!project || !canAccess(acc, project.ownerAccountId)) {
        return { ok: false, error: "Ese proyecto ya no existe.", clipsFound: 0, note: null };
      }
      const opts: ClipOptions = {
        minSec: Math.min(args.minSec, args.maxSec),
        maxSec: Math.max(args.minSec, args.maxSec),
        minScore: args.minScore,
        clipCount: args.clipCount,
      };
      let cues: Cue[] = [];
      try {
        cues = JSON.parse(project.transcriptJson) as Cue[];
      } catch {
        cues = [];
      }
      if (cues.length < 4) {
        return {
          ok: false,
          error: "No quedó guardada la transcripción de este video. Analízalo de nuevo desde el link.",
          clipsFound: 0,
          note: null,
        };
      }
      const { clips: found, note } = await pickClips(
        ctx,
        project.title,
        cues,
        project.durationSec,
        opts,
      );
      await replaceProjectClips(ctx, project.id, found);
      ctx.invalidateQueries();
      return { ok: true, error: null, clipsFound: found.length, note };
    },
  }),

  listLibrary: defineAction({
    description:
      "Lista la biblioteca DEL USUARIO QUE LLAMA: solo los videos de su propia cuenta, agrupados por creador, cada uno con sus clips y puntajes. Ninguna cuenta ve la biblioteca de otra; el admin ve las demás solo desde su panel.",
    request: z.object({ ...authShape }),
    response: z.object({
      creators: z.array(
        z.object({
          creator: z.string(),
          projects: z.array(projectShape),
        }),
      ),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { creators: [] };
      return buildLibrary(ctx, acc.id);
    },
  }),

  prepareClipDownload: defineAction({
    description:
      "Deja el clip como MP4 vertical 9:16 HD (1080x1920) en formato dividido: la cámara real del creador (la que su video ya trae en la esquina superior izquierda) ampliada arriba y el juego debajo, con los subtítulos quemados, listo para descargar directo al dispositivo. Render de máxima calidad (x264 medium/crf 18, AAC 192k). El corte con ffmpeg corre en segundo plano en el servidor (cada llamada es corta): la primera llamada lo arranca y devuelve rendering=true, las siguientes preguntan y, cuando el MP4 está listo, lo guardan y devuelven la URL de descarga; las próximas veces sale al instante desde lo guardado.",
    request: z.object({ ...authShape, clipId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      downloadUrl: z.string().nullable(),
      fileName: z.string(),
      cached: z.boolean(),
      rendering: z.boolean(),
      progress: z.number(),
    }),
    privileged: [
      privileged.startClipRender,
      privileged.finishClipRender,
      privileged.readClipRenderChunk,
      privileged.discardClipRender,
    ],
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return { ok: false, error: BLOCKED_ERROR, downloadUrl: null, fileName: "", cached: false, rendering: false, progress: 0 };
      }
      const db = ctx.db<typeof schema>();
      const clipRows = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.id, args.clipId))
        .limit(1);
      const foundClip = clipRows[0];
      if (!foundClip || !canAccess(acc, await projectOwnerId(ctx, foundClip.projectId))) {
        return { ok: false, error: "Ese clip ya no existe.", downloadUrl: null, fileName: "", cached: false, rendering: false, progress: 0 };
      }
      let clip = foundClip;
      // A stored MP4 rendered with an older subtitle style is stale: the
      // user rejected the previous style, so drop it and re-cut this clip
      // with the current style instead of serving the old file.
      if (clip.videoKey && clip.styleVersion < SUBTITLE_STYLE_VERSION) {
        try {
          await ctx.blobs.delete(clip.videoKey);
        } catch {
          // Best-effort cleanup; the re-render overwrites the same key.
        }
        await db
          .update(schema.clips)
          .set({ videoKey: null })
          .where(eq(schema.clips.id, clip.id));
        clip = { ...clip, videoKey: null };
      }
      const fileName = `${slugifyTitle(clip.title)}-9x16.mp4`;
      if (clip.videoKey) {
        const url = await ctx.blobs.getUrl(clip.videoKey);
        if (url) return { ok: true, error: null, downloadUrl: url, fileName, cached: true, rendering: false, progress: 100 };
      }
      const durationSec = clip.endSec - clip.startSec;
      if (durationSec > 240) {
        return {
          ok: false,
          error:
            "Este clip dura más de 4 minutos y es demasiado largo para cortarlo aquí. Corrige los tiempos a un pedazo más corto e inténtalo de nuevo.",
          downloadUrl: null,
          fileName,
          cached: false,
          rendering: false,
          progress: 0,
        };
      }
      // The project decides the render layout: live projects (La Casa
      // de Alofoke) render "full" (whole frame over a blurred cover —
      // a reality show has no facecam corner), normal projects render
      // the "split" RDjavi format.
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, clip.projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) {
        return { ok: false, error: "Ese clip ya no existe.", downloadUrl: null, fileName, cached: false, rendering: false, progress: 0 };
      }
      const isLiveProject = project.sourceKind === "live";
      const layout = isLiveProject ? ("full" as const) : ("split" as const);
      if (isLiveProject) {
        // While the broadcast is still on air, YouTube serves no
        // downloadable streams for it: the render worker would only
        // fail after minutes of polling. Say so up front, in the
        // user's terms, and leave the cut for when the stream ends
        // and the video becomes a replay.
        const liveInfo = await classifyLiveVideo(project.videoId).catch(() => null);
        if (liveInfo?.status === "live") {
          return {
            ok: false,
            error:
              "Este directo sigue EN VIVO: YouTube no deja bajar sus pedazos mientras transmite, así que el MP4 se corta cuando el directo termine y el video quede como repetición. Mientras tanto, míralo en su segundo exacto con «Ver el clip aquí» o «Ver en YouTube».",
            downloadUrl: null,
            fileName,
            cached: false,
            rendering: false,
            progress: 0,
          };
        }
      }
      // Deterministic work path per clip + exact times: if the user corrects
      // the times, the path changes and a fresh render starts. The v10 tag
      // separates these renders (v9 split layout and captions, encoded at
      // the v10 quality: x264 medium/crf 18, AAC 192k, sharpened facecam
      // band, Spanish audio preferred) from the v9 ones (veryfast/crf 21).
      // Live ("full" layout) renders get an extra "f" tag so the two
      // layouts never share a work path.
      const workPrefix = `${ctx.spaceDir}/.renders/clip-${clip.id}-${Math.round(clip.startSec * 10)}-${Math.round(clip.endSec * 10)}-v10${layout === "full" ? "f" : ""}`;
      const finished = await ctx.executePrivileged(privileged.finishClipRender, { workPrefix });
      if (finished.state === "done") {
        // Collect the finished MP4 in ~4 MB slices. The old single
        // base64 hand-back was truncated by the daemon transport for
        // long HD clips (the user's 88 s clip), which the phone showed
        // as "La conexión falló preparando el MP4" — and because the
        // render files were deleted before the hand-back, every retry
        // re-rendered from zero and died at the same step. Now the
        // files stay put until the blob is stored, so a failed
        // collection is retried instantly on the next tap.
        const totalBytes = finished.bytes;
        const CHUNK_BYTES = 4 * 1024 * 1024;
        const parts: Uint8Array[] = [];
        let offset = 0;
        let collectFailed = totalBytes <= 0;
        while (!collectFailed && offset < totalBytes) {
          const chunk = await ctx.executePrivileged(privileged.readClipRenderChunk, {
            workPrefix,
            offset,
            length: Math.min(CHUNK_BYTES, totalBytes - offset),
          });
          if (chunk.totalBytes !== totalBytes || chunk.base64.length === 0) {
            collectFailed = true;
            break;
          }
          const bytes = base64ToBytes(chunk.base64);
          if (bytes.byteLength === 0) {
            collectFailed = true;
            break;
          }
          parts.push(bytes);
          offset += bytes.byteLength;
        }
        if (collectFailed || offset !== totalBytes) {
          return {
            ok: false,
            error:
              "El clip ya se cortó, pero falló al guardarlo en la app. Toca el botón otra vez: no hay que cortarlo de nuevo, solo terminar de guardarlo.",
            downloadUrl: null,
            fileName,
            cached: false,
            rendering: false,
            progress: 0,
          };
        }
        const mp4 = new Uint8Array(totalBytes);
        let at = 0;
        for (const part of parts) {
          mp4.set(part, at);
          at += part.byteLength;
        }
        const key = `clip-${clip.id}.mp4`;
        await ctx.blobs.put(key, mp4, { contentType: "video/mp4" });
        await db
          .update(schema.clips)
          .set({ videoKey: key, styleVersion: SUBTITLE_STYLE_VERSION })
          .where(eq(schema.clips.id, clip.id));
        await ctx
          .executePrivileged(privileged.discardClipRender, { workPrefix })
          .catch(() => {});
        ctx.invalidateQueries();
        const url = await ctx.blobs.getUrl(key);
        return { ok: true, error: null, downloadUrl: url, fileName, cached: false, rendering: false, progress: 100 };
      }
      if (finished.state === "working") {
        return { ok: false, error: null, downloadUrl: null, fileName, cached: false, rendering: true, progress: Math.max(1, Math.min(99, Math.round(finished.progress ?? 5))) };
      }
      if (finished.state === "error") {
        return {
          ok: false,
          error: "El corte del clip falló en el servidor. Toca el botón otra vez para reintentarlo.",
          downloadUrl: null,
          fileName,
          cached: false,
          rendering: false,
          progress: 0,
        };
      }
      // state === "none": start a new render. The privileged handler
      // only spawns a detached worker (its own process, whose fetch
      // reaches googlevideo reliably); that worker resolves the
      // streams, downloads only the segments that overlap the clip in
      // small retried chunks, and runs ffmpeg — no step runs inside
      // this request's time budget, so a render can no longer freeze
      // mid-download the way the old in-handler pipeline did.
      // Since v7: no avatar image is resolved or passed anymore — the
      // creator's face in the render is his real facecam, cropped by
      // the worker out of the source video's own top-left corner.
      const started = await ctx.executePrivileged(privileged.startClipRender, {
        videoId: project.videoId,
        startSec: Math.max(0, clip.startSec),
        durationSec,
        workPrefix,
        assContent: buildClipAss(
          clip.subtitlesText,
          clip.startSec,
          clip.endSec,
          layout === "full" ? 518 : 230,
        ),
        layout,
      });
      if (started.state === "error") {
        return {
          ok: false,
          error: "El corte del clip falló en el servidor. Toca el botón otra vez para reintentarlo.",
          downloadUrl: null,
          fileName,
          cached: false,
          rendering: false,
          progress: 0,
        };
      }
      // Just started: the detached worker is resolving the streams
      // (~5-15%); the byte-level download and ffmpeg encoding progress
      // arrive on the following polls.
      return { ok: false, error: null, downloadUrl: null, fileName, cached: false, rendering: true, progress: started.state === "done" ? 95 : 8 };
    },
  }),

  generateTikTokCaption: defineAction({
    description:
      "Genera con IA el título de TikTok para un clip, listo para publicar, y lo guarda en el clip. Los hashtags son siempre los 5 fijos de la app.",
    request: z.object({ ...authShape, clipId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      tiktokTitle: z.string(),
      tiktokHashtags: z.string(),
      tiktokText: z.string(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return { ok: false, error: BLOCKED_ERROR, tiktokTitle: "", tiktokHashtags: "", tiktokText: "" };
      }
      const db = ctx.db<typeof schema>();
      const clipRows = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.id, args.clipId))
        .limit(1);
      const clip = clipRows[0];
      if (!clip || !canAccess(acc, await projectOwnerId(ctx, clip.projectId))) {
        return { ok: false, error: "Ese clip ya no existe.", tiktokTitle: "", tiktokHashtags: "", tiktokText: "" };
      }
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, clip.projectId))
        .limit(1);
      const project = projectRows[0];
      const creator = project?.creator ?? "";
      let tiktokTitle = clip.title;
      try {
        const out = await ctx.inference.complete(
          [
            "Eres el que escribe los textos de publicación de TikTok para clips virales en español.",
            "",
            `Clip: «${clip.title}»`,
            `Video original: «${project?.title ?? ""}» de ${creator || "un canal de YouTube"}.`,
            `Por qué funciona el clip: ${clip.reason}`,
            `Lo que se dice en el clip: «${clip.excerpt.slice(0, 350)}»`,
            "",
            "Escribe el título con el que se publica este clip en TikTok:",
            "- «title»: el título/descripción del post. Gancho fuerte en español, máximo 120 caracteres, puede llevar 1-2 emojis si pegan con el momento, sin hashtags dentro del título (los hashtags son fijos y los pone la app).",
          ].join("\n"),
          {
            schema: z.object({
              title: z.string(),
            }),
            timeout_secs: 120,
          },
        );
        const aiTitle = out.title.trim().slice(0, 160);
        if (aiTitle) tiktokTitle = aiTitle;
      } catch {
        // The clip's own title still gives a usable post.
      }
      const tiktokHashtags = hashtagsForKind(project?.sourceKind);
      await db
        .update(schema.clips)
        .set({ tiktokTitle, tiktokHashtags })
        .where(eq(schema.clips.id, clip.id));
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        tiktokTitle,
        tiktokHashtags,
        tiktokText: tiktokPostText(tiktokTitle, tiktokHashtags),
      };
    },
  }),

  updateTikTokCaption: defineAction({
    description:
      "Guarda el título de TikTok de un clip tal como el usuario lo editó. Los hashtags quedan siempre en los 5 fijos de la app.",
    request: z.object({ ...authShape,
      clipId: z.number().int().positive(),
      tiktokTitle: z.string().min(1).max(220),
      tiktokHashtags: z.string().max(500),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { ok: false, error: BLOCKED_ERROR };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.id, args.clipId))
        .limit(1);
      if (!rows[0]) return { ok: false, error: "Ese clip ya no existe." };
      // Hashtags stay the project's fixed set; only the title is editable.
      const clipRow = rows[0];
      const projRows = await db
        .select({
          sourceKind: schema.projects.sourceKind,
          ownerAccountId: schema.projects.ownerAccountId,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, clipRow.projectId))
        .limit(1);
      if (!canAccess(acc, projRows[0]?.ownerAccountId ?? null)) {
        return { ok: false, error: "Ese clip ya no existe." };
      }
      const tags = hashtagsForKind(projRows[0]?.sourceKind);
      await db
        .update(schema.clips)
        .set({ tiktokTitle: args.tiktokTitle.trim(), tiktokHashtags: tags })
        .where(eq(schema.clips.id, args.clipId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  updateClip: defineAction({
    description:
      "Corrige un clip: cambia su título o ajusta el segundo de inicio y de fin antes de cortarlo.",
    request: z.object({ ...authShape,
      clipId: z.number().int().positive(),
      title: z.string().min(1).max(120).optional(),
      startSec: z.number().min(0).max(86400).optional(),
      endSec: z.number().min(0).max(86400).optional(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { ok: false, error: BLOCKED_ERROR };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.id, args.clipId))
        .limit(1);
      const clip = rows[0];
      if (!clip || !canAccess(acc, await projectOwnerId(ctx, clip.projectId))) {
        return { ok: false, error: "Ese clip ya no existe." };
      }
      const startSec = args.startSec ?? clip.startSec;
      const endSec = args.endSec ?? clip.endSec;
      if (endSec - startSec < 3) {
        return { ok: false, error: "El fin debe quedar al menos 3 segundos después del inicio." };
      }
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, clip.projectId))
        .limit(1);
      const project = projectRows[0];
      if (project && endSec > project.durationSec + 1) {
        return { ok: false, error: "El fin no puede pasar la duración del video." };
      }
      const timesChanged = startSec !== clip.startSec || endSec !== clip.endSec;
      if (timesChanged && clip.videoKey) {
        // The rendered MP4 no longer matches the clip; drop it so the next
        // download re-renders with the corrected times.
        try {
          await ctx.blobs.delete(clip.videoKey);
        } catch {
          // Best-effort cleanup.
        }
      }
      await db
        .update(schema.clips)
        .set({
          title: args.title ? args.title.trim() : clip.title,
          startSec,
          endSec,
          ...(timesChanged ? { videoKey: null } : {}),
        })
        .where(eq(schema.clips.id, clip.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  setClipUsed: defineAction({
    description: "Marca un clip como ya usado (publicado/cortado) o lo desmarca.",
    request: z.object({ ...authShape, clipId: z.number().int().positive(), used: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { ok: false };
      const owner = await clipProjectOwnerId(ctx, args.clipId);
      if (owner === undefined || !canAccess(acc, owner)) return { ok: false };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.clips)
        .set({ used: args.used ? 1 : 0 })
        .where(eq(schema.clips.id, args.clipId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteClip: defineAction({
    description: "Borra un clip de la biblioteca.",
    request: z.object({ ...authShape, clipId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { ok: false };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.id, args.clipId))
        .limit(1);
      const clip = rows[0];
      if (!clip || !canAccess(acc, await projectOwnerId(ctx, clip.projectId))) {
        return { ok: false };
      }
      await db.delete(schema.clips).where(eq(schema.clips.id, args.clipId));
      // Take the rendered MP4 with the row so deleted clips do not
      // leave orphaned video files in storage.
      if (clip?.videoKey) {
        try {
          await ctx.blobs.delete(clip.videoKey);
        } catch {
          // Best-effort cleanup.
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteProject: defineAction({
    description: "Borra un video analizado completo, con todos sus clips.",
    request: z.object({ ...authShape, projectId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { ok: false };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.projectId))
        .limit(1);
      const project = rows[0];
      if (!project || !canAccess(acc, project.ownerAccountId)) return { ok: false };
      // Same orphan cleanup as deleteClip, for every clip of the video.
      const clipRows = await db
        .select({ videoKey: schema.clips.videoKey })
        .from(schema.clips)
        .where(eq(schema.clips.projectId, args.projectId));
      await db.delete(schema.clips).where(eq(schema.clips.projectId, args.projectId));
      await db.delete(schema.projects).where(eq(schema.projects.id, args.projectId));
      for (const c of clipRows) {
        if (c.videoKey) {
          try {
            await ctx.blobs.delete(c.videoKey);
          } catch {
            // Best-effort cleanup.
          }
        }
      }
      if (project?.thumbnailKey) {
        try {
          await ctx.blobs.delete(project.thumbnailKey);
        } catch {
          // Thumbnail cleanup is best-effort.
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  resolveLiveTarget: defineAction({
    description:
      "Resuelve el directo a seguir en el modo en vivo: sin input, el en vivo actual (o el próximo estreno programado) del canal Alofoke Radio Show — La Casa de Alofoke; con input, el link de un directo o de un canal. Lo clasifica (en vivo / programado / terminado) y lo deja registrado en «Directos seguidos».",
    request: z.object({ ...authShape, input: z.string().max(500).default("") }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      videoId: z.string(),
      title: z.string(),
      creator: z.string(),
      status: z.string(),
      detail: z.string(),
      watchUrl: z.string(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return {
          ok: false,
          error: BLOCKED_ERROR,
          videoId: "",
          title: "",
          creator: "",
          status: "unknown",
          detail: "",
          watchUrl: "",
        };
      }
      try {
        const { info } = await resolveLiveTargetInternal(ctx, args.input, acc.id);
        ctx.invalidateQueries();
        return {
          ok: true,
          error: null,
          videoId: info.videoId,
          title: info.title,
          creator: info.creator,
          status: info.status,
          detail: info.detail,
          watchUrl: `https://www.youtube.com/watch?v=${info.videoId}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "No pude resolver ese directo.",
          videoId: "",
          title: "",
          creator: "",
          status: "unknown",
          detail: "",
          watchUrl: "",
        };
      }
    },
  }),

  listLiveEvents: defineAction({
    description:
      "Lista los «Directos seguidos»: cada en vivo o estreno registrado en el modo en vivo, con su estado actual guardado y si ya tiene proyecto de clips.",
    request: z.object({ ...authShape }),
    response: z.object({
      events: z.array(
        z.object({
          id: z.number(),
          videoId: z.string(),
          title: z.string(),
          creator: z.string(),
          status: z.string(),
          detail: z.string(),
          watchUrl: z.string(),
          hasProject: z.boolean(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) return { events: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.liveEvents)
        .where(eq(schema.liveEvents.ownerAccountId, acc.id))
        .orderBy(desc(schema.liveEvents.updatedAt));
      const projectRows = await db
        .select({ videoId: schema.projects.videoId })
        .from(schema.projects)
        .where(eq(schema.projects.ownerAccountId, acc.id));
      const withProject = new Set(projectRows.map((p) => p.videoId));
      return {
        events: rows.map((r) => ({
          id: r.id,
          videoId: r.videoId,
          title: r.title,
          creator: r.creator,
          status: r.status,
          detail: r.detail,
          watchUrl: `https://www.youtube.com/watch?v=${r.videoId}`,
          hasProject: withProject.has(r.videoId),
        })),
      };
    },
  }),

  checkLiveEvents: defineAction({
    description:
      "Revisa el estado de todos los «Directos seguidos» (en vivo / programado / terminado) contra YouTube y actualiza la lista. Es la revisión periódica automática del modo en vivo y también el botón «Revisar ahora».",
    request: z.object({ ...authShape }),
    response: z.object({ ok: z.boolean(), checked: z.number(), liveNow: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.liveEvents).limit(25);
      let liveNow = 0;
      const now = new Date();
      for (const row of rows) {
        const info = await classifyLiveVideo(row.videoId).catch(() => null);
        if (!info) continue;
        if (info.status === "live") liveNow += 1;
        await db
          .update(schema.liveEvents)
          .set({
            title: info.title || row.title,
            creator: info.creator || row.creator,
            status: info.status,
            detail: info.detail,
            firstLiveAt:
              info.status === "live" && !row.firstLiveAt ? now : row.firstLiveAt,
            updatedAt: now,
          })
          .where(eq(schema.liveEvents.id, row.id));
      }
      if (rows.length > 0) ctx.invalidateQueries();
      return { ok: true, checked: rows.length, liveNow };
    },
  }),

  startLiveWatch: defineAction({
    description:
      "Empieza a escuchar el chat de un directo que está EN VIVO: un proceso en segundo plano cuenta los mensajes del chat en vivo en cubos de 10 segundos (cuántos llegan, qué palabras se repiten, ejemplos) para detectar los momentos en que el chat explota. Dura los minutos pedidos y se puede detener antes.",
    request: z.object({ ...authShape,
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
      minutes: z.number().int().min(3).max(60).default(20),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      state: z.string(),
      anchorExact: z.boolean(),
    }),
    privileged: [privileged.startLiveWatch, privileged.readLiveWatch],
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return { ok: false, error: BLOCKED_ERROR, state: "none", anchorExact: false };
      }
      const workPrefix = liveWorkPrefix(ctx, args.videoId, acc.id);
      const current = await ctx
        .executePrivileged(privileged.readLiveWatch, { workPrefix })
        .catch(() => null);
      if (current?.state === "watching") {
        return { ok: true, error: null, state: "watching", anchorExact: current.anchorExact };
      }
      const info = await classifyLiveVideo(args.videoId).catch(() => null);
      if (info?.status === "upcoming") {
        return {
          ok: false,
          error: `Este en vivo todavía no empieza (${info.detail.toLowerCase()}). Cuando esté transmitiendo, vuelve y toca «Escuchar el chat». Ya quedó registrado en «Directos seguidos» y la app lo revisa sola.`,
          state: "none",
          anchorExact: false,
        };
      }
      if (info?.status === "ended") {
        return {
          ok: false,
          error:
            "Este directo ya terminó, así que su chat en vivo ya no corre. Los clips de un directo salen mientras transmite: la próxima vez, abre esta sección con el directo en el aire y toca «Escuchar el chat».",
          state: "none",
          anchorExact: false,
        };
      }
      const session = await resolveChatSession(args.videoId);
      if (!session) {
        return {
          ok: false,
          error:
            "YouTube no me dejó entrar al chat de este directo en este momento. Espera unos minutos e inténtalo de nuevo.",
          state: "none",
          anchorExact: false,
        };
      }
      // Anchor: exact from the DASH manifest when published; else the
      // app's first-live sighting of this stream; else the worker
      // anchors at its own start (flagged approximate either way when
      // not exact).
      let anchorMs = await resolveStreamAnchorMs(args.videoId);
      let anchorExact = anchorMs > 0;
      if (!anchorExact) {
        const db = ctx.db<typeof schema>();
        const rows = await db
          .select()
          .from(schema.liveEvents)
          .where(eq(schema.liveEvents.videoId, args.videoId))
          .limit(1);
        const firstLiveAt = rows[0]?.firstLiveAt;
        if (firstLiveAt) anchorMs = firstLiveAt.getTime();
      }
      const started = await ctx.executePrivileged(privileged.startLiveWatch, {
        videoId: args.videoId,
        workPrefix,
        apiKey: session.apiKey,
        continuation: session.continuation,
        clientVersion: session.clientVersion,
        streamStartEpochMs: anchorMs,
        anchorExact,
        maxMinutes: args.minutes,
      });
      if (started.state === "error") {
        return {
          ok: false,
          error: "El oyente del chat no pudo arrancar. Toca el botón otra vez para reintentarlo.",
          state: "error",
          anchorExact,
        };
      }
      return { ok: true, error: null, state: "watching", anchorExact };
    },
  }),

  pollLiveWatch: defineAction({
    description:
      "Pregunta cómo va la escucha del chat de un directo: cuántos mensajes lleva contados, cuánto tiempo lleva escuchando, si los tiempos son exactos y cuál es, hasta ahora, el momento en que más explotó el chat.",
    request: z.object({ ...authShape, videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) }),
    response: z.object({
      state: z.string(),
      messagesTotal: z.number(),
      elapsedSec: z.number(),
      anchorExact: z.boolean(),
      peakLabel: z.string().nullable(),
      peakCount: z.number(),
      bucketsHeard: z.number(),
    }),
    privileged: [privileged.readLiveWatch],
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      const data = await ctx.executePrivileged(privileged.readLiveWatch, {
        workPrefix: liveWorkPrefix(ctx, args.videoId, acc.id),
      });
      let peak: LiveBucket | null = null;
      for (const b of data.buckets) {
        if (!peak || b.count > peak.count) peak = b;
      }
      return {
        state: data.state,
        messagesTotal: data.messagesTotal,
        elapsedSec: data.elapsedSec,
        anchorExact: data.anchorExact,
        peakLabel: peak ? fmtTime(peak.startSec) : null,
        peakCount: peak?.count ?? 0,
        bucketsHeard: data.buckets.length,
      };
    },
  }),

  stopLiveWatch: defineAction({
    description:
      "Detiene la escucha del chat de un directo; lo ya escuchado queda guardado para sacar los clips.",
    request: z.object({ ...authShape, videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) }),
    response: z.object({ ok: z.boolean() }),
    privileged: [privileged.stopLiveWatch],
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      await ctx.executePrivileged(privileged.stopLiveWatch, {
        workPrefix: liveWorkPrefix(ctx, args.videoId, acc.id),
      });
      return { ok: true };
    },
  }),

  makeLiveClips: defineAction({
    description:
      "Saca los clips de lo escuchado en el chat de un directo: detecta los momentos en que el chat explotó (muchísimos mensajes en 10 segundos frente a la media), les pone título con IA a partir de lo que el chat repetía, y los guarda como un proyecto «del en vivo» en la biblioteca, con el segundo exacto de cada momento. Cada clip guarda además los mensajes reales del chat de su ventana con su segundo, que el corte quema dentro del MP4 como subtítulos estilo TikTok (es el texto del chat, no diálogo: el directo no trae pista de subtítulos). Usa las mismas opciones de duración/puntaje/cantidad del proyecto.",
    request: z.object({ ...authShape,
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
      ...optionsShape,
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      clipsFound: z.number(),
      projectId: z.number().nullable(),
      note: z.string().nullable(),
    }),
    privileged: [privileged.readLiveWatch],
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (isBlocked(acc)) {
        return { ok: false, error: BLOCKED_ERROR, clipsFound: 0, projectId: null, note: null };
      }
      const fail = (error: string) => ({
        ok: false,
        error,
        clipsFound: 0,
        projectId: null,
        note: null as string | null,
      });
      const opts: ClipOptions = {
        minSec: Math.min(args.minSec, args.maxSec),
        maxSec: Math.max(args.minSec, args.maxSec),
        minScore: args.minScore,
        clipCount: args.clipCount,
      };
      const data = await ctx.executePrivileged(privileged.readLiveWatch, {
        workPrefix: liveWorkPrefix(ctx, args.videoId, acc.id),
      });
      if (data.state === "none" || data.buckets.length === 0) {
        return fail(
          "Todavía no hay nada escuchado de este directo. Toca «Escuchar el chat» y déjalo corriendo unos minutos mientras el directo transmite.",
        );
      }
      if (data.messagesTotal < 40) {
        return fail(
          `El chat va muy flojo por ahora (${data.messagesTotal} mensajes contados): todavía no hay un momento que explote. Deja la escucha corriendo y vuelve a intentarlo en unos minutos.`,
        );
      }
      const windows = liveWindowsFromBuckets(data.buckets, opts).filter(
        (w) => w.score >= opts.minScore,
      );
      if (windows.length === 0) {
        return fail(
          "El chat no explotó en ningún momento de lo escuchado (ningún tramo multiplicó la media de mensajes). Sigue escuchando: cuando pase algo en la casa, el chat lo va a gritar.",
        );
      }
      const chosen = windows.slice(0, opts.clipCount);

      // Titles from the chat's own words: the AI gets, per window, the
      // most repeated words and real sample messages, and writes the
      // hook title. If the AI fails, a plain factual title is used —
      // never an invented quote.
      ctx.emit({ step: "titulos", label: "Poniéndole título a los momentos del chat…" });
      const titles = new Map<number, string>();
      try {
        const evidence = chosen
          .map(
            (w, i) =>
              `Momento ${i + 1} (segundo ${Math.round(w.start)} del directo): ${w.peak} mensajes en 10 segundos. Palabras más repetidas del chat: ${w.topWords.join(", ") || "—"}. Mensajes reales del chat: ${w.samples.map((s) => `«${s}»`).join(" · ") || "—"}`,
          )
          .join("\n");
        const out = await ctx.inference.complete(
          [
            "Escribes los títulos de clips de un directo de YouTube (el reality La Casa de Alofoke) a partir de lo que el chat gritó en cada momento. El título debe salir SOLO de la evidencia del chat de ese momento: lo que la gente repetía y escribía. No inventes diálogos ni hechos que el chat no mencione.",
            "",
            evidence,
            "",
            "Para cada momento devuelve su «index» (0 para el Momento 1, 1 para el Momento 2, …) y un «title»: gancho en español estilo TikTok, máximo 70 caracteres, sin hashtags. Si la evidencia es floja, un título simple y honesto sobre la reacción del chat vale más que uno inventado.",
          ].join("\n"),
          { schema: liveTitlesSchema, timeout_secs: 180 },
        );
        for (const t of out.titles) {
          const clean = t.title.trim().slice(0, 90);
          if (clean) titles.set(t.index, clean);
        }
      } catch {
        // Fallback titles below carry the moment without the AI.
      }

      const db = ctx.db<typeof schema>();
      const eventRows = await db
        .select()
        .from(schema.liveEvents)
        .where(
          and(
            eq(schema.liveEvents.videoId, args.videoId),
            eq(schema.liveEvents.ownerAccountId, acc.id),
          ),
        )
        .limit(1);
      const event = eventRows[0];
      const info = event
        ? { title: event.title, creator: event.creator }
        : await classifyLiveVideo(args.videoId).catch(() => null);
      const title = info?.title || "Directo de YouTube";
      const creator = info?.creator || "Canal de YouTube";

      ctx.emit({ step: "guardando", label: "Guardando los clips del en vivo en tu biblioteca…" });
      const thumbnailKey = await storeThumbnail(ctx, args.videoId);
      const lastBucketEnd =
        data.buckets.length > 0
          ? (data.buckets[data.buckets.length - 1]?.startSec ?? 0) + 10
          : 0;
      const maxClipEnd = Math.max(...chosen.map((w) => w.end), lastBucketEnd);
      const existing = await db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.videoId, args.videoId),
            eq(schema.projects.ownerAccountId, acc.id),
          ),
        )
        .limit(1);
      let projectId: number;
      const existingRow = existing[0];
      if (existingRow) {
        projectId = existingRow.id;
        await db
          .update(schema.projects)
          .set({
            title,
            creator,
            sourceKind: "live",
            durationSec: Math.max(existingRow.durationSec, maxClipEnd),
            thumbnailKey: thumbnailKey ?? existingRow.thumbnailKey,
          })
          .where(eq(schema.projects.id, projectId));
      } else {
        const inserted = await db
          .insert(schema.projects)
          .values({
            videoId: args.videoId,
            ownerAccountId: acc.id,
            sourceUrl: `https://www.youtube.com/watch?v=${args.videoId}`,
            title,
            creator,
            durationSec: maxClipEnd,
            thumbnailKey,
            transcriptLang: "",
            transcriptJson: "[]",
            sourceKind: "live",
          })
          .returning({ id: schema.projects.id });
        const rowIns = inserted[0];
        if (!rowIns) return fail("No pude guardar el proyecto del en vivo.");
        projectId = rowIns.id;
      }

      // Append, deduping against the clips this project already has
      // (an earlier listening session may have caught the same moment).
      const existingClips = await db
        .select()
        .from(schema.clips)
        .where(eq(schema.clips.projectId, projectId));
      const fresh: SavedClip[] = [];
      for (const [i, w] of chosen.entries()) {
        const cand: Candidate = {
          start: w.start,
          end: w.end,
          title: titles.get(i) ?? `El chat explotó: ${w.topWords.slice(0, 2).join(" y ") || "momento candente"}`,
          score: w.score,
          reason: "",
        };
        if (existingClips.some((c) => overlapRatio({ start: c.startSec, end: c.endSec, title: "", score: 0, reason: "" }, cand) > 0.4)) {
          continue;
        }
        if (fresh.some((f) => overlapRatio({ start: f.startSec, end: f.endSec, title: "", score: 0, reason: "" }, cand) > 0.4)) {
          continue;
        }
        fresh.push({
          title: cand.title,
          startSec: w.start,
          endSec: w.end,
          score: w.score,
          reason: `El chat explotó: ${w.peak} mensajes en 10 s (la media era ${w.median}). Lo más repetido: ${w.topWords.slice(0, 3).join(", ") || "—"}.`,
          excerpt:
            w.samples.length > 0
              ? `Chat: ${w.samples.slice(0, 4).join(" · ")}`
              : `Chat a mil: ${w.topWords.join(", ")}`,
          // The clip's burned captions: the chat's real messages in
          // this window, each at its own second, in the same
          // [label] text format the normal pipeline stores — so the
          // render burns them with buildClipAss in the TikTok style
          // and the .srt download carries them too.
          subtitlesText: w.lines
            .filter((l) => l.at >= w.start && l.at < w.end)
            .slice(0, 40)
            .map((l) => `[${fmtTime(l.at)}] ${l.text}`)
            .join("\n"),
        });
      }
      if (fresh.length > 0) {
        await db.insert(schema.clips).values(
          fresh.map((c) => ({
            projectId,
            title: c.title,
            startSec: c.startSec,
            endSec: c.endSec,
            score: c.score,
            reason: c.reason,
            excerpt: c.excerpt,
            subtitlesText: c.subtitlesText,
            styleVersion: SUBTITLE_STYLE_VERSION,
            used: 0,
          })),
        );
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        clipsFound: fresh.length,
        projectId,
        note:
          fresh.length === 0
            ? "Esos momentos ya estaban guardados de una escucha anterior."
            : data.anchorExact
              ? null
              : "Ojo: los tiempos de estos clips son aproximados (la app cuenta desde que detectó el directo en vivo). Si un clip cae corrido, ajústalo con «Corregir tiempos» en su tarjeta.",
      };
    },
  }),

  getMySpace: defineAction({
    description:
      "Devuelve la cuenta de quien llama: su nombre, si es el admin (el dueño de la app) o un usuario normal, si su cuenta está activa o bloqueada, y cuántos videos, clips y directos tiene en SU biblioteca privada.",
    request: z.object({ ...authShape }),
    response: z.object({
      accountId: z.number(),
      displayName: z.string(),
      role: z.string(),
      isAdmin: z.boolean(),
      status: z.string(),
      projectsCount: z.number(),
      clipsCount: z.number(),
      liveEventsCount: z.number(),
      createdAt: z.string(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      const counts = await accountCounts(ctx, acc.id);
      return {
        accountId: acc.id,
        displayName: acc.displayName,
        role: acc.role,
        isAdmin: acc.role === "admin",
        status: acc.status,
        projectsCount: counts.projectsCount,
        clipsCount: counts.clipsCount,
        liveEventsCount: counts.liveEventsCount,
        createdAt: acc.createdAt.toISOString(),
      };
    },
  }),

  updateMyName: defineAction({
    description:
      "Cambia el nombre visible de la cuenta de quien llama (el nombre con el que el admin lo ve en su panel y con el que su espacio se identifica).",
    request: z.object({ ...authShape, name: z.string().min(1).max(40) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      displayName: z.string(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      const name = args.name.trim().slice(0, 40);
      if (!name) return { ok: false, error: "El nombre no puede quedar vacío.", displayName: acc.displayName };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.accounts)
        .set({ displayName: name })
        .where(eq(schema.accounts.id, acc.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, displayName: name };
    },
  }),

  listAccountsAdmin: defineAction({
    description:
      "SOLO ADMIN: lista todas las cuentas de la app con su rol, estado y cuántos videos, clips y directos guarda cada una, para que el dueño tenga el control de todas.",
    request: z.object({ ...authShape }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      accounts: z.array(
        z.object({
          id: z.number(),
          displayName: z.string(),
          role: z.string(),
          status: z.string(),
          isMe: z.boolean(),
          projectsCount: z.number(),
          clipsCount: z.number(),
          liveEventsCount: z.number(),
          createdAt: z.string(),
          lastSeenAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (acc.role !== "admin") {
        return { ok: false, error: "Solo el administrador puede ver todas las cuentas.", accounts: [] };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accounts)
        .orderBy(asc(schema.accounts.createdAt));
      const out = [];
      for (const r of rows) {
        const counts = await accountCounts(ctx, r.id);
        out.push({
          id: r.id,
          displayName: r.displayName,
          role: r.role,
          status: r.status,
          isMe: r.id === acc.id,
          projectsCount: counts.projectsCount,
          clipsCount: counts.clipsCount,
          liveEventsCount: counts.liveEventsCount,
          createdAt: r.createdAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
        });
      }
      return { ok: true, error: null, accounts: out };
    },
  }),

  adminListLibrary: defineAction({
    description:
      "SOLO ADMIN: devuelve la biblioteca completa de la cuenta indicada (sus videos y clips), en el mismo formato que la biblioteca normal, para revisarla desde el panel de admin.",
    request: z.object({ ...authShape, accountId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      accountName: z.string(),
      creators: z.array(
        z.object({
          creator: z.string(),
          projects: z.array(projectShape),
        }),
      ),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (acc.role !== "admin") {
        return { ok: false, error: "Solo el administrador puede ver las demás bibliotecas.", accountName: "", creators: [] };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.accountId))
        .limit(1);
      const target = rows[0];
      if (!target) {
        return { ok: false, error: "Esa cuenta ya no existe.", accountName: "", creators: [] };
      }
      const lib = await buildLibrary(ctx, target.id);
      return { ok: true, error: null, accountName: target.displayName, creators: lib.creators };
    },
  }),

  adminSetAccountStatus: defineAction({
    description:
      "SOLO ADMIN: bloquea o reactiva una cuenta de usuario. Una cuenta bloqueada no puede analizar videos, sacar clips ni cortar MP4 (el servidor rechaza sus acciones); su biblioteca queda guardada y vuelve tal cual al reactivarla. El admin no puede bloquearse a sí mismo ni a otra cuenta admin.",
    request: z.object({ ...authShape,
      accountId: z.number().int().positive(),
      status: z.enum(["active", "blocked"]),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (acc.role !== "admin") {
        return { ok: false, error: "Solo el administrador puede bloquear cuentas." };
      }
      if (args.accountId === acc.id) {
        return { ok: false, error: "No puedes bloquear tu propia cuenta de admin." };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.accountId))
        .limit(1);
      const target = rows[0];
      if (!target) return { ok: false, error: "Esa cuenta ya no existe." };
      if (target.role === "admin") {
        return { ok: false, error: "Una cuenta de administrador no se puede bloquear." };
      }
      await db
        .update(schema.accounts)
        .set({ status: args.status })
        .where(eq(schema.accounts.id, target.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  adminClearLibrary: defineAction({
    description:
      "SOLO ADMIN: vacía por completo la biblioteca de la cuenta indicada — borra todos sus videos, clips, MP4 cortados y sus directos seguidos. La cuenta misma queda (con su nombre y estado) y puede volver a usar la app. Devuelve cuántos videos se borraron.",
    request: z.object({ ...authShape, accountId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      removedProjects: z.number(),
    }),
    async handler(ctx, args) {
      const acc = await resolveAccount(ctx, args);
      if (acc.role !== "admin") {
        return { ok: false, error: "Solo el administrador puede vaciar bibliotecas.", removedProjects: 0 };
      }
      const db = ctx.db<typeof schema>();
      const targetRows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.accountId))
        .limit(1);
      if (!targetRows[0]) {
        return { ok: false, error: "Esa cuenta ya no existe.", removedProjects: 0 };
      }
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.ownerAccountId, args.accountId));
      const blobKeys: (string | null)[] = [];
      for (const proj of projectRows) {
        const clipRows = await db
          .select({ videoKey: schema.clips.videoKey })
          .from(schema.clips)
          .where(eq(schema.clips.projectId, proj.id));
        for (const c of clipRows) blobKeys.push(c.videoKey);
        blobKeys.push(proj.thumbnailKey);
        await db.delete(schema.clips).where(eq(schema.clips.projectId, proj.id));
      }
      await db
        .delete(schema.projects)
        .where(eq(schema.projects.ownerAccountId, args.accountId));
      await db
        .delete(schema.liveEvents)
        .where(eq(schema.liveEvents.ownerAccountId, args.accountId));
      for (const key of blobKeys) {
        if (!key) continue;
        try {
          await ctx.blobs.delete(key);
        } catch {
          // Best-effort cleanup (thumbnails are shared per video).
        }
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, removedProjects: projectRows.length };
    },
  }),

  getSession: defineAction({
    description:
      "Dice si el token de sesión enviado sigue válido y a qué cuenta pertenece (nombre, rol, estado), sin crear cuentas ni tocar bibliotecas. Es la prueba que la pantalla de inicio de sesión usa al abrir la app.",
    request: z.object({ ...authShape }),
    response: z.object({
      signedIn: z.boolean(),
      account: z
        .object({
          accountId: z.number(),
          displayName: z.string(),
          role: z.string(),
          isAdmin: z.boolean(),
          status: z.string(),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const token = args.auth?.trim();
      if (!token) return { signedIn: false, account: null };
      const acc = await accountForSessionToken(ctx, token).catch(() => null);
      if (!acc) return { signedIn: false, account: null };
      return {
        signedIn: true,
        account: {
          accountId: acc.id,
          displayName: acc.displayName,
          role: acc.role,
          isAdmin: acc.role === "admin",
          status: acc.status,
        },
      };
    },
  }),

  registerAccount: defineAction({
    description:
      "Crea una cuenta de acceso (usuario o correo + contraseña) y entra de una vez, devolviendo el token de sesión. Cada cuenta nueva es un espacio aparte con su biblioteca vacía. Si quien se registra es el dueño de la app, las credenciales quedan unidas a SU cuenta de admin, con toda su biblioteca y su panel de control.",
    request: z.object({
      ...authShape,
      login: z.string().min(3).max(80),
      password: z.string().min(6).max(200),
      displayName: z.string().max(40).default(""),
    }),
    response: authResultShape,
    async handler(ctx, args) {
      const fail = (error: string) => ({
        ok: false,
        error,
        token: null,
        displayName: "",
        isAdmin: false,
      });
      const loginKey = normalizeLogin(args.login);
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginKey);
      const isUsername = /^[a-z0-9._-]{3,40}$/.test(loginKey);
      if (!isEmail && !isUsername) {
        return fail(
          "Usa un usuario válido (3-40 caracteres: letras, números, punto, guión o _) o un correo completo.",
        );
      }
      if (args.password.length < 6) {
        return fail("La contraseña necesita al menos 6 caracteres.");
      }
      const db = ctx.db<typeof schema>();
      const taken = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.loginName, loginKey))
        .limit(1);
      if (taken[0]) {
        return fail("Ese usuario o correo ya tiene cuenta. Entra con «Iniciar sesión».");
      }
      const passwordHash = await hashPassword(args.password);
      const name = args.displayName.trim().slice(0, 40);
      const { isOwner } = viewerInfo(ctx);
      let acc: AccountRow;
      if (isOwner) {
        // The owner registering is not a new member: his credentials
        // attach to his existing admin account, so his library, his
        // followed live events and his admin panel all stay on the
        // account he signs in with.
        const mine = await ensureAccount(ctx);
        if (mine.loginName) {
          return fail(
            `Tu cuenta de admin ya tiene un usuario de acceso («${mine.loginName}»). Entra con «Iniciar sesión».`,
          );
        }
        const displayName = name || mine.displayName;
        await db
          .update(schema.accounts)
          .set({ loginName: loginKey, passwordHash, displayName })
          .where(eq(schema.accounts.id, mine.id));
        acc = { ...mine, loginName: loginKey, passwordHash, displayName };
      } else {
        await db
          .insert(schema.accounts)
          .values({
            viewerKey: `cred:${loginKey}`,
            displayName: name || "Usuario",
            role: "member",
            status: "active",
            loginName: loginKey,
            passwordHash,
            lastSeenAt: new Date(),
          })
          .onConflictDoNothing();
        const rows = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.loginName, loginKey))
          .limit(1);
        const created = rows[0];
        if (!created || created.passwordHash !== passwordHash) {
          // Lost a registration race for the same login name.
          return fail("Ese usuario o correo ya tiene cuenta. Entra con «Iniciar sesión».");
        }
        acc = created;
      }
      if (isBlocked(acc)) return fail(BLOCKED_ERROR);
      const token = await createSession(ctx, acc.id);
      return { ok: true, error: null, token, displayName: acc.displayName, isAdmin: acc.role === "admin" };
    },
  }),

  loginAccount: defineAction({
    description:
      "Inicia sesión con usuario o correo + contraseña y devuelve el token de sesión de esa cuenta: la persona llega a SU propio espacio y su biblioteca. Una cuenta bloqueada por el admin no puede entrar.",
    request: z.object({
      ...authShape,
      login: z.string().min(1).max(80),
      password: z.string().min(1).max(200),
    }),
    response: authResultShape,
    async handler(ctx, args) {
      const fail = (error: string) => ({
        ok: false,
        error,
        token: null,
        displayName: "",
        isAdmin: false,
      });
      const loginKey = normalizeLogin(args.login);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.loginName, loginKey))
        .limit(1);
      const acc = rows[0];
      if (!acc || !acc.passwordHash) {
        return fail(
          "No encontré ninguna cuenta con ese usuario o correo. Revisa el dato o crea tu cuenta.",
        );
      }
      const okPass = await verifyPassword(args.password, acc.passwordHash);
      if (!okPass) return fail("Contraseña incorrecta. Inténtalo de nuevo.");
      if (isBlocked(acc)) return fail(BLOCKED_ERROR);
      const now = new Date();
      await db
        .update(schema.accounts)
        .set({ lastSeenAt: now })
        .where(eq(schema.accounts.id, acc.id));
      const token = await createSession(ctx, acc.id);
      return { ok: true, error: null, token, displayName: acc.displayName, isAdmin: acc.role === "admin" };
    },
  }),

  logout: defineAction({
    description:
      "Cierra la sesión actual: borra el token de sesión enviado, así ese dispositivo queda fuera de la cuenta hasta que la persona vuelva a iniciar sesión.",
    request: z.object({ ...authShape }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const token = args.auth?.trim();
      if (token) {
        const db = ctx.db<typeof schema>();
        await db
          .delete(schema.sessions)
          .where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
      }
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
