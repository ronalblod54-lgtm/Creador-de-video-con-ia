// Privileged host work for SamuelClip: cutting a clip out of a YouTube
// stream with ffmpeg, with the captions burned into the picture.
//
// Why it is built this way (all measured 2026-11-08 on this host):
// - A single daemon request has a 30s wall-clock budget and a privileged
//   call caps at 120s, but a cut takes longer, so NOTHING in the render
//   pipeline may run inside a handler call: `startClipRender` only
//   writes a job file and spawns a fully DETACHED node worker
//   (render-worker.mjs, source embedded below) that resolves the
//   streams, downloads the clip's segments and runs ffmpeg on its own.
//   `finishClipRender` only reads the worker's marker/progress files
//   and, once the .done marker exists, reports the finished size; the
//   action then pulls the MP4 over in ~4 MB slices through
//   `readClipRenderChunk` and only when the blob is stored does it
//   call `discardClipRender` to clean the work files up.
// - The hand-back used to be ONE base64 string with the whole MP4.
//   For an 88 s HD clip (~20+ MB, ~27 MB base64) the daemon truncated
//   that response, the action call threw, and the phone showed "La
//   conexión falló preparando el MP4" (reproduced 2026-11-08 in the
//   sandbox with the user's exact clip). Worse, the old finish
//   handler deleted the render files BEFORE returning, so the
//   finished MP4 was destroyed and every retry re-rendered for
//   minutes only to die at the same collection step. Chunked
//   collection + cleanup only after the blob is safely stored breaks
//   that loop: a failed collection is retried from the intact files.
// - The download used to run inside `startClipRender` as ONE giant
//   range request per stream. That is what froze the user's renders at
//   38% (screenshot 2026-11-08, "No pasa de ahi"): the audio file (~1-2
//   MB) always landed, the much larger 720p video range stalled
//   mid-body through the proxy, the handler process was killed at its
//   timeout before its catch could write an .err marker, and the fresh
//   .lock it left behind made every later poll report "working"
//   forever. Fixes: the detached worker cannot be killed by a handler
//   timeout; the media span is downloaded in ~1.5 MB chunks, each with
//   its own timeout and retries, appending to the file and reporting
//   byte-level progress; and `finishClipRender` treats a render with
//   no file activity for 6 minutes as dead, cleans it up and reports
//   "none" so the same tap silently starts a fresh render.
// - ffmpeg reading the remote googlevideo streams directly stalls in
//   this environment (its HTTP stack hangs on the proxy), while plain
//   fetch answers range requests with real MP4 bytes. So the worker
//   downloads ONLY the DASH segments that overlap the clip — located
//   through the stream's sidx index — and ffmpeg then works on local
//   files: fast seek, compose the split layout the user asked for
//   (v9: the creator's own facecam, cropped out of the source frame's
//   top-left corner into a SMALL band across only the top of the
//   9:16 frame — his face small, just his face — with the game in
//   the larger band below it — the format of the reference TikTok
//   he sent), burn the captions with libass, mux one MP4.

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  startClipRender: {
    request: z.object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
      startSec: z.number().min(0).max(86400),
      durationSec: z.number().min(1).max(300),
      workPrefix: z.string().min(5).max(500),
      // The clip's captions as a styled ASS document (times already
      // rebased to 0), burned into the video with libass. Empty string =
      // no captions to burn.
      assContent: z.string().max(120000),
      // Render layout: "split" (default) is the RDjavi format — his
      // facecam cropped into a small top band, game below. "full" is
      // for live-show projects (La Casa de Alofoke): the whole frame
      // as a 4:5 foreground over a blurred cover of itself, because a
      // reality-show frame has no facecam corner to crop.
      layout: z.enum(["split", "full"]).optional(),
      // Legacy field from the v6 avatar overlay: accepted so older
      // callers keep working, but ignored since v7 — the creator's
      // face now comes from the facecam cropped out of the source
      // video itself, not from a still image.
      faceImageUrl: z.string().url().max(2000).optional(),
    }),
    response: z.object({ state: z.enum(["working", "done", "error", "none"]) }),
    capabilities: ["subprocess.ffmpeg", "network.fetch"],
    timeoutMs: 30000,
  },
  finishClipRender: {
    request: z.object({ workPrefix: z.string().min(5).max(500) }),
    response: z.object({
      state: z.enum(["working", "done", "error", "none"]),
      bytes: z.number(),
      progress: z.number(),
    }),
    capabilities: ["filesystem.read"],
    timeoutMs: 60000,
  },
  readClipRenderChunk: {
    // One slice of the finished MP4, base64-encoded. The action loops
    // over offsets until it has the whole file; each response stays a
    // few MB at most, far below the daemon transport limit that
    // truncated the old single-shot base64 hand-back.
    request: z.object({
      workPrefix: z.string().min(5).max(500),
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(8388608),
    }),
    response: z.object({
      base64: z.string(),
      totalBytes: z.number(),
      eof: z.boolean(),
    }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30000,
  },
  discardClipRender: {
    // Removes a render's work files. The action calls this only after
    // the MP4 is stored as a blob, so a collection failure never
    // destroys a finished render.
    request: z.object({ workPrefix: z.string().min(5).max(500) }),
    response: z.object({ ok: z.boolean() }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30000,
  },
  startLiveWatch: {
    // Starts the detached live-chat listener for a stream that is on
    // air: it polls YouTube's live chat (get_live_chat) and aggregates
    // messages into 10-second buckets (count, most repeated words,
    // sample messages) written to a progress file the actions read.
    // Like the render, NOTHING runs inside this call: it only writes
    // the job file and spawns the detached worker.
    request: z.object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
      workPrefix: z.string().min(5).max(500),
      apiKey: z.string().min(10).max(200),
      continuation: z.string().min(20).max(4000),
      clientVersion: z.string().min(3).max(60),
      // Wall-clock epoch (ms) of the stream's start, used to turn chat
      // message timestamps into seconds-into-the-stream. 0 = unknown:
      // the worker anchors at its own start and the action flags the
      // session's times as approximate.
      streamStartEpochMs: z.number().min(0).max(4102444800000),
      anchorExact: z.boolean(),
      maxMinutes: z.number().int().min(1).max(120),
    }),
    response: z.object({ state: z.enum(["working", "done", "error", "none"]) }),
    capabilities: ["network.fetch"],
    timeoutMs: 30000,
  },
  readLiveWatch: {
    // Reads the live listener's state file: totals plus the 10-second
    // buckets it has aggregated so far.
    request: z.object({ workPrefix: z.string().min(5).max(500) }),
    response: z.object({
      state: z.enum(["watching", "done", "error", "none"]),
      messagesTotal: z.number(),
      elapsedSec: z.number(),
      anchorExact: z.boolean(),
      endReason: z.string(),
      buckets: z.array(
        z.object({
          startSec: z.number(),
          count: z.number(),
          top: z.array(z.string()),
          samples: z.array(z.string()),
        }),
      ),
    }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30000,
  },
  stopLiveWatch: {
    // Asks the detached listener to wrap up (it checks for the stop
    // marker between chat polls and finishes with its buckets intact).
    request: z.object({ workPrefix: z.string().min(5).max(500) }),
    response: z.object({ ok: z.boolean() }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30000,
  },
  discardLiveWatch: {
    request: z.object({ workPrefix: z.string().min(5).max(500) }),
    response: z.object({ ok: z.boolean() }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30000,
  },
});

// ------------------------------------------------------------ marker files

const RENDER_SUFFIXES = [
  ".mp4",
  ".done",
  ".err",
  ".errlog",
  ".lock",
  ".ass",
  ".video.mp4",
  ".audio.mp4",
  ".progress.json",
  ".meta.json",
  ".ffprogress",
  ".job.json",
  ".face",
];

// A live render touches one of its files at least every few seconds
// (a progress write per downloaded chunk, ffmpeg's -progress file
// while encoding). Six silent minutes means the worker is gone.
const STALL_MS = 6 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupRenderFiles(workPrefix: string, keep: string[] = []): Promise<void> {
  for (const suffix of RENDER_SUFFIXES) {
    if (keep.includes(suffix)) continue;
    await rm(`${workPrefix}${suffix}`, { force: true }).catch(() => {});
  }
}

// Newest mtime across the files a render touches while alive; null when
// none of them exist.
async function lastActivityMs(workPrefix: string): Promise<number | null> {
  let newest: number | null = null;
  for (const suffix of [".lock", ".progress.json", ".ffprogress", ".mp4"]) {
    try {
      const st = await stat(`${workPrefix}${suffix}`);
      if (newest == null || st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // File does not exist (yet).
    }
  }
  return newest;
}

async function readStoredProgress(workPrefix: string): Promise<number | null> {
  try {
    const raw = await readFile(`${workPrefix}.progress.json`, "utf8");
    const parsed = JSON.parse(raw) as { percent?: number };
    if (typeof parsed.percent === "number" && Number.isFinite(parsed.percent)) {
      return Math.max(0, Math.min(100, Math.round(parsed.percent)));
    }
  } catch {
    // No progress file yet.
  }
  return null;
}

// Real encoding progress from ffmpeg's -progress file: it appends blocks
// with out_time_us (microseconds) as the render advances. Mapped onto the
// 40–97 band: 0–40 is reserved for resolving/downloading the segments.
async function readFfmpegProgress(workPrefix: string): Promise<number | null> {
  let durationSec = 0;
  try {
    const metaRaw = await readFile(`${workPrefix}.meta.json`, "utf8");
    const meta = JSON.parse(metaRaw) as { durationSec?: number };
    if (typeof meta.durationSec === "number" && meta.durationSec > 0) durationSec = meta.durationSec;
  } catch {
    return null;
  }
  if (!durationSec) return null;
  let text: string;
  try {
    text = await readFile(`${workPrefix}.ffprogress`, "utf8");
  } catch {
    return null;
  }
  if (!text) return null;
  // Take the LAST out_time value in the file (blocks accumulate).
  let outSec: number | null = null;
  for (const m of text.matchAll(/out_time_us=(\d+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) outSec = v / 1_000_000;
  }
  if (outSec == null) {
    for (const m of text.matchAll(/out_time_ms=(\d+)/g)) {
      const v = Number(m[1]);
      // ffmpeg reports out_time_ms in microseconds despite the name.
      if (Number.isFinite(v)) outSec = v / 1_000_000;
    }
  }
  if (outSec == null) {
    for (const m of text.matchAll(/out_time=(\d+):(\d+):([\d.]+)/g)) {
      const h = Number(m[1]);
      const min = Number(m[2]);
      const s = Number(m[3]);
      if ([h, min, s].every((n) => Number.isFinite(n))) outSec = h * 3600 + min * 60 + s;
    }
  }
  if (outSec == null) return null;
  if (/progress=end/.test(text)) return 100;
  const ratio = Math.max(0, Math.min(1, outSec / durationSec));
  return Math.max(40, Math.min(97, Math.round(40 + ratio * 57)));
}

// ------------------------------------------------------------- the worker
//
// The whole render pipeline as a standalone ES module, written next to
// the render files and run detached with node. It must stay free of
// backticks and "${" sequences (it lives inside a String.raw literal)
// and uses plain string concatenation throughout. It mirrors the DASH /
// sidx logic that used to run inside the handler: everything comes from
// the DASH manifest alone — each Representation carries its own signed
// BaseURL plus its SegmentBase byte ranges, so the URLs and the ranges
// always belong to the same media file. (Mixing the manifest's ranges
// with adaptiveFormats URLs corrupts the download — the two responses
// sign different URLs, and audio representations are per-language: ids
// look like "140-es-US.4".)

const WORKER_SOURCE = String.raw`
import fs from "node:fs";
import { spawnSync } from "node:child_process";

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var INVIDIOUS_INSTANCES = ["https://yt.chocolatemoo53.com", "https://inv.nadeko.net"];
var CHUNK_BYTES = 1572864; // ~1.5 MB per range request

var jobPath = process.argv[2];
var job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
var P = job.workPrefix;
var OUT = P + ".mp4";

function writeProgress(percent) {
  try {
    fs.writeFileSync(P + ".progress.json", JSON.stringify({ percent: Math.max(0, Math.min(100, Math.round(percent))), at: Date.now() }));
  } catch (e) { /* progress is best-effort */ }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function parseManifest(xmlRaw) {
  var xml = xmlRaw.replace(/&amp;/g, "&");
  var reps = [];
  var setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  var set;
  while ((set = setRe.exec(xml)) !== null) {
    var mimeType = (set[1].match(/mimeType="([^"]+)"/) || [])[1] || "";
    var body = set[2] || "";
    var repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
    var m;
    while ((m = repRe.exec(body)) !== null) {
      var attrs = m[1] || "";
      var repBody = m[2] || "";
      var id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || "";
      var baseUrl = ((repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/) || [])[1] || "").trim();
      var segBase = repBody.match(/<SegmentBase\b([^>]*)>/);
      var init = repBody.match(/<Initialization\b([^>]*)\/>/);
      if (!id || !baseUrl || !segBase || !init) continue;
      var indexRange = (segBase[1] || "").match(/indexRange="(\d+)-(\d+)"/);
      var initRange = (init[1] || "").match(/range="(\d+)-(\d+)"/);
      if (!indexRange || !initRange) continue;
      reps.push({
        id: id,
        mimeType: mimeType,
        lang: (set[1].match(/lang="([^"]+)"/) || [])[1] || "",
        codecs: (attrs.match(/codecs="([^"]+)"/) || [])[1] || "",
        bandwidth: Number((attrs.match(/bandwidth="(\d+)"/) || [])[1] || 0),
        height: Number((attrs.match(/height="(\d+)"/) || [])[1] || 0),
        url: baseUrl,
        ranges: {
          initStart: Number(initRange[1]),
          initEnd: Number(initRange[2]),
          indexStart: Number(indexRange[1]),
          indexEnd: Number(indexRange[2]),
        },
      });
    }
  }
  return reps;
}

async function resolveDashStreams(videoId) {
  for (var i = 0; i < INVIDIOUS_INSTANCES.length; i++) {
    var base = INVIDIOUS_INSTANCES[i];
    try {
      var res = await fetch(base + "/api/v1/videos/" + videoId, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      var info = await res.json();
      if (!info.dashUrl) continue;
      var mpd = await fetch(new URL(info.dashUrl, base).toString(), {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!mpd.ok) continue;
      var reps = parseManifest(await mpd.text());
      var videos = reps
        .filter(function (r) { return r.mimeType.indexOf("video/mp4") === 0 && r.codecs.indexOf("avc1") >= 0; })
        .sort(function (a, b) {
          // Prefer the 1080p source (v7): the user asked for the split
          // layout "con mucha calidad" — the facecam corner is only
          // ~480px wide even at 1080p and is enlarged to the full 1080
          // output width, so every source pixel counts; 720p made the
          // enlarged face look soft. Falls back to the closest height
          // when a video has no 1080p representation.
          var dist = function (h) { return h <= 1080 ? 1080 - h : (h - 1080) * 2; };
          var da = dist(a.height);
          var db = dist(b.height);
          if (da !== db) return da - db;
          return b.bandwidth - a.bandwidth;
        });
      var audios = reps
        .filter(function (r) { return r.mimeType.indexOf("audio/mp4") === 0; })
        .sort(function (a, b) {
          // Prefer the Spanish track (v10 fix): a DASH manifest can
          // carry several audio languages (the original plus dubs),
          // and the highest-bandwidth one is not necessarily the
          // language the creator actually speaks — a clip could come
          // out dubbed in the wrong language. Spanish first (the app
          // prefers Spanish subtitles the same way), then bandwidth.
          // When the manifest carries no lang tags this degrades to
          // the old bandwidth-only order.
          var ea = (a.lang || "").toLowerCase().indexOf("es") === 0 ? 0 : 1;
          var eb = (b.lang || "").toLowerCase().indexOf("es") === 0 ? 0 : 1;
          if (ea !== eb) return ea - eb;
          return b.bandwidth - a.bandwidth;
        });
      var video = videos[0];
      var audio = audios[0];
      if (video && audio) {
        return {
          video: { url: video.url, ranges: video.ranges },
          audio: { url: audio.url, ranges: audio.ranges },
        };
      }
    } catch (e) { /* try the next instance */ }
  }
  return null;
}

function parseSidx(buf, boxStart) {
  var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (boxStart + 28 > buf.byteLength) return null;
  var type = String.fromCharCode(buf[boxStart + 4] || 0, buf[boxStart + 5] || 0, buf[boxStart + 6] || 0, buf[boxStart + 7] || 0);
  if (type !== "sidx") return null;
  var version = buf[boxStart + 8] || 0;
  var timescale = view.getUint32(boxStart + 16);
  if (!timescale) return null;
  // The spec puts the reference entries at +28 (v0) / +36 (v1), but
  // YouTube's sidx carries an extra zero u32 that shifts them by 4
  // (verified byte-by-byte 2026-11-08: count 469 sits at +30, entries at
  // +32, durations 5.5s/3.9s/6.6s at timescale 15360). Try both layouts
  // and keep the one whose entries look like real segments.
  var candidates = version === 1 ? [40, 36] : [32, 28];
  for (var c = 0; c < candidates.length; c++) {
    var rel = candidates[c];
    var entriesAt = boxStart + rel;
    if (entriesAt + 12 > buf.byteLength) continue;
    var count = view.getUint16(entriesAt - 2);
    if (count === 0 || count > 100000) continue;
    if (entriesAt + count * 12 > buf.byteLength + 12) continue;
    var entries = [];
    var plausible = true;
    for (var i = 0; i < count; i++) {
      var at = entriesAt + i * 12;
      if (at + 12 > buf.byteLength) { plausible = false; break; }
      var size = view.getUint32(at) & 0x7fffffff;
      var duration = view.getUint32(at + 4);
      if (i < 4 && (size < 500 || size > 16000000 || duration / timescale < 0.2 || duration / timescale > 30)) { plausible = false; break; }
      entries.push({ size: size, duration: duration });
    }
    if (!plausible || entries.length === 0) continue;
    var firstOffset = rel === 32 ? Number(view.getBigUint64(boxStart + 20)) : view.getUint32(boxStart + 20);
    if (!Number.isFinite(firstOffset) || firstOffset > 1000000) firstOffset = 0;
    return { timescale: timescale, firstOffset: firstOffset, entries: entries };
  }
  return null;
}

async function fetchRangeOnce(url, start, end) {
  var res = await fetch(url, {
    headers: { "User-Agent": UA, Range: "bytes=" + start + "-" + end },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status + " en rango " + start + "-" + end);
  var buf = new Uint8Array(await res.arrayBuffer());
  var want = end - start + 1;
  if (buf.byteLength === want) return buf;
  // A server that ignored the Range header answers with the whole file:
  // the wanted window is a slice of it.
  if (buf.byteLength > end) return buf.slice(start, end + 1);
  throw new Error("Rango incompleto: " + buf.byteLength + " de " + want + " bytes");
}

async function fetchRange(url, start, end) {
  var lastErr = null;
  for (var attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchRangeOnce(url, start, end);
    } catch (e) {
      lastErr = e;
      await sleep(900 * (attempt + 1));
    }
  }
  throw lastErr || new Error("No pude bajar el rango " + start + "-" + end);
}

// Download init + only the media segments overlapping [startSec, endSec]
// (one segment of padding on each side) as one local fMP4. The media
// span goes down in ~1.5 MB chunks, each retried, appended as it lands,
// with onProgress(downloaded, total) after every chunk. Returns the
// local file's start time (the first included segment's start).
async function downloadClipPart(url, ranges, startSec, endSec, destPath, onProgress) {
  var indexBytes = await fetchRange(url, ranges.indexStart, ranges.indexEnd);
  var sidx = parseSidx(indexBytes, 0);
  if (!sidx) throw new Error("No pude leer el índice de segmentos del video.");
  var mediaStart = ranges.indexEnd + 1 + sidx.firstOffset;
  var segs = [];
  var t = 0;
  var byteAt = mediaStart;
  for (var i = 0; i < sidx.entries.length; i++) {
    var e = sidx.entries[i];
    var dur = e.duration / sidx.timescale;
    segs.push({ start: t, end: t + dur, byteStart: byteAt, byteEnd: byteAt + e.size - 1 });
    t += dur;
    byteAt += e.size;
  }
  var first = -1;
  for (var a = 0; a < segs.length; a++) { if (segs[a].end > startSec) { first = a; break; } }
  if (first < 0) first = segs.length - 1;
  var last = -1;
  for (var b = 0; b < segs.length; b++) { if (segs[b].start >= endSec) { last = b; break; } }
  last = last < 0 ? segs.length - 1 : Math.max(first, last - 1);
  first = Math.max(0, first - 1);
  last = Math.min(segs.length - 1, last + 1);
  var firstSeg = segs[first];
  var lastSeg = segs[last];
  if (!firstSeg || !lastSeg) throw new Error("El clip cae fuera del video.");
  var spanBytes = lastSeg.byteEnd - firstSeg.byteStart + 1;
  // 400 MB cap (was 320 in v7-v9, 160 before): since v7 the worker
  // downloads the 1080p representation, whose segment span for a
  // long clip is roughly double the old 720p span, and the longest
  // clips this app cuts (240 s) could brush the old cap and fail
  // with a misleading "too big" error.
  if (spanBytes > 400 * 1024 * 1024) throw new Error("El pedazo a bajar es demasiado grande.");
  var init = await fetchRange(url, ranges.initStart, ranges.initEnd);
  fs.writeFileSync(destPath, init);
  var downloaded = 0;
  for (var at = firstSeg.byteStart; at <= lastSeg.byteEnd; at += CHUNK_BYTES) {
    var chunkEnd = Math.min(lastSeg.byteEnd, at + CHUNK_BYTES - 1);
    var buf = await fetchRange(url, at, chunkEnd);
    fs.appendFileSync(destPath, buf);
    downloaded += buf.byteLength;
    onProgress(downloaded, spanBytes);
  }
  return firstSeg.start;
}

async function main() {
  writeProgress(8);
  var streams = await resolveDashStreams(job.videoId);
  if (!streams) throw new Error("Sin streams: ningún servidor de video respondió.");
  writeProgress(15);
  var videoPath = P + ".video.mp4";
  var audioPath = P + ".audio.mp4";
  var endSec = job.startSec + job.durationSec;
  // Sequential on purpose: the two transfers no longer compete for the
  // proxy, and progress stays honest (video 15-33, audio 33-40).
  var videoStart = await downloadClipPart(streams.video.url, streams.video.ranges, job.startSec, endSec, videoPath, function (done, total) {
    writeProgress(15 + (total > 0 ? (done / total) * 18 : 0));
  });
  var audioStart = await downloadClipPart(streams.audio.url, streams.audio.ranges, job.startSec, endSec, audioPath, function (done, total) {
    writeProgress(33 + (total > 0 ? (done / total) * 7 : 0));
  });
  writeProgress(40);
  // Layout v9 (user, 2026-11-08, reversing the v8 enlargement:
  // "la cara de rdjavi sale demasiado grande y solo la quiero
  // arriba no tan para abajo en verdad, ponla más para arriba y
  // pequeña solo que salga su cara"): same split screen — RDjavi's
  // own webcam, which his videos carry as a framed box in the
  // TOP-LEFT corner of the frame, on top with the game below — but
  // the camera band SHRINKS back to only the top of the frame and
  // the crop opens up around his face, so his face reads SMALL and
  // nothing but his face area shows: no room, no name strip. No
  // still image is pasted anywhere: the face is the moving facecam
  // cut out of the source video itself. In shots where his
  // broadcast hides the facecam box, the top band simply shows
  // that corner of the game — the same thing the reference editor
  // gets from the same source.
  // Top band: 1080x600 — only the top ~31% of the frame (v8:
  // 1080x1054, ~55%, which is why the face looked huge and reached
  // halfway down the screen). The crop is tuned on the same real
  // frames as v8: the facecam box spans roughly x 0-0.24, y 0-0.41
  // of the frame and his face sits at about x 0.092, y 0.146,
  // roughly 0.075 of the width across (measured on frames of
  // KRz2ZMy2AdI at t~1106s). The crop takes iw*0.22 x iw*0.1222
  // (the band's 1080:600 aspect) centered on that face position —
  // x clamps to the frame's left edge, y starts at ih*0.037 — so
  // his face lands at ~34% of the band's width and ~48% of its
  // height (v8: ~46% x ~59% of a band nearly twice as tall; on
  // screen the face goes from ~450x630 px to ~370x290 px), and the
  // room edges, name strip and microphone arm stay outside the
  // crop. Lanczos-upscaled from the 1080p source.
  // Bottom band: 1080x1320 crop of the game (it gains the height
  // the camera band gave back), still starting at x = iw*0.245 —
  // just right of the facecam box — so the box (and the room
  // inside it) never peeks into the game band's left edge.
  // Burned captions in the exact style of the user's reference
  // TikTok: the ASS document the action built carries the whole
  // style, so libass renders it as authored — no force_style
  // override. Their base stays at ~88% of the height (MarginV
  // 230), low inside the game band (which now spans ~31-100% of
  // the height) so they keep clear of the characters' movements.
  var fc;
  if (job.layout === "full") {
    // Layout "full" for live-show projects (La Casa de Alofoke): there
    // is no facecam corner in a reality-show frame, so the split above
    // would enlarge a random corner. Instead the v5 framing: the whole
    // frame as a 4:5 foreground centered over a blurred, slightly
    // darkened 9:16 cover of itself. Captions burn on top the same way
    // (for live clips the ASS carries the chat's real messages from
    // the clip's moment — the stream itself has no dialogue track).
    fc =
      "[0:v]split=2[bgin][fgin];" +
      "[bgin]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=1080:1920:flags=lanczos,gblur=sigma=24,eq=brightness=-0.08,setsar=1[bg];" +
      "[fgin]crop=w='min(iw,ih*4/5)':h='min(ih,iw*5/4)',scale=1080:1350:flags=lanczos,setsar=1[fg];" +
      "[bg][fg]overlay=(W-w)/2:(H-h)/2[comp]";
  } else {
    fc =
      "[0:v]split=2[camin][gamein];" +
      "[camin]crop=w='iw*0.22':h='iw*0.1222':x=0:y='ih*0.037',scale=1080:600:flags=lanczos,setsar=1,unsharp=5:5:0.6:3:3:0.3[cam];" +
      "[gamein]crop=w='min(iw*0.755,ih*9/11)':h='min(ih,iw*11/9)':x='iw*0.245',scale=1080:1320:flags=lanczos,setsar=1[game];" +
      "[cam][game]vstack=inputs=2[comp]";
  }
  var assPath = P + ".ass";
  var hasAss = typeof job.assContent === "string" && job.assContent.trim().length > 0;
  if (hasAss) {
    fs.writeFileSync(assPath, job.assContent, "utf8");
    fc += ";[comp]subtitles=filename='" + assPath + "'[vout]";
  } else {
    fc += ";[comp]null[vout]";
  }
  var ffArgs = [
    "-hide_banner", "-loglevel", "error", "-nostats",
    "-progress", P + ".ffprogress",
    "-ss", Math.max(0, job.startSec - videoStart).toFixed(3), "-i", videoPath,
    "-ss", Math.max(0, job.startSec - audioStart).toFixed(3), "-i", audioPath,
  ];
  ffArgs = ffArgs.concat([
    "-t", String(job.durationSec),
    // Quality v10 (user, 2026-11-09: "ponle más calidad a los video
    // que aún le falta"): preset medium + crf 18 (was veryfast/crf
    // 21) — the render runs detached in the background, so the app
    // can afford the slower, much cleaner encode; the facecam band
    // above also gets a gentle unsharp after its big lanczos upscale
    // (it is the softest part of the frame: a ~240px-wide crop blown
    // up to 1080). Audio rises to AAC 192k (was 160k) and the pixel
    // format is pinned to yuv420p so every player accepts the file.
    "-filter_complex", fc, "-map", "[vout]", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-y", OUT,
  ]);
  var res = spawnSync("ffmpeg", ffArgs, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  try { fs.rmSync(videoPath, { force: true }); } catch (e) {}
  try { fs.rmSync(audioPath, { force: true }); } catch (e) {}
  if (!hasAss) { try { fs.rmSync(assPath, { force: true }); } catch (e) {} }
  var outSize = 0;
  try { outSize = fs.statSync(OUT).size; } catch (e) {}
  if (res.status === 0 && outSize > 0) {
    fs.writeFileSync(P + ".done", String(Date.now()));
  } else {
    var tail = res.stderr ? res.stderr.toString().slice(-3000) : "";
    throw new Error("ffmpeg salió con código " + res.status + ". " + tail);
  }
}

main().then(
  function () {
    try { fs.rmSync(P + ".lock", { force: true }); } catch (e) {}
  },
  function (err) {
    try {
      fs.writeFileSync(P + ".errlog", err && err.stack ? String(err.stack) : String(err));
    } catch (e) {}
    try { fs.writeFileSync(P + ".err", String(Date.now())); } catch (e) {}
    try { fs.rmSync(P + ".lock", { force: true }); } catch (e) {}
  }
);
`;

// ------------------------------------------------- live chat listener
//
// The live mode's ears. Alofoke's broadcasts carry NO subtitle track
// (verified 2026-11-09 on six stream replays: Invidious lists zero
// caption tracks, Piped bot-blocks the channel's videos, timedtext
// answers empty), so the transcript pipeline can never find their
// moments. What a live show DOES have is its chat: when something
// happens in the house, the chat explodes — the same signal human
// clippers watch. This detached worker polls YouTube's live chat
// (youtubei get_live_chat, seeded from the video's live_chat popout
// page — both verified reachable from this network) and aggregates
// messages into 10-second buckets: how many arrived, the most
// repeated words, and a few sample messages. The actions then turn
// the spike buckets into clips. Same detached pattern as the render
// worker: no step runs inside a handler call, state lives in marker /
// progress files under the work prefix.

const LIVE_SUFFIXES = [
  ".done",
  ".err",
  ".errlog",
  ".lock",
  ".stop",
  ".progress.json",
  ".progress.tmp",
  ".job.json",
];

type LiveSnap = {
  state?: string;
  messagesTotal?: number;
  startedAtMs?: number;
  anchorExact?: boolean;
  endReason?: string;
  buckets?: { startSec: number; count: number; top: string[]; samples: string[] }[];
};

// Three silent minutes = the listener is gone (it writes progress at
// least once per chat poll, and polls are clamped to <= 20 s).
const LIVE_STALL_MS = 3 * 60 * 1000;

async function cleanupLiveFiles(workPrefix: string): Promise<void> {
  for (const suffix of LIVE_SUFFIXES) {
    await rm(`${workPrefix}${suffix}`, { force: true }).catch(() => {});
  }
}

const LIVE_WORKER_SOURCE = String.raw`
import fs from "node:fs";

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var jobPath = process.argv[2];
var job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
var P = job.workPrefix;
var startedAtMs = Date.now();
var anchorMs = job.streamStartEpochMs > 0 ? job.streamStartEpochMs : startedAtMs;
var maxMinutes = Math.max(1, Math.min(120, job.maxMinutes || 20));
var state = "watching";
var endReason = "";
var messagesTotal = 0;
var buckets = new Map();

var STOPWORDS = new Set([
  "para", "pero", "como", "esta", "este", "esto", "esas", "esos", "una", "uno",
  "los", "las", "del", "con", "por", "que", "mas", "muy", "ya", "si", "no",
  "se", "la", "el", "en", "de", "un", "al", "lo", "su", "es", "mi", "me",
  "te", "le", "ese", "esa", "eso", "son", "fue", "han", "hay", "voy", "vas",
  "vamos", "estoy", "estas", "esta", "estan", "cuando", "donde", "quien",
  "tambien", "porque", "entonces", "bueno", "bien", "mal", "todo", "toda",
  "todos", "nada", "algo", "solo", "sola", "ahora", "despues", "antes",
]);

function bucketFor(sec) {
  var start = Math.floor(Math.max(0, sec) / 10) * 10;
  var b = buckets.get(start);
  if (!b) {
    b = { startSec: start, count: 0, words: new Map(), samples: [] };
    buckets.set(start, b);
  }
  return b;
}

function addWords(bucket, text) {
  var words = text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
    .split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w || w.length < 4 || STOPWORDS.has(w)) continue;
    bucket.words.set(w, (bucket.words.get(w) || 0) + 1);
  }
}

function snapshot() {
  var list = [];
  var keys = Array.from(buckets.keys()).sort(function (a, b) { return a - b; });
  for (var i = 0; i < keys.length; i++) {
    var b = buckets.get(keys[i]);
    var top = Array.from(b.words.entries())
      .sort(function (a, c) { return c[1] - a[1]; })
      .slice(0, 5)
      .map(function (e) { return e[0]; });
    list.push({ startSec: b.startSec, count: b.count, top: top, samples: b.samples });
  }
  return {
    state: state,
    messagesTotal: messagesTotal,
    startedAtMs: startedAtMs,
    anchorExact: job.anchorExact === true,
    endReason: endReason,
    buckets: list,
  };
}

function writeProgress() {
  try {
    var tmp = P + ".progress.tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot()));
    fs.renameSync(tmp, P + ".progress.json");
  } catch (e) { /* progress is best-effort */ }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function messageText(runs) {
  if (!Array.isArray(runs)) return "";
  var out = "";
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i] || {};
    if (typeof r.text === "string") out += r.text;
    else if (r.emoji && typeof r.emoji.emojiId === "string") out += " " + r.emoji.emojiId + " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

function nextContinuation(json) {
  var cont = json && json.continuationContents && json.continuationContents.liveChatContinuation;
  if (!cont) return null;
  var list = cont.continuations || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {};
    var data = c.invalidationContinuationData || c.timedContinuationData || {};
    if (data.continuation) {
      return { token: data.continuation, timeoutMs: typeof data.timeoutMs === "number" ? data.timeoutMs : 6000 };
    }
  }
  return null;
}

function processActions(actions) {
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i] || {};
    var add = a.addChatItemAction;
    if (!add || !add.item) continue;
    var item = add.item;
    var renderer = item.liveChatTextMessageRenderer;
    var paid = item.liveChatPaidMessageRenderer;
    var isPaid = false;
    if (!renderer && paid) { renderer = paid; isPaid = true; }
    if (!renderer) continue;
    var tsUsec = Number(renderer.timestampUsec || 0);
    if (!tsUsec) continue;
    var sec = tsUsec / 1000000 - anchorMs / 1000;
    // With an exact stream-start anchor, anything timestamped before
    // the broadcast began is waiting-room chatter: skip it.
    if (job.anchorExact === true && sec < -30) continue;
    var bucket = bucketFor(sec);
    bucket.count += isPaid ? 3 : 1;
    messagesTotal += 1;
    var text = messageText(renderer.message && renderer.message.runs);
    if (text) {
      addWords(bucket, text);
      if (bucket.samples.length < 6) {
        var clean = text.slice(0, 90);
        if (bucket.samples.indexOf(clean) < 0) bucket.samples.push(clean);
      }
    }
  }
}

async function main() {
  writeProgress();
  var continuation = job.continuation;
  var consecutiveErrors = 0;
  while (true) {
    if (fs.existsSync(P + ".stop")) { endReason = "stopped"; break; }
    if ((Date.now() - startedAtMs) / 1000 > maxMinutes * 60) { endReason = "time"; break; }
    var t0 = Date.now();
    var timeoutMs = 6000;
    try {
      var res = await fetch("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=" + job.apiKey, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: job.clientVersion, hl: "es", gl: "US" } },
          continuation: continuation,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error("get_live_chat HTTP " + res.status);
      var json = await res.json();
      consecutiveErrors = 0;
      var cont = json && json.continuationContents && json.continuationContents.liveChatContinuation;
      var actions = (cont && cont.actions) || [];
      processActions(actions);
      var next = nextContinuation(json);
      writeProgress();
      if (!next) { endReason = "ended"; break; }
      continuation = next.token;
      timeoutMs = next.timeoutMs;
    } catch (e) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 6) throw e;
      timeoutMs = 5000;
    }
    var wait = Math.max(600, Math.min(20000, timeoutMs) - (Date.now() - t0));
    await sleep(wait);
  }
  state = "done";
  writeProgress();
}

main().then(
  function () {
    try { fs.writeFileSync(P + ".done", String(Date.now())); } catch (e) {}
    try { fs.rmSync(P + ".lock", { force: true }); } catch (e) {}
  },
  function (err) {
    state = "error";
    endReason = "error";
    writeProgress();
    try { fs.writeFileSync(P + ".errlog", err && err.stack ? String(err.stack) : String(err)); } catch (e) {}
    try { fs.writeFileSync(P + ".err", String(Date.now())); } catch (e) {}
    try { fs.rmSync(P + ".lock", { force: true }); } catch (e) {}
  }
);
`;

// ---------------------------------------------------------------- handlers

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async startClipRender(args) {
    const done = `${args.workPrefix}.done`;
    const err = `${args.workPrefix}.err`;
    const lock = `${args.workPrefix}.lock`;
    if (await exists(done)) return { state: "done" as const };
    if (await exists(err)) return { state: "error" as const };
    if (await exists(lock)) {
      // A live worker keeps touching its files; a silent lock belongs
      // to a dead render (host kill, older wedged build) — clear it and
      // start fresh instead of reporting "working" forever.
      const last = await lastActivityMs(args.workPrefix);
      if (last != null && Date.now() - last < STALL_MS) return { state: "working" as const };
      await cleanupRenderFiles(args.workPrefix);
    }
    await mkdir(dirname(args.workPrefix), { recursive: true });
    await writeFile(lock, String(Date.now()));
    await writeFile(
      `${args.workPrefix}.meta.json`,
      JSON.stringify({ durationSec: args.durationSec, startedAt: Date.now() }),
    ).catch(() => {});
    await writeFile(
      `${args.workPrefix}.progress.json`,
      JSON.stringify({ percent: 5, at: Date.now() }),
    ).catch(() => {});
    // (Re)write the worker so a running artifact always uses the
    // current pipeline, then hand it the job and detach: from here the
    // render owes nothing to this call's time budget.
    const workerPath = `${dirname(args.workPrefix)}/render-worker.mjs`;
    await writeFile(workerPath, WORKER_SOURCE, "utf8");
    const jobPath = `${args.workPrefix}.job.json`;
    await writeFile(
      jobPath,
      JSON.stringify({
        videoId: args.videoId,
        startSec: args.startSec,
        durationSec: args.durationSec,
        workPrefix: args.workPrefix,
        assContent: args.assContent,
        layout: args.layout ?? "split",
        faceImageUrl: args.faceImageUrl ?? "",
      }),
      "utf8",
    );
    const proc = spawn("node", [workerPath, jobPath], { detached: true, stdio: "ignore" });
    proc.unref();
    return { state: "working" as const };
  },

  async finishClipRender(args) {
    const out = `${args.workPrefix}.mp4`;
    const done = `${args.workPrefix}.done`;
    const err = `${args.workPrefix}.err`;
    const lock = `${args.workPrefix}.lock`;
    if (await exists(err)) {
      await cleanupRenderFiles(args.workPrefix);
      return { state: "error" as const, bytes: 0, progress: 0 };
    }
    if (await exists(done)) {
      // Report the size ONLY and leave every file in place: the action
      // collects the MP4 through readClipRenderChunk and calls
      // discardClipRender once the blob is stored. Deleting here (the
      // old behavior) destroyed finished renders whenever collection
      // failed, forcing a full re-render on every retry.
      let size = 0;
      try {
        size = (await stat(out)).size;
      } catch {
        size = 0;
      }
      // 320 MB sanity cap (was 160): v10 renders at crf 18 with the
      // medium preset from the 1080p source, so a long clip's MP4 is
      // considerably bigger than the old crf 21/25 files and could
      // otherwise trip this cap and be thrown away as an "error".
      if (size === 0 || size > 320 * 1024 * 1024) {
        await cleanupRenderFiles(args.workPrefix);
        return { state: "error" as const, bytes: size, progress: 0 };
      }
      return { state: "done" as const, bytes: size, progress: 100 };
    }
    if (await exists(lock)) {
      const last = await lastActivityMs(args.workPrefix);
      if (last != null && Date.now() - last >= STALL_MS) {
        // The worker died without leaving a marker (the old freeze at
        // 38%): wipe the corpse and report "none" so the caller's same
        // request starts a fresh render instead of polling a ghost.
        await cleanupRenderFiles(args.workPrefix);
        return { state: "none" as const, bytes: 0, progress: 0 };
      }
      const ffProgress = await readFfmpegProgress(args.workPrefix);
      if (ffProgress != null) {
        return { state: "working" as const, bytes: 0, progress: ffProgress };
      }
      const stored = await readStoredProgress(args.workPrefix);
      if (stored != null) {
        return { state: "working" as const, bytes: 0, progress: stored };
      }
      // No progress file yet: estimate gently from how long the lock
      // has lived so the number still moves on the very first polls.
      let progress = 5;
      try {
        const st = await stat(lock);
        const elapsedSec = Math.max(0, (Date.now() - st.mtimeMs) / 1000);
        progress = Math.min(38, Math.round(5 + elapsedSec * 1.5));
      } catch {
        progress = 5;
      }
      return { state: "working" as const, bytes: 0, progress };
    }
    return { state: "none" as const, bytes: 0, progress: 0 };
  },

  async readClipRenderChunk(args) {
    const out = `${args.workPrefix}.mp4`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(out, "r");
      const st = await handle.stat();
      const total = st.size;
      if (args.offset >= total) return { base64: "", totalBytes: total, eof: true };
      const len = Math.min(args.length, total - args.offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, args.offset);
      const slice = bytesRead === len ? buf : buf.subarray(0, bytesRead);
      return {
        base64: Buffer.from(slice).toString("base64"),
        totalBytes: total,
        eof: args.offset + bytesRead >= total,
      };
    } catch {
      return { base64: "", totalBytes: 0, eof: true };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  },

  async discardClipRender(args) {
    await cleanupRenderFiles(args.workPrefix);
    return { ok: true };
  },

  async startLiveWatch(args) {
    const done = `${args.workPrefix}.done`;
    const err = `${args.workPrefix}.err`;
    const lock = `${args.workPrefix}.lock`;
    // A finished or failed watch restarts FRESH: its buckets were
    // already consumed by makeLiveClips (or are worthless), and
    // returning "done" here would leave the user unable to listen
    // again. The action tells the user a new listen clears the old
    // one.
    if ((await exists(done)) || (await exists(err))) {
      await cleanupLiveFiles(args.workPrefix);
    }
    if (await exists(lock)) {
      // A live listener keeps writing its progress file at least once
      // per chat poll; a silent lock belongs to a dead watch — clear
      // it and start fresh instead of reporting "watching" forever.
      let last: number | null = null;
      for (const suffix of [".lock", ".progress.json"]) {
        try {
          const st = await stat(`${args.workPrefix}${suffix}`);
          if (last == null || st.mtimeMs > last) last = st.mtimeMs;
        } catch {
          // File does not exist (yet).
        }
      }
      if (last != null && Date.now() - last < LIVE_STALL_MS) return { state: "working" as const };
      await cleanupLiveFiles(args.workPrefix);
    }
    await mkdir(dirname(args.workPrefix), { recursive: true });
    await writeFile(lock, String(Date.now()));
    await writeFile(
      `${args.workPrefix}.progress.json`,
      JSON.stringify({
        state: "watching",
        messagesTotal: 0,
        startedAtMs: Date.now(),
        anchorExact: args.anchorExact,
        endReason: "",
        buckets: [],
      }),
    ).catch(() => {});
    // (Re)write the worker so a running artifact always uses the
    // current listener, then hand it the job and detach.
    const workerPath = `${dirname(args.workPrefix)}/live-worker.mjs`;
    await writeFile(workerPath, LIVE_WORKER_SOURCE, "utf8");
    const jobPath = `${args.workPrefix}.job.json`;
    await writeFile(
      jobPath,
      JSON.stringify({
        videoId: args.videoId,
        workPrefix: args.workPrefix,
        apiKey: args.apiKey,
        continuation: args.continuation,
        clientVersion: args.clientVersion,
        streamStartEpochMs: args.streamStartEpochMs,
        anchorExact: args.anchorExact,
        maxMinutes: args.maxMinutes,
      }),
      "utf8",
    );
    const proc = spawn("node", [workerPath, jobPath], { detached: true, stdio: "ignore" });
    proc.unref();
    return { state: "working" as const };
  },

  async readLiveWatch(args) {
    const empty = {
      messagesTotal: 0,
      elapsedSec: 0,
      anchorExact: false,
      endReason: "",
      buckets: [] as {
        startSec: number;
        count: number;
        top: string[];
        samples: string[];
      }[],
    };
    let snap: LiveSnap | null = null;
    try {
      const raw = await readFile(`${args.workPrefix}.progress.json`, "utf8");
      snap = JSON.parse(raw) as LiveSnap;
    } catch {
      snap = null;
    }
    const data = {
      messagesTotal: typeof snap?.messagesTotal === "number" ? snap.messagesTotal : 0,
      elapsedSec:
        typeof snap?.startedAtMs === "number"
          ? Math.max(0, Math.round((Date.now() - snap.startedAtMs) / 1000))
          : 0,
      anchorExact: snap?.anchorExact === true,
      endReason: typeof snap?.endReason === "string" ? snap.endReason : "",
      buckets: Array.isArray(snap?.buckets) ? snap.buckets : [],
    };
    if (await exists(`${args.workPrefix}.err`)) {
      return { state: "error" as const, ...data };
    }
    if (await exists(`${args.workPrefix}.done`)) {
      return { state: "done" as const, ...data };
    }
    if (await exists(`${args.workPrefix}.lock`)) {
      let last: number | null = null;
      for (const suffix of [".lock", ".progress.json"]) {
        try {
          const st = await stat(`${args.workPrefix}${suffix}`);
          if (last == null || st.mtimeMs > last) last = st.mtimeMs;
        } catch {
          // File does not exist (yet).
        }
      }
      if (last != null && Date.now() - last >= LIVE_STALL_MS) {
        // The listener died without leaving a marker: wipe the corpse
        // and report "none" so the user's next tap starts a fresh one.
        await cleanupLiveFiles(args.workPrefix);
        return { state: "none" as const, ...empty };
      }
      return { state: "watching" as const, ...data };
    }
    if (snap) return { state: "done" as const, ...data };
    return { state: "none" as const, ...empty };
  },

  async stopLiveWatch(args) {
    if (await exists(`${args.workPrefix}.lock`)) {
      await writeFile(`${args.workPrefix}.stop`, String(Date.now())).catch(() => {});
    }
    return { ok: true };
  },

  async discardLiveWatch(args) {
    await cleanupLiveFiles(args.workPrefix);
    return { ok: true };
  },
});
