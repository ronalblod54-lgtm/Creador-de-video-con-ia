import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, getStoredAuthToken, setStoredAuthToken, type ApiResponse } from "./api";
import appIcon from "./assets/app-icon-192.png";

type Library = ApiResponse<typeof api, "listLibrary">;
type Project = Library["creators"][number]["projects"][number];
type Clip = Project["clips"][number];
type ChannelResult = ApiResponse<typeof api, "resolveChannel">;
type MySpace = ApiResponse<typeof api, "getMySpace">;
type AdminAccount = ApiResponse<typeof api, "listAccountsAdmin">["accounts"][number];
type AdminLibrary = ApiResponse<typeof api, "adminListLibrary">;

type Options = { minSec: number; maxSec: number; minScore: number; clipCount: number };

const DEFAULT_OPTIONS: Options = { minSec: 30, maxSec: 90, minScore: 0, clipCount: 5 };

// The option inputs are free-form numbers: a cleared field reads as 0
// and a typed value can fall outside the server's accepted ranges,
// which used to fail the analysis with a misleading "connection
// failed" message. Clamp everything to the valid ranges (with the
// defaults as fallback) before any analysis request leaves the app.
function sanitizeOptions(o: Options): Options {
  const clamp = (n: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  return {
    minSec: clamp(o.minSec, 10, 300, DEFAULT_OPTIONS.minSec),
    maxSec: clamp(o.maxSec, 15, 600, DEFAULT_OPTIONS.maxSec),
    minScore: Number.isFinite(o.minScore)
      ? Math.min(100, Math.max(0, Math.round(o.minScore)))
      : 0,
    clipCount: clamp(o.clipCount, 1, 10, DEFAULT_OPTIONS.clipCount),
  };
}

const STAGES = [
  "Leyendo el video de YouTube…",
  "Bajando los subtítulos…",
  "La IA está buscando los mejores momentos…",
  "Puntuando cada clip…",
  "Guardando en tu biblioteca…",
];

function parseTimeInput(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number.parseFloat(v);
  const parts = v.split(":").map((p) => Number(p));
  if (parts.length > 3 || parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function scoreClasses(score: number): string {
  if (score >= 90) return "bg-[var(--hot)] text-white";
  if (score >= 70) return "bg-[var(--accent)] text-white";
  if (score >= 50) return "bg-[var(--accent-soft)] text-[var(--accent-strong)]";
  return "bg-[var(--surface-alt)] text-[var(--dim)]";
}

function clipCutText(project: Project, clip: Clip): string {
  const head = [
    `CLIP: ${clip.title}`,
    `Video: ${project.title} — ${project.creator}`,
    `Corta en CapCut: importa el video y corta de ${clip.startLabel} a ${clip.endLabel} (dura ${clip.durationLabel}).`,
    `Míralo en el segundo exacto: ${clip.watchUrl}`,
    "",
  ];
  // Live clips carry the chat's real messages as their caption lines
  // (burned into the MP4 in the TikTok style): the guide includes them
  // under their own honest label, after the spike explanation.
  if (project.isLive) {
    const parts = [
      ...head,
      "Por qué salió este clip (la explosión del chat en ese momento):",
      clip.reason,
      "",
      "Lo que se leía en el chat:",
      clip.excerpt,
    ];
    if (clip.subtitlesText.trim()) {
      parts.push(
        "",
        "Texto del chat quemado como subtítulos en el MP4 (con su segundo):",
        clip.subtitlesText,
      );
    }
    return parts.join("\n");
  }
  return [
    ...head,
    "Subtítulos con tiempo (pega y sincroniza en CapCut):",
    clip.subtitlesText,
  ].join("\n");
}

// ------------------------------------------- direct MP4 download to device

// Fetch the MP4 bytes INTO the page, with progress. Everything that
// hands the file to the phone (share sheet, save link, in-app player)
// works from these local bytes — see shareMp4Blob for why the fetch
// must finish BEFORE the user's tap, never inside it.
async function fetchBlobWithProgress(
  url: string,
  onProgress: (pct: number) => void,
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body?.getReader();
  if (!reader) {
    const blob = await res.blob();
    onProgress(100);
    return blob;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)));
    }
  }
  onProgress(100);
  return new Blob(chunks as unknown as BlobPart[], { type: "video/mp4" });
}

// Hand the MP4 file to the phone's own share sheet, where "Guardar en
// Archivos / galería" lives. The bytes must ALREADY be in the app when
// this runs: share() has to be called inside the user's tap, and the
// old flow fetched 20+ MB first — on the user's slow connection the
// tap's user-activation expired during the fetch and the browser
// refused to open the share menu, which the app then misreported as
// "Este navegador no deja compartir el archivo" (the error in his
// screenshot) even though his browser does support sharing files.
// This function calls nav.share() synchronously from the tap: the
// File is built from the in-app blob and share() is invoked before
// the first await suspends.
type FileShareNavigator = Navigator & {
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>;
};

async function shareMp4Blob(
  blob: Blob,
  fileName: string,
  text: string,
): Promise<"shared" | "cancelled" | "unsupported" | "failed"> {
  const nav = navigator as FileShareNavigator;
  if (!nav.share) return "unsupported";
  const file = new File([blob], fileName, { type: "video/mp4" });
  if (nav.canShare && !nav.canShare({ files: [file] })) return "unsupported";
  try {
    await nav.share({ files: [file], title: fileName, text });
    return "shared";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    return "failed";
  }
}

// ------------------------------------------------------------ file downloads

function srtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(ms).padStart(3, "0")}`;
}

function clipSrt(clip: Clip): string {
  const lines = clip.subtitlesText
    .split("\n")
    .map((line) => {
      const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (!m) return null;
      const at = parseTimeInput(m[1] ?? "");
      const text = (m[2] ?? "").trim();
      return at != null && text ? { at, text } : null;
    })
    .filter((x): x is { at: number; text: string } => x !== null);
  return lines
    .map((line, i) => {
      // Rebase cue times so the .srt starts at 0 for the cut clip.
      const start = Math.max(0, line.at - clip.startSec);
      const next = lines[i + 1];
      const end = next
        ? Math.max(start + 0.4, next.at - clip.startSec)
        : Math.max(start + 0.4, clip.endSec - clip.startSec);
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${line.text}`;
    })
    .join("\n\n");
}

function safeFileName(title: string): string {
  const clean = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "clip";
}

// Text-file downloads (.srt / .txt) are rendered as REAL <a download>
// links whose href is a pre-built object URL, not a programmatic
// a.click(): a real link tapped by the user's own finger is honored by
// phone webviews that silently ignore JavaScript-triggered downloads.
function useTextFileUrl(content: string, mime: string): string {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` })),
    [content, mime],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

// ---------------------------------------------------------------- progress

function AnalysisProgress() {
  const [pct, setPct] = useState(4);
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      // Ease toward 92% and hold there until the real result lands.
      const target = 92 * (1 - Math.exp(-elapsed / 28));
      setPct((p) => Math.max(p, Math.min(92, Math.round(target))));
      setStage(Math.min(STAGES.length - 1, Math.floor(elapsed / 9)));
    }, 400);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="flex items-end justify-between gap-3">
        <p className="text-sm font-medium text-[var(--text)]">{STAGES[stage]}</p>
        <p className="text-3xl font-extrabold leading-none text-[var(--accent-strong)]">{pct}%</p>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--surface-alt)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        Un video largo puede tardar un minuto o más. No cierres la app.
      </p>
    </div>
  );
}

// ------------------------------------------------- render progress overlay

// Cutting progress, the way the user asked for it: the video itself
// appears (vertical 9:16 preview of the clip) and the % rides ON TOP of
// the picture — big number centered over the video, stage label and a
// thin bar along the bottom edge of the frame — instead of a % tucked
// into a button label or a separate bar below the card.
function ClipRenderOverlay({
  progress,
  stage,
  thumbnailUrl,
  title,
  burnCaptions = true,
}: {
  progress: number;
  stage: string;
  thumbnailUrl: string | null;
  title: string;
  burnCaptions?: boolean;
}) {
  return (
    <div className="mt-3">
      <div
        className="relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-xl bg-black"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label={`Cortando el clip: ${progress} por ciento`}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
        <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
          <p className="text-6xl font-extrabold leading-none text-white [text-shadow:0_2px_14px_rgba(0,0,0,0.85)]">
            {progress}%
          </p>
          <p className="mt-3 text-sm font-semibold leading-snug text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.85)]">
            {stage}
          </p>
          <p className="mt-2 line-clamp-2 text-xs font-medium leading-snug text-white/85 [text-shadow:0_1px_8px_rgba(0,0,0,0.85)]">
            {title}
          </p>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-2 bg-white/25" aria-hidden="true">
          <div
            className="h-full bg-[var(--hot)] transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <p className="mt-2 text-center text-xs leading-relaxed text-[var(--dim)]" role="status" aria-live="polite">
        {burnCaptions
          ? "Estoy cortando el video en vertical 9:16 HD (1080×1920) y quemándole los subtítulos dentro."
          : "Estoy cortando el video en vertical 9:16 HD (1080×1920) con el video completo de la casa."}{" "}
        Puede tardar de unos segundos a un par de minutos según el largo del clip; no cierres la app.
      </p>
    </div>
  );
}

// ------------------------------------------------- media (photos/videos)
// permission system
//
// "Que tenga sistema de permiso de la app con fotos y videos": before
// Creador de clips con IA saves anything to the phone, the user grants the photos &
// videos permission inside the app. The grant lives in localStorage and
// gates every flow that writes media to the device (MP4 download and
// the TikTok share/save). Granted the user can revoke it at any time
// from the permissions card; while it is blocked, downloads stop with
// the exact steps to allow it again in the phone's settings. The app
// only ever SAVES the clips the user taps to download — it never reads
// the user's existing photos or videos.

type MediaPermission = "granted" | "denied" | "unknown";

const MEDIA_PERMISSION_KEY = "samuelclip-media-permission";
const MEDIA_PERMISSION_EVENT = "samuelclip-media-permission-changed";

function readMediaPermission(): MediaPermission {
  try {
    const v = window.localStorage.getItem(MEDIA_PERMISSION_KEY);
    return v === "granted" || v === "denied" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

function writeMediaPermission(value: MediaPermission): void {
  try {
    window.localStorage.setItem(MEDIA_PERMISSION_KEY, value);
  } catch {
    // Private mode etc.: the in-memory event below still updates the UI.
  }
  window.dispatchEvent(new Event(MEDIA_PERMISSION_EVENT));
}

function useMediaPermission(): MediaPermission {
  const [state, setState] = useState<MediaPermission>(() => readMediaPermission());
  useEffect(() => {
    const onChange = () => setState(readMediaPermission());
    window.addEventListener(MEDIA_PERMISSION_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(MEDIA_PERMISSION_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return state;
}

// Grant flow: ask the browser for persistent storage (the web's real
// grantable storage permission, best-effort) and record the user's
// photos & videos consent as granted.
async function grantMediaPermission(): Promise<void> {
  try {
    if (navigator.storage && typeof navigator.storage.persist === "function") {
      await navigator.storage.persist();
    }
  } catch {
    // Not grantable here; the in-app consent still governs the flows.
  }
  writeMediaPermission("granted");
}

const MEDIA_DENIED_HINT =
  "El permiso de fotos y videos está bloqueado, así que no puedo guardar el clip. Actívalo en la tarjeta «Permiso de fotos y videos» de arriba, o en tu teléfono: Ajustes → Apps → Creador de clips con IA (o tu navegador) → Permisos → Fotos y videos → Permitir.";

function MediaPermissionDialog({
  onAllow,
  onCancel,
}: {
  onAllow: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Permiso de fotos y videos"
      className="mt-3 rounded-xl border-2 border-[var(--accent)] bg-[var(--accent-soft)] p-3"
    >
      <p className="text-sm font-extrabold text-[var(--text)]">
        ¿Permitir que Creador de clips con IA guarde fotos y videos en tu teléfono?
      </p>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
        Solo guarda los MP4 de los clips que tú tocas para descargar, directo en tu galería o
        Descargas. No lee ni toca las fotos y videos que ya tienes. Puedes quitar el permiso cuando
        quieras desde la tarjeta «Permiso de fotos y videos».
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAllow}
          className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white"
        >
          Permitir guardar fotos y videos
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}

// The permissions card: shows the current state of the photos & videos
// permission and lets the user grant or revoke it at any time, with
// the phone-settings steps when it is blocked.
function MediaPermissionsCard() {
  const permission = useMediaPermission();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onAllow() {
    await grantMediaPermission();
    setAsking(false);
    setNote("Permiso activado: Creador de clips con IA ya puede guardar tus clips en tu galería.");
  }

  function onRevoke() {
    writeMediaPermission("denied");
    setAsking(false);
    setNote("Permiso quitado: Creador de clips con IA no guardará nada en tu teléfono hasta que lo actives otra vez.");
  }

  const statusLabel =
    permission === "granted"
      ? "Activado"
      : permission === "denied"
        ? "Bloqueado"
        : "Sin activar";
  const statusClasses =
    permission === "granted"
      ? "bg-[var(--used)] text-white"
      : permission === "denied"
        ? "bg-[var(--danger)] text-white"
        : "bg-[var(--surface-alt)] text-[var(--dim)]";

  return (
    <section
      aria-label="Permiso de fotos y videos"
      className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-extrabold leading-snug text-[var(--text)]">
          Permiso de fotos y videos
        </h2>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${statusClasses}`}
          role="status"
        >
          {statusLabel}
        </span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
        Creador de clips con IA te pide este permiso para guardar en tu galería los clips que descargas — nada
        más. Nunca lee las fotos ni los videos que ya tienes en el teléfono, y sin el permiso
        ningún clip en video se guarda.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {permission !== "granted" && (
          <button
            type="button"
            onClick={() => setAsking((v) => !v)}
            aria-expanded={asking}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white"
          >
            Activar permiso de fotos y videos
          </button>
        )}
        {permission === "granted" && (
          <button
            type="button"
            onClick={onRevoke}
            className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
          >
            Quitar permiso
          </button>
        )}
      </div>
      {asking && permission !== "granted" && (
        <MediaPermissionDialog
          onAllow={onAllow}
          onCancel={() => setAsking(false)}
        />
      )}
      {permission === "denied" && !asking && (
        <div className="mt-3 rounded-xl bg-[var(--accent-soft)] p-3 text-sm leading-relaxed text-[var(--text)]">
          <p className="font-semibold">Si tu teléfono lo bloqueó, actívalo así:</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>Abre <strong>Ajustes</strong> de tu teléfono → <strong>Apps</strong>.</li>
            <li>Busca <strong>Creador de clips con IA</strong> (o tu navegador, si aún no instalaste la app).</li>
            <li>Toca <strong>Permisos</strong> → <strong>Fotos y videos</strong> → <strong>Permitir</strong>.</li>
          </ol>
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            En iPhone: Ajustes → Creador de clips con IA (o Safari/Chrome) → Fotos → Acceso total. Y dale también
            a «Activar permiso» aquí arriba para que la app lo registre.
          </p>
        </div>
      )}
      {note && (
        <p role="status" className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
          {note}
        </p>
      )}
    </section>
  );
}

// --------------------------------------------------------------- clip card

function ClipCard({ project, clip }: { project: Project; clip: Clip }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [watching, setWatching] = useState(false);
  const [downloaded, setDownloaded] = useState<"srt" | "txt" | "mp4" | null>(null);
  const [mp4Error, setMp4Error] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [title, setTitle] = useState(clip.title);
  const [startText, setStartText] = useState(clip.startLabel);
  const [endText, setEndText] = useState(clip.endLabel);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["library"] });

  const usedMutation = useMutation({
    mutationFn: (used: boolean) => api.setClipUsed({ clipId: clip.id, used }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteClip({ clipId: clip.id }),
    onSuccess: invalidate,
  });
  const [preparingMp4, setPreparingMp4] = useState(false);
  const [permAsk, setPermAsk] = useState<"mp4" | "tiktok" | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const preparingRef = useRef(false);
  const [editingTikTok, setEditingTikTok] = useState(false);
  const [ttTitleEdit, setTtTitleEdit] = useState("");
  const [ttTagsEdit, setTtTagsEdit] = useState("");
  const [ttError, setTtError] = useState<string | null>(null);
  const [ttNote, setTtNote] = useState<string | null>(null);
  const [ttShowOpenLink, setTtShowOpenLink] = useState(false);
  const [ttCopied, setTtCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareProgress, setShareProgress] = useState(0);
  // The rendered MP4 for this clip, once it exists: either the one the
  // library already carries (clip.videoUrl) or the one a cut in this
  // session just produced. It drives the in-app <video> player and the
  // real download link in the save panel below — the two routes that
  // keep working when the phone's webview blocks the YouTube embed or
  // swallows programmatic downloads.
  const [readyMp4, setReadyMp4] = useState<{ url: string; fileName: string } | null>(null);
  const mp4Url = readyMp4?.url ?? clip.videoUrl;
  const mp4FileName = readyMp4?.fileName ?? `${safeFileName(clip.title)}-9x16.mp4`;
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // The MP4 bytes fetched INTO the app (blob + object URL). Sharing and
  // the direct-save link both act on these local bytes: the share menu
  // must open the instant the user taps (browsers cancel share() when
  // it is called after a long fetch — the user's "no deja compartir"
  // error), and an object-URL link tapped by the user's own finger is
  // honored where a programmatic download is dropped.
  type LocalMp4 = { objectUrl: string; blob: Blob; fileName: string };
  const [localMp4, setLocalMp4] = useState<LocalMp4 | null>(null);
  const localMp4Ref = useRef<LocalMp4 | null>(null);
  const localFetchRef = useRef<Promise<LocalMp4> | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const savePanelRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Absolute form of the stored MP4 URL, used only as the fallback
  // href of the direct-save link when the bytes are not in the app
  // yet. NOTE: this is the app session's own internal address — it is
  // NOT a public link and the phone's real browser cannot open it,
  // which is why there is no "open in the browser" route anymore (the
  // user tapped it and nothing happened). Every working route stays
  // inside this webview: share sheet, direct-save link, native player.
  const absMp4Url = useMemo(() => {
    if (!mp4Url) return null;
    try {
      return new URL(mp4Url, document.baseURI).href;
    } catch {
      return mp4Url;
    }
  }, [mp4Url]);
  useEffect(() => {
    return () => {
      if (localMp4Ref.current) URL.revokeObjectURL(localMp4Ref.current.objectUrl);
    };
  }, []);
  // When the clip's times are corrected, the server drops its stored
  // render — and this card must drop its copy too. Without this, the
  // save panel kept offering the OLD cut's bytes (already fetched into
  // the app) as if they were the corrected clip (found in the
  // 2026-11-09 full review).
  const timesKeyRef = useRef(`${clip.startSec}-${clip.endSec}`);
  useEffect(() => {
    const key = `${clip.startSec}-${clip.endSec}`;
    if (timesKeyRef.current === key) return;
    timesKeyRef.current = key;
    if (localMp4Ref.current) {
      URL.revokeObjectURL(localMp4Ref.current.objectUrl);
      localMp4Ref.current = null;
    }
    localFetchRef.current = null;
    setLocalMp4(null);
    setReadyMp4(null);
    setSaveNote(null);
  }, [clip.startSec, clip.endSec]);
  const srtUrl = useTextFileUrl(clipSrt(clip), "application/x-subrip");
  const guideUrl = useTextFileUrl(clipCutText(project, clip), "text/plain");

  const genTikTok = useMutation({
    mutationFn: () => api.generateTikTokCaption({ clipId: clip.id }),
    onSuccess: (res) => {
      if (res.ok) {
        setTtError(null);
        setTtNote("La IA te hizo un título nuevo para este clip. Los # son siempre los mismos 5.");
        invalidate();
      } else {
        setTtError(res.error ?? "No pude crear el texto de TikTok.");
      }
    },
    onError: () => setTtError("No pude crear el texto de TikTok. Inténtalo de nuevo."),
  });
  const saveTikTok = useMutation({
    mutationFn: () =>
      api.updateTikTokCaption({
        clipId: clip.id,
        tiktokTitle: ttTitleEdit.trim(),
        tiktokHashtags: ttTagsEdit,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setEditingTikTok(false);
        setTtError(null);
        invalidate();
      } else {
        setTtError(res.error ?? "No pude guardar el texto de TikTok.");
      }
    },
    onError: () => setTtError("No pude guardar el texto de TikTok. Inténtalo de nuevo."),
  });

  // The server cuts the MP4 in the background; poll until it is ready.
  // Each poll returns the real cutting progress (segment download +
  // ffmpeg encoding) as a %. Shared by the direct download and by the
  // TikTok publish flow, so both ride the same render.
  async function ensureClipMp4(
    onProgress: (n: number) => void,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    // A single poll that fails on the network must NOT kill the flow:
    // the cut keeps running on the server, so we retry the poll and
    // only give up after several failures in a row (the user hit the
    // old give-up-on-first-failure message while his connection was
    // busy with a live stream in another app).
    // 300 polls x 3s = 15 minutes of budget: the v10 quality encode
    // (x264 medium/crf 18) is slower than the old one, and a long clip
    // on a slow connection needs the room. The cut keeps running on
    // the server regardless; running out of polls only means the user
    // taps once more to collect it.
    let consecutiveFailures = 0;
    for (let attempt = 0; attempt < 300; attempt++) {
      let res: Awaited<ReturnType<typeof api.prepareClipDownload>>;
      try {
        res = await api.prepareClipDownload({ clipId: clip.id });
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 6) {
          throw new Error(
            "La conexión falló preparando el MP4. El corte sigue en el servidor: toca el botón otra vez para seguir donde iba.",
          );
        }
        await new Promise((r) => window.setTimeout(r, 3000));
        continue;
      }
      if (typeof res.progress === "number" && Number.isFinite(res.progress)) {
        onProgress(res.ok ? 100 : Math.min(99, Math.round(res.progress)));
      }
      if (res.ok && res.downloadUrl) {
        onProgress(100);
        return {
          downloadUrl: res.downloadUrl,
          fileName: res.fileName || `${safeFileName(clip.title)}-9x16.mp4`,
        };
      }
      if (!res.rendering) {
        throw new Error(res.error ?? "No pude preparar el MP4. Inténtalo de nuevo.");
      }
      await new Promise((r) => window.setTimeout(r, 3000));
    }
    throw new Error("El corte está tardando demasiado. Toca el botón otra vez para seguir donde iba.");
  }

  // Bring the MP4 bytes into the app once (with progress) so the share
  // tap and the save link act instantly on local bytes. Cuts the clip
  // first when it has not been cut yet. Concurrent calls share one job.
  function ensureLocalMp4(): Promise<LocalMp4> {
    if (localMp4Ref.current) return Promise.resolve(localMp4Ref.current);
    if (localFetchRef.current) return localFetchRef.current;
    const job = (async (): Promise<LocalMp4> => {
      let url = mp4Url;
      let fileName = mp4FileName;
      if (!url) {
        const cut = await ensureClipMp4((n) => setLocalProgress(n));
        url = cut.downloadUrl;
        fileName = cut.fileName;
        setReadyMp4({ url, fileName });
      }
      setLocalBusy(true);
      setLocalProgress(0);
      try {
        const blob = await fetchBlobWithProgress(url, (n) => setLocalProgress(n));
        const entry: LocalMp4 = { objectUrl: URL.createObjectURL(blob), blob, fileName };
        localMp4Ref.current = entry;
        setLocalMp4(entry);
        return entry;
      } finally {
        setLocalBusy(false);
        localFetchRef.current = null;
      }
    })();
    localFetchRef.current = job;
    return job;
  }

  async function onDownloadMp4() {
    if (preparingRef.current) return;
    // Photos & videos permission gate: nothing is saved to the phone
    // until the user has granted it (asked here the first time).
    const perm = readMediaPermission();
    if (perm === "denied") {
      setMp4Error(MEDIA_DENIED_HINT);
      return;
    }
    if (perm !== "granted") {
      setMp4Error(null);
      setPermAsk("mp4");
      return;
    }
    preparingRef.current = true;
    setPreparingMp4(true);
    setRenderProgress(3);
    setMp4Error(null);
    setSaveNote(null);
    try {
      // Cut first if needed (background render, polled with progress).
      if (!mp4Url) {
        const { downloadUrl, fileName } = await ensureClipMp4((n) =>
          setRenderProgress((p) => Math.max(p, n)),
        );
        setReadyMp4({ url: downloadUrl, fileName });
      }
      setWatching(true);
      // Then bring the bytes into the app. We do NOT claim the file was
      // saved automatically here: silent programmatic saves are exactly
      // what this phone's webview kept dropping while the app said
      // "saved". With the bytes in the app, the save panel below saves
      // for real: its share button opens the phone's own menu inside
      // the tap, and its link is a real user-tapped download.
      await ensureLocalMp4();
      invalidate();
      window.setTimeout(
        () => savePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
        350,
      );
    } catch (err) {
      setMp4Error(
        err instanceof Error ? err.message : "La conexión falló preparando el MP4. Inténtalo de nuevo.",
      );
    } finally {
      preparingRef.current = false;
      setPreparingMp4(false);
      window.setTimeout(() => setRenderProgress(0), 4000);
    }
  }

  // ---------------------------------------------------------- TikTok post

  async function onCopyTikTok() {
    const ok = await copyText(clip.tiktokText);
    setTtCopied(ok);
    if (!ok) setTtError("No pude copiar el texto. Mantenlo presionado y cópialo a mano.");
    window.setTimeout(() => setTtCopied(false), 2500);
  }

  function openTikTokEditor() {
    setTtTitleEdit(clip.tiktokTitle);
    setTtTagsEdit(clip.tiktokHashtags);
    setTtError(null);
    setEditingTikTok(true);
  }

  function onSaveTikTok(e: FormEvent) {
    e.preventDefault();
    if (!ttTitleEdit.trim()) {
      setTtError("El título de TikTok no puede quedar vacío.");
      return;
    }
    saveTikTok.mutate();
  }

  // One tap: copy the post text, cut (or reuse) the MP4, and hand the
  // video file to the phone's share sheet so the user picks TikTok and
  // the clip lands in the app's own publish screen. TikTok offers no
  // silent background posting to third-party apps, so the final
  // "Publicar" tap stays in TikTok itself; where the share sheet cannot
  // take files, fall back to saving the MP4 and opening TikTok with the
  // text already copied.
  async function onShareTikTok() {
    if (preparingRef.current || sharing) return;
    // Same photos & videos permission gate as the direct download:
    // the TikTok flow also saves/shares the MP4 file on the device.
    const perm = readMediaPermission();
    if (perm === "denied") {
      setTtError(MEDIA_DENIED_HINT);
      return;
    }
    if (perm !== "granted") {
      setTtError(null);
      setPermAsk("tiktok");
      return;
    }
    preparingRef.current = true;
    setSharing(true);
    setShareProgress(3);
    setTtError(null);
    setTtNote(null);
    setTtShowOpenLink(false);
    try {
      await copyText(clip.tiktokText);
      const hadLocal = localMp4Ref.current != null;
      if (!mp4Url) {
        const { downloadUrl, fileName } = await ensureClipMp4((n) =>
          setShareProgress((p) => Math.max(p, n)),
        );
        setReadyMp4({ url: downloadUrl, fileName });
      }
      const local = await ensureLocalMp4();
      if (!hadLocal) {
        // The bytes just arrived; share() must be called inside a fresh
        // tap or the browser cancels it, so ask for that tap instead of
        // failing with a confusing "browser can't share" error.
        setTtNote(
          "El video ya está dentro de la app y el título con los # ya van copiados. Toca «Subir a TikTok» otra vez y ahora sí se abre el menú de compartir para elegir TikTok.",
        );
        return;
      }
      const shareOutcome = await shareMp4Blob(local.blob, local.fileName, clip.tiktokText);
      if (shareOutcome === "cancelled") {
        setTtNote("Cancelaste el compartir. Tu título y tus # siguen copiados para cuando quieras.");
        return;
      }
      if (shareOutcome === "shared") {
        setTtNote(
          "Elige TikTok en el compartir: el video entra a su pantalla de publicar, pegas el título y los # (ya van copiados) y le das Publicar.",
        );
        invalidate();
        return;
      }
      // No window.open() here: a programmatic popup is exactly what
      // this phone's webview swallows ("no me deja abrir el navegador
      // ni nada"). Show a REAL link instead — a link tapped by the
      // user's own finger is what the shell honors for leaving the app.
      setTtShowOpenLink(true);
      setTtNote(
        "Este navegador no deja compartir el video directo a la app. El título y los # ya quedaron copiados: guarda el MP4 desde el panel «Tu MP4 ya está cortado» aquí arriba, toca «Abrir TikTok» aquí abajo y súbelo desde la app.",
      );
    } catch (err) {
      setTtError(
        err instanceof Error ? err.message : "La conexión falló preparando el MP4. Inténtalo de nuevo.",
      );
    } finally {
      preparingRef.current = false;
      setSharing(false);
      window.setTimeout(() => setShareProgress(0), 4000);
    }
  }

  // HERO save route (the user asked for sharing to work better so he
  // can save through it): hand the MP4 to the phone's share sheet,
  // where "Guardar en Archivos / galería" lives. The share() call must
  // happen inside the tap, with the bytes already in the app — fetching
  // first (20+ MB on a slow connection) expired the tap and the
  // browser refused to open the menu, which is the error in the user's
  // screenshot. So: the first tap brings the video in (with progress),
  // the next tap shares instantly.
  async function onShareSave() {
    if (!mp4Url) {
      void onDownloadMp4();
      return;
    }
    setSaveNote(null);
    if (!localMp4Ref.current) {
      try {
        await ensureLocalMp4();
        setSaveNote(
          "El MP4 ya está dentro de la app. Toca «Compartir / guardar el MP4» otra vez y se abre el menú de tu teléfono al instante: ahí eliges guardarlo en Archivos o en tu galería.",
        );
      } catch (err) {
        setSaveNote(
          `No pude bajar el MP4 a la app (${err instanceof Error ? err.message : "error desconocido"}). Revisa tu conexión y toca el botón otra vez.`,
        );
      }
      return;
    }
    const local = localMp4Ref.current;
    const outcome = await shareMp4Blob(local.blob, local.fileName, clip.tiktokText);
    if (outcome === "shared") {
      setSaveNote(
        "Se abrió el menú de compartir de tu teléfono: ahí lo guardas en Archivos o tu galería, o lo mandas directo a TikTok, WhatsApp, etc.",
      );
    } else if (outcome === "cancelled") {
      setSaveNote("Cancelaste el compartir. Tu MP4 sigue listo aquí para cuando quieras.");
    } else {
      setSaveNote(
        "Este navegador no deja compartir archivos. Toca «Abrir el video en grande» aquí mismo: el video ocupa toda la pantalla en el reproductor de tu teléfono y desde su menú ⋮ → Descargar lo guardas.",
      );
    }
  }

  function onFullscreen() {
    const v = videoRef.current;
    if (!v) return;
    try {
      const p = v.requestFullscreen?.();
      if (p && typeof p.catch === "function") void p.catch(() => undefined);
    } catch {
      // Some webviews refuse fullscreen from a button; the player's own
      // fullscreen control still works.
    }
  }

  // Permission dialog answers: allowing records the grant and resumes
  // the exact flow the user tapped (download or TikTok); declining
  // keeps the permission off and nothing is saved.
  async function onAllowMediaPermission() {
    const action = permAsk;
    await grantMediaPermission();
    setPermAsk(null);
    if (action === "mp4") void onDownloadMp4();
    else if (action === "tiktok") void onShareTikTok();
  }

  function onCancelMediaPermission() {
    const action = permAsk;
    setPermAsk(null);
    const msg =
      "Sin el permiso de fotos y videos no puedo guardar el clip en tu teléfono. Cuando quieras, actívalo en la tarjeta «Permiso de fotos y videos» de arriba.";
    if (action === "tiktok") setTtError(msg);
    else setMp4Error(msg);
  }

  const cuttingStage = project.isLive
    ? "Cortando el clip y quemando el texto del chat…"
    : "Cortando el clip y quemando los subtítulos…";
  const shareStage =
    shareProgress < 15
      ? "Buscando el video en HD…"
      : shareProgress < 40
        ? "Bajando el pedazo del video…"
        : shareProgress < 100
          ? cuttingStage
          : "¡Listo! Abriendo el compartir…";

  const renderStage =
    renderProgress < 15
      ? "Buscando el video en HD…"
      : renderProgress < 40
        ? "Bajando el pedazo del video…"
        : renderProgress < 100
          ? cuttingStage
          : "¡Listo! Guardando en tu dispositivo…";

  const updateMutation = useMutation({
    mutationFn: (args: { title: string; startSec: number; endSec: number }) =>
      api.updateClip({ clipId: clip.id, ...args }),
    onSuccess: (res) => {
      if (res.ok) {
        setEditing(false);
        setEditError(null);
        invalidate();
      } else {
        setEditError(res.error ?? "No pude guardar el cambio.");
      }
    },
    onError: () => setEditError("No pude guardar el cambio. Inténtalo de nuevo."),
  });

  function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    const startSec = parseTimeInput(startText);
    const endSec = parseTimeInput(endText);
    if (startSec == null || endSec == null) {
      setEditError("Escribe los tiempos como 1:25 o como segundos (85).");
      return;
    }
    if (!title.trim()) {
      setEditError("El título no puede quedar vacío.");
      return;
    }
    updateMutation.mutate({ title: title.trim(), startSec, endSec });
  }

  async function onCopy() {
    const ok = await copyText(clipCutText(project, clip));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 2500);
  }

  const embedUrl = `https://www.youtube-nocookie.com/embed/${project.videoId}?start=${Math.max(0, Math.floor(clip.startSec))}&end=${Math.max(1, Math.ceil(clip.endSec))}&rel=0&playsinline=1${watching ? "&autoplay=1" : ""}`;

  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl ${scoreClasses(clip.score)}`}
          aria-label={`Puntaje viral ${clip.score} de 100`}
        >
          <span className="text-xl font-extrabold leading-none">{clip.score}</span>
          <span className="text-[10px] font-medium leading-tight">/ 100</span>
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-base font-semibold leading-snug text-[var(--text)]">{clip.title}</h4>
          <p className="time-mono mt-1 text-sm text-[var(--dim)]">
            {clip.startLabel} → {clip.endLabel} · dura {clip.durationLabel} ·{" "}
            <span className="font-semibold text-[var(--accent-strong)]">vertical 9:16</span>
          </p>
          {clip.used === true && (
            <span className="mt-1 inline-block rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-semibold text-[var(--used)]">
              Ya lo usé
            </span>
          )}
        </div>
      </div>

      {clip.reason && <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">{clip.reason}</p>}
      {clip.excerpt && (
        <p className="mt-2 text-sm italic leading-relaxed text-[var(--dim)]">«{clip.excerpt}…»</p>
      )}

      {(preparingMp4 || sharing) && (
        <ClipRenderOverlay
          progress={sharing ? shareProgress : renderProgress}
          stage={sharing ? shareStage : renderStage}
          thumbnailUrl={project.thumbnailUrl}
          title={clip.title}
        />
      )}

      {watching && !preparingMp4 && !sharing && mp4Url && (
        <div className="mt-3">
          <div className="mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-xl bg-black">
            <video
              ref={videoRef}
              src={localMp4?.objectUrl ?? mp4Url}
              controls
              playsInline
              preload="metadata"
              className="h-full w-full"
              aria-label={`Video del clip ya cortado: ${clip.title}`}
            />
          </div>
          <div className="mt-2 text-center">
            <button
              type="button"
              onClick={onFullscreen}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
            >
              ⛶ Ver en pantalla completa
            </button>
          </div>
          <p className="mt-1.5 text-center text-xs leading-relaxed text-[var(--dim)]">
            Este es tu clip YA cortado:{" "}
            {project.isLive
              ? "MP4 vertical 9:16 con el video completo de la casa en el centro, su fondo borroso y el texto del chat de ese momento quemado como subtítulos estilo TikTok, tal cual lo vas a subir."
              : "MP4 vertical 9:16 con los subtítulos quemados dentro, la cámara de RDjavi arriba y el juego abajo, tal cual lo vas a subir."}{" "}
            En pantalla completa, el reproductor de tu teléfono trae su propio
            botón de descargar: menú <strong>⋮</strong> → <strong>Descargar</strong>. Y para
            guardarlo sin salir de aquí, usa el botón grande de <strong>Compartir</strong> del panel
            de abajo.
          </p>
        </div>
      )}

      {watching && !preparingMp4 && !sharing && !mp4Url && (
        <div className="mt-3">
          <div className="mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-xl bg-black">
            <iframe
              src={embedUrl}
              title={`Reproductor del clip: ${clip.title}`}
              className="h-full w-full"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
          <p className="mt-1.5 text-center text-xs text-[var(--dim)]">
            Estás viendo solo el clip: de {clip.startLabel} a {clip.endLabel}, en vertical 9:16 como
            el MP4 que descargas. Al llegar al fin se pausa; dale play de nuevo si quieres repetirlo.
          </p>
          <p className="mt-1.5 text-center text-xs leading-relaxed text-[var(--dim)]">
            ¿El video de YouTube no carga aquí dentro? Toca «⬇ Cortar y descargar MP4 9:16» y el
            clip cortado se abre en un reproductor propio de la app, sin depender de YouTube.
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onDownloadMp4}
          disabled={preparingMp4}
          className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
        >
          {preparingMp4
            ? "Cortando tu clip 9:16…"
            : localBusy
              ? "Bajando el MP4 a la app…"
              : clip.hasVideo
                ? "⬇ Descargar MP4 9:16 a mi galería"
                : "⬇ Cortar y descargar MP4 9:16"}
        </button>
        <button
          type="button"
          onClick={() => setWatching((v) => !v)}
          aria-expanded={watching}
          className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
        >
          {watching ? "Ocultar el clip" : "▶ Ver el clip aquí"}
        </button>
        {clip.subtitlesText.trim() && (
          <a
            href={srtUrl}
            download={`${safeFileName(clip.title)}.srt`}
            onClick={() => {
              setDownloaded("srt");
              window.setTimeout(() => setDownloaded(null), 2500);
            }}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
          >
            {downloaded === "srt" ? "¡Descargado!" : "⬇ Subtítulos .srt"}
          </a>
        )}
        <a
          href={guideUrl}
          download={`${safeFileName(clip.title)}.txt`}
          onClick={() => {
            setDownloaded("txt");
            window.setTimeout(() => setDownloaded(null), 2500);
          }}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          {downloaded === "txt" ? "¡Descargado!" : "⬇ Guía .txt"}
        </a>
        <a
          href={clip.watchUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          Ver en YouTube
        </a>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          {copied ? "¡Copiado!" : "Copiar texto para CapCut"}
        </button>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          Corregir tiempos
        </button>
        <button
          type="button"
          onClick={() => usedMutation.mutate(!clip.used)}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          {clip.used ? "Desmarcar usado" : "Marcar usado"}
        </button>
        {confirmDelete ? (
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            className="rounded-full bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white"
          >
            Sí, borrar clip
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--danger)]"
          >
            Borrar
          </button>
        )}
      </div>

      {permAsk && (
        <MediaPermissionDialog
          onAllow={onAllowMediaPermission}
          onCancel={onCancelMediaPermission}
        />
      )}

      {mp4Url && (
        <div
          ref={savePanelRef}
          className="mt-3 rounded-xl border-2 border-[var(--hot)] bg-[var(--accent-soft)] p-3"
        >
          <p className="text-sm font-extrabold text-[var(--text)]">
            🎬 Tu MP4 ya está cortado — compártelo y guárdalo
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            La forma que mejor funciona en tu teléfono es <strong>Compartir</strong>: se abre el
            menú de tu teléfono y eliges guardarlo en Archivos o en tu galería. Si el video todavía
            no está dentro de la app, el primer toque del botón lo baja (mira el %) y el segundo lo
            comparte al instante.
          </p>
          {localBusy && (
            <div className="mt-2" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-xs font-semibold text-[var(--text)]">
                <span>Bajando el MP4 a la app…</span>
                <span>{localProgress}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface)]">
                <div
                  className="h-full rounded-full bg-[var(--hot)] transition-[width] duration-300"
                  style={{ width: `${localProgress}%` }}
                />
              </div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onShareSave}
              disabled={localBusy}
              className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
            >
              {localBusy
                ? "Bajando el MP4…"
                : localMp4
                  ? "📤 Compartir / guardar el MP4"
                  : "📤 Bajar el MP4 y compartirlo"}
            </button>
            <a
              href={localMp4?.objectUrl ?? absMp4Url ?? mp4Url}
              download={mp4FileName}
              className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
            >
              ⬇ Guardar MP4 en mi teléfono
            </a>
            <a
              href={localMp4?.objectUrl ?? mp4Url}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
            >
              ▶ Abrir el video en grande
            </a>
            <button
              type="button"
              onClick={() => setWatching(true)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
            >
              ▶ Verlo aquí
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            ¿Compartir no abre en tu teléfono? Toca «Abrir el video en grande»: el MP4 ocupa toda
            la pantalla en el reproductor de tu teléfono, desde su menú <strong>⋮</strong> →{" "}
            <strong>Descargar</strong> lo guardas, y vuelves aquí con el botón atrás de tu
            teléfono. Tu clip queda guardado en esta biblioteca, no se pierde.
          </p>
          {saveNote && (
            <p role="status" className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
              {saveNote}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-3">
        <div className="flex items-center justify-between gap-2">
          <h5 className="text-sm font-extrabold text-[var(--text)]">Listo para TikTok</h5>
          {!clip.hasTikTokCaption && (
            <span className="text-xs font-medium text-[var(--dim)]">Sugerencia automática</span>
          )}
        </div>
        <p className="mt-2 text-sm font-semibold leading-snug text-[var(--text)]">
          {clip.tiktokTitle}
        </p>
        <p className="mt-1 text-sm font-semibold leading-relaxed text-[var(--accent-strong)]">
          {clip.tiktokHashtags}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onShareTikTok}
            disabled={sharing || preparingMp4}
            className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
          >
            {sharing ? "Preparando para TikTok…" : "⬆ Subir a TikTok"}
          </button>
          <button
            type="button"
            onClick={onCopyTikTok}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
          >
            {ttCopied ? "¡Copiado!" : "Copiar título + #"}
          </button>
          <button
            type="button"
            onClick={() => genTikTok.mutate()}
            disabled={genTikTok.isPending}
            className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-60"
          >
            {genTikTok.isPending ? "Creando con IA…" : "Crear otro título con IA"}
          </button>
          <button
            type="button"
            onClick={() => (editingTikTok ? setEditingTikTok(false) : openTikTokEditor())}
            aria-expanded={editingTikTok}
            className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
          >
            Editar texto
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
          Al tocar «Subir a TikTok» la app corta el clip si falta, copia el título y los # y abre el
          compartir del teléfono: eliges TikTok, pegas el texto y le das Publicar.
        </p>
        {sharing && (
          <p role="status" className="mt-3 text-sm font-medium text-[var(--text)]">
            Cortando el clip: el avance va arriba, sobre el video.
          </p>
        )}
        {ttNote && (
          <p role="status" className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
            {ttNote}
          </p>
        )}
        {ttShowOpenLink && (
          <a
            href="https://www.tiktok.com/"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block rounded-full bg-[var(--text)] px-4 py-2 text-sm font-semibold text-[var(--surface)]"
          >
            Abrir TikTok
          </a>
        )}
        {ttError && (
          <p role="alert" className="mt-2 text-sm font-medium text-[var(--danger)]">
            {ttError}
          </p>
        )}
        {editingTikTok && (
          <form onSubmit={onSaveTikTok} className="mt-3 rounded-xl bg-[var(--surface)] p-3">
            <label className="block text-xs font-semibold text-[var(--dim)]" htmlFor={`tt-title-${clip.id}`}>
              Título para TikTok
            </label>
            <input
              id={`tt-title-${clip.id}`}
              value={ttTitleEdit}
              onChange={(e) => setTtTitleEdit(e.target.value)}
              maxLength={220}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <label className="mt-3 block text-xs font-semibold text-[var(--dim)]" htmlFor={`tt-tags-${clip.id}`}>
              Hashtags (fijos en todos los clips)
            </label>
            <input
              id={`tt-tags-${clip.id}`}
              value={ttTagsEdit}
              readOnly
              aria-readonly="true"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--dim)]"
            />
            <button
              type="submit"
              disabled={saveTikTok.isPending}
              className="mt-3 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {saveTikTok.isPending ? "Guardando…" : "Guardar texto de TikTok"}
            </button>
          </form>
        )}
      </div>

      {mp4Error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--danger)]">
          {mp4Error}
        </p>
      )}

      {editing && (
        <form onSubmit={onSaveEdit} className="mt-4 rounded-xl bg-[var(--accent-soft)] p-3">
          <label className="block text-xs font-semibold text-[var(--dim)]" htmlFor={`title-${clip.id}`}>
            Título del clip
          </label>
          <input
            id={`title-${clip.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[var(--dim)]" htmlFor={`start-${clip.id}`}>
                Inicio (ej. 1:25)
              </label>
              <input
                id={`start-${clip.id}`}
                value={startText}
                onChange={(e) => setStartText(e.target.value)}
                inputMode="numeric"
                className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[var(--dim)]" htmlFor={`end-${clip.id}`}>
                Fin (ej. 2:10)
              </label>
              <input
                id={`end-${clip.id}`}
                value={endText}
                onChange={(e) => setEndText(e.target.value)}
                inputMode="numeric"
                className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
          </div>
          {editError && <p className="mt-2 text-sm font-medium text-[var(--danger)]">{editError}</p>}
          <button
            type="submit"
            disabled={updateMutation.isPending}
            className="mt-3 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {updateMutation.isPending ? "Guardando…" : "Guardar corrección"}
          </button>
        </form>
      )}
    </article>
  );
}

// ------------------------------------------------- live clips grid
//
// The live project's clips the way TalentClip shows them (the user's
// reference): a "Todos los clips" GRID of vertical 9:16 tiles — poster,
// score chip on the corner, duration chip, title underneath — instead
// of the long card list. Tapping a tile opens the full clip card
// (preview, time correction, MP4 cut, TikTok panel) right below the
// grid, which is the editor half of the reference.
function LiveClipsGrid({ project }: { project: Project }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = project.clips.find((c) => c.id === selectedId) ?? null;
  if (project.clips.length === 0) {
    return (
      <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
        Este directo todavía no tiene clips. En la pestaña «🔴 En vivo» la app escucha el chat
        sola y los clips van saliendo aquí cuando el chat explota.
      </p>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
        Todos los clips · {project.clips.length}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {project.clips.map((clip) => {
          const isSel = clip.id === selectedId;
          return (
            <div key={clip.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setSelectedId(isSel ? null : clip.id)}
                aria-expanded={isSel}
                aria-label={`Abrir el clip: ${clip.title}`}
                className={`relative block aspect-[9/16] w-full overflow-hidden rounded-xl bg-black text-left ${
                  isSel ? "ring-4 ring-[var(--hot)]" : "ring-1 ring-[var(--border)]"
                }`}
              >
                {project.thumbnailUrl ? (
                  <img
                    src={project.thumbnailUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs font-semibold text-white/80">
                    Directo de {project.creator}
                  </span>
                )}
                <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" aria-hidden="true" />
                <span
                  className={`absolute left-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-xs font-extrabold ${scoreClasses(clip.score)}`}
                  aria-label={`Puntaje ${clip.score} de 100`}
                >
                  {clip.score}
                </span>
                {clip.hasVideo && (
                  <span className="absolute right-1.5 top-1.5 rounded-md bg-[var(--used)] px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                    MP4 ✓
                  </span>
                )}
                <span className="time-mono absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white">
                  {clip.durationLabel}
                </span>
                <span className="absolute bottom-1.5 left-1.5 rounded-md bg-[var(--danger)] px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                  🔴 EN VIVO
                </span>
              </button>
              <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug text-[var(--text)]">
                {clip.title}
              </p>
              <p className="time-mono text-xs text-[var(--dim)]">
                {clip.startLabel} → {clip.endLabel}
                {clip.used ? " · ya lo usé" : ""}
              </p>
            </div>
          );
        })}
      </div>
      {selected ? (
        <div className="mt-4">
          <ClipCard project={project} clip={selected} />
        </div>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
          Toca un clip para abrirlo: ahí lo ves en el segundo exacto, corriges sus tiempos y lo
          cortas en MP4 vertical 9:16 para TikTok.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ project card

function ProjectCard({ project, options }: { project: Project; options: Options }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reNote, setReNote] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["library"] });

  const reanalyze = useMutation({
    mutationFn: () => api.reanalyzeProject({ projectId: project.id, ...sanitizeOptions(options) }),
    onSuccess: (res) => {
      if (res.ok) {
        setReNote(
          res.note ??
            (res.clipsFound > 0
              ? `Listo: ${res.clipsFound} clip(s) con las opciones actuales.`
              : "No salió ningún clip con estas opciones."),
        );
        invalidate();
      } else {
        setReNote(res.error ?? "No pude reanalizar.");
      }
    },
    onError: () => setReNote("No pude reanalizar. Inténtalo de nuevo."),
  });
  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject({ projectId: project.id }),
    onSuccess: invalidate,
  });

  return (
    <section className="mt-5">
      <div className="flex gap-3">
        {project.thumbnailUrl ? (
          <img
            src={project.thumbnailUrl}
            alt={`Miniatura de ${project.title}`}
            className="h-16 w-28 shrink-0 rounded-lg object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-alt)] px-2 text-center text-xs font-semibold text-[var(--dim)]">
            Sin miniatura
          </div>
        )}
        <div className="min-w-0">
          <h3 className="text-base font-bold leading-snug text-[var(--text)]">{project.title}</h3>
          <p className="time-mono mt-0.5 text-xs text-[var(--dim)]">
            Dura {project.durationLabel} · {project.clips.length} clip(s)
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {project.isLive ? (
              <span className="rounded-full bg-[var(--danger)] px-3 py-1 text-xs font-bold text-white">
                🔴 Proyecto del en vivo · clips del chat
              </span>
            ) : (
              <button
                type="button"
                onClick={() => reanalyze.mutate()}
                disabled={reanalyze.isPending}
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-semibold text-[var(--text)] disabled:opacity-60"
              >
                {reanalyze.isPending ? "Reanalizando…" : "Reanalizar con mis opciones"}
              </button>
            )}
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => deleteProject.mutate()}
                className="rounded-full bg-[var(--danger)] px-3 py-1 text-xs font-semibold text-white"
              >
                Sí, borrar video y clips
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-full px-3 py-1 text-xs font-semibold text-[var(--danger)]"
              >
                Borrar video
              </button>
            )}
          </div>
        </div>
      </div>
      {reNote && <p className="mt-2 text-sm font-medium text-[var(--accent-strong)]">{reNote}</p>}
      {project.isLive ? (
        <div className="mt-3">
          <LiveClipsGrid project={project} />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {project.clips.map((clip) => (
            <ClipCard key={clip.id} project={project} clip={clip} />
          ))}
          {project.clips.length === 0 && (
            <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
              Este video quedó sin clips con las opciones usadas. Baja el puntaje mínimo arriba y pulsa
              «Reanalizar con mis opciones».
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ install card

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// "Créame una aplicación para descargarla… solo para mí en mi teléfono":
// Creador de clips con IA installs onto the user's own phone as a home-screen app —
// its icon, full-screen window, the same system and the same saved
// library (the data lives in their account, so nothing moves). When the
// browser offers its native install dialog we use it; otherwise the
// card shows the exact steps for the phone's browser (Compartir / menú
// → Añadir a pantalla de inicio / Instalar app). Once the app is opened
// from the home-screen icon, the card confirms it instead of nagging.
function InstallAppCard() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => window.localStorage.getItem("samuelclip-install-dismissed") === "1",
  );
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const navStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setStandalone(mq.matches || navStandalone);
    const onMode = (e: MediaQueryListEvent) => setStandalone(e.matches);
    mq.addEventListener?.("change", onMode);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      mq.removeEventListener?.("change", onMode);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  async function onInstall() {
    if (deferred) {
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === "accepted") {
          setNote("Instalando Creador de clips con IA en tu teléfono… busca el ícono en tu pantalla principal.");
        } else {
          setShowSteps(true);
        }
      } catch {
        setShowSteps(true);
      }
      setDeferred(null);
      return;
    }
    setShowSteps((v) => !v);
  }

  function onDismiss() {
    window.localStorage.setItem("samuelclip-install-dismissed", "1");
    setDismissed(true);
  }

  if (standalone || installed) {
    return (
      <p
        role="status"
        className="mt-4 rounded-[var(--radius)] bg-[var(--accent-soft)] p-3 text-sm font-medium text-[var(--text)]"
      >
        {installed && !standalone
          ? "¡Listo! Creador de clips con IA quedó instalado en tu teléfono: ábrelo desde el ícono de tu pantalla principal, con el mismo sistema y tu biblioteca guardada."
          : "Estás usando Creador de clips con IA como app instalada en tu teléfono: mismo sistema, tu biblioteca guardada, a pantalla completa."}
      </p>
    );
  }
  if (dismissed) return null;

  return (
    <section
      aria-label="Instalar Creador de clips con IA en tu teléfono"
      className="mt-4 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <img
          src={appIcon}
          alt="Ícono de la app Creador de clips con IA"
          className="h-14 w-14 shrink-0 rounded-2xl"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-extrabold leading-snug text-[var(--text)]">
            Creador de clips con IA como app en tu teléfono
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            Instálala solo para ti: queda con su ícono en tu pantalla principal y abre a pantalla
            completa como una app normal, con el mismo sistema y tu biblioteca de clips guardada.
            Sin tienda, sin licencia, sin pagar nada.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Ocultar la invitación a instalar la app"
          className="shrink-0 rounded-full px-2 py-1 text-lg font-bold leading-none text-[var(--dim)]"
        >
          ×
        </button>
      </div>
      <button
        type="button"
        onClick={onInstall}
        className="mt-3 w-full rounded-[var(--radius)] bg-[var(--hot)] py-3 text-base font-extrabold text-white"
      >
        📲 Instalar la app en mi teléfono
      </button>
      {note && (
        <p role="status" className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
          {note}
        </p>
      )}
      {showSteps && (
        <div className="mt-3 rounded-xl bg-[var(--accent-soft)] p-3 text-sm leading-relaxed text-[var(--text)]">
          {isIos ? (
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Toca el botón <strong>Compartir</strong> de Safari (el cuadrado con la flecha hacia arriba).</li>
              <li>Elige <strong>«Añadir a pantalla de inicio»</strong>.</li>
              <li>Toca <strong>«Añadir»</strong> — y listo: el ícono de Creador de clips con IA queda en tu pantalla principal.</li>
            </ol>
          ) : (
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Toca el menú <strong>⋮</strong> de tu navegador (Chrome).</li>
              <li>Elige <strong>«Instalar app»</strong> o <strong>«Añadir a pantalla principal»</strong>.</li>
              <li>Confirma con <strong>«Instalar»</strong> — y listo: el ícono de Creador de clips con IA queda en tu pantalla principal.</li>
            </ol>
          )}
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            Si no ves esa opción dentro de la app de Muse, abre Creador de clips con IA en el navegador de tu
            teléfono (Chrome o Safari) y haz los mismos pasos ahí.
          </p>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ live mode

type LiveTarget = ApiResponse<typeof api, "resolveLiveTarget">;

function liveStatusBadge(status: string, detail: string): { label: string; classes: string } {
  switch (status) {
    case "live":
      return { label: "🔴 EN VIVO ahora", classes: "bg-[var(--danger)] text-white" };
    case "upcoming":
      return { label: `🕒 ${detail || "Programado"}`, classes: "bg-[var(--accent)] text-white" };
    case "ended":
      return { label: "▶ Ya terminó", classes: "bg-[var(--surface-alt)] text-[var(--dim)]" };
    default:
      return { label: "Sin confirmar", classes: "bg-[var(--surface-alt)] text-[var(--dim)]" };
  }
}

function fmtElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The live flow runs on fixed, sensible options: the user asked for
// it automated ("solo yo tenga que descargarlo y ya"), so there are
// no knobs to set here — paste the link and the app does the rest.
const LIVE_OPTIONS: Options = { minSec: 30, maxSec: 90, minScore: 0, clipCount: 5 };
const LIVE_WATCH_MINUTES = 60;

// "Sacar clips de en vivo para La Casa de Alofoke 3": the show airs
// live on the Alofoke Radio Show channel and its streams carry no
// subtitles, so this section works differently from the main form —
// the app listens to the stream's LIVE CHAT (in the background) and
// the moments where the chat explodes become the clips, presented
// TalentClip-style in this tab's own library as a grid of vertical
// tiles. A scheduled premiere (like the Casa's Nov 23 debut) can be
// registered while it is still upcoming; the app re-checks the
// followed streams on its own and flags them EN VIVO when they start.
// The flow is AUTOMATED end to end (the user rejected the manual
// version: "pon en otro apartado la cosa de sacar clip de los en
// vivo… facilítame y automatizado para lo clip, solo yo tenga que
// descargarlo y ya"): resolving a link that is live starts the chat
// listening by itself, and while it listens the app turns new chat
// explosions into clips by itself. The user's only remaining tap is
// the MP4 download on each finished clip.
function LiveSection({
  seed,
  onClipsCreated,
}: {
  seed: { input: string; nonce: number } | null;
  onClipsCreated?: (projectId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [link, setLink] = useState("");
  const [target, setTarget] = useState<LiveTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Automation guards: which stream the listening was auto-started
  // for, the last chat peak clips were auto-made from, when the last
  // auto-make ran, and which stream already got its final auto-make.
  const autoStartedForRef = useRef<string>("");
  const lastAutoPeakRef = useRef(0);
  const lastAutoMakeAtRef = useRef(0);
  const finalMadeForRef = useRef<string>("");

  const events = useQuery({
    queryKey: ["liveEvents"],
    queryFn: () => api.listLiveEvents({}),
    retry: 3,
    retryDelay: (attempt) => Math.min(1200 * 2 ** attempt, 8000),
  });

  const videoId = target?.ok ? target.videoId : "";
  const watch = useQuery({
    queryKey: ["liveWatch", videoId],
    queryFn: () => api.pollLiveWatch({ videoId }),
    enabled: !!videoId,
    refetchInterval: 5000,
  });
  const watchState = watch.data?.state ?? "none";
  const watching = watchState === "watching";

  const invalidateEvents = () => queryClient.invalidateQueries({ queryKey: ["liveEvents"] });
  const invalidateWatch = () =>
    queryClient.invalidateQueries({ queryKey: ["liveWatch", videoId] });

  const resolveM = useMutation({
    mutationFn: (input: string) => api.resolveLiveTarget({ input }),
    onSuccess: (res) => {
      if (res.ok) {
        setTarget(res);
        setError(null);
        invalidateEvents();
      } else {
        setError(res.error ?? "No pude resolver ese directo.");
      }
    },
    onError: () => setError("La conexión falló buscando el directo. Inténtalo de nuevo."),
  });

  const checkM = useMutation({
    mutationFn: () => api.checkLiveEvents({}),
    onSuccess: (res) => {
      setNotice(
        `Revisé ${res.checked} directo(s) seguido(s): ${res.liveNow} en vivo ahora mismo.`,
      );
      invalidateEvents();
      if (videoId) resolveM.mutate(`https://www.youtube.com/watch?v=${videoId}`);
    },
    onError: () => setError("La conexión falló revisando los directos. Inténtalo de nuevo."),
  });

  const startM = useMutation({
    mutationFn: () => api.startLiveWatch({ videoId, minutes: LIVE_WATCH_MINUTES }),
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        setNotice(
          res.anchorExact
            ? "Escuchando el chat del directo: los clips salen con el segundo exacto del stream."
            : "Escuchando el chat del directo. Ojo: los tiempos de estos clips serán aproximados (la app cuenta desde que detectó el directo en vivo).",
        );
        invalidateWatch();
      } else {
        setError(res.error ?? "No pude empezar a escuchar el chat.");
      }
    },
    onError: () => setError("La conexión falló empezando la escucha. Inténtalo de nuevo."),
  });

  const stopM = useMutation({
    mutationFn: () => api.stopLiveWatch({ videoId }),
    onSuccess: () => {
      setNotice("Escucha detenida. Con lo ya escuchado puedes sacar los clips.");
      invalidateWatch();
    },
    onError: () => setError("No pude detener la escucha. Inténtalo de nuevo."),
  });

  const makeM = useMutation({
    mutationFn: (auto: boolean) =>
      api.makeLiveClips({ videoId, ...sanitizeOptions(LIVE_OPTIONS) }).then((res) => ({ res, auto })),
    onSuccess: ({ res, auto }) => {
      if (res.ok) {
        setError(null);
        if (res.clipsFound > 0) {
          setNotice(
            `¡Listo! ${res.clipsFound} clip(s) nuevo(s) del en vivo: están abajo, en la biblioteca de esta pestaña, y la app ya los está cortando sola en MP4 — tú solo tienes que descargarlos. ` +
              (res.note ?? ""),
          );
          if (res.projectId) onClipsCreated?.(res.projectId);
        } else if (!auto) {
          setNotice(res.note ?? "Esos momentos ya estaban guardados de una escucha anterior.");
        }
        queryClient.invalidateQueries({ queryKey: ["library"] });
      } else if (auto) {
        // An automatic pass that finds no explosion yet is not an
        // error to shout about: the listening keeps running.
        setNotice("Sigo escuchando el chat: todavía no hay un momento que explote, los clips salen solos cuando pase algo.");
      } else {
        setError(res.error ?? "No pude sacar los clips.");
      }
    },
    onError: (_err, auto) => {
      if (!auto) setError("La conexión falló sacando los clips. Inténtalo de nuevo.");
    },
  });

  const badge = target?.ok ? liveStatusBadge(target.status, target.detail) : null;
  const busyResolve = resolveM.isPending;

  // A live link handed over from the Videos tab (the user pasted a
  // youtube.com/live/… link into the main form): fill the input and
  // read it right away, no second tap.
  useEffect(() => {
    if (!seed) return;
    setLink(seed.input);
    resolveM.mutate(seed.input);
    // resolveM is a stable mutation object; the nonce is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // AUTOMATION 1: as soon as a resolved link turns out to be LIVE,
  // the chat listening starts by itself — no "Escuchar" tap, no
  // minutes to pick. (startLiveWatch is idempotent while a watch is
  // already running, and the ref guards repeat effects.)
  useEffect(() => {
    if (!target?.ok || target.status !== "live") return;
    if (watchState !== "none" || startM.isPending) return;
    if (autoStartedForRef.current === target.videoId) return;
    autoStartedForRef.current = target.videoId;
    startM.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.ok, target?.status, target?.videoId, watchState]);

  // AUTOMATION 2: while the chat is being heard, new explosions turn
  // into clips by themselves — when the chat's peak grows past what
  // was already clipped (throttled), and one final pass when the
  // listening ends. The user only ever taps "Descargar" on a clip.
  useEffect(() => {
    const data = watch.data;
    if (!data || !videoId) return;
    if (data.state !== "watching" && data.state !== "done") return;
    if (data.messagesTotal < 40 || data.bucketsHeard < 6) return;
    if (makeM.isPending) return;
    const now = Date.now();
    if (data.state === "done") {
      if (finalMadeForRef.current === videoId) return;
      finalMadeForRef.current = videoId;
      lastAutoPeakRef.current = data.peakCount;
      lastAutoMakeAtRef.current = now;
      makeM.mutate(true);
      return;
    }
    if (data.peakCount > lastAutoPeakRef.current && now - lastAutoMakeAtRef.current > 45000) {
      lastAutoPeakRef.current = data.peakCount;
      lastAutoMakeAtRef.current = now;
      makeM.mutate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch.data, videoId]);

  return (
    <section
      aria-label="Clips de en vivo — La Casa de Alofoke 3"
      className="rounded-[var(--radius)] border-2 border-[var(--danger)] bg-[var(--surface)] p-4"
    >
      <h2 className="text-xl font-extrabold leading-snug text-[var(--text)]">
        🔴 Clips de en vivo · La Casa de Alofoke 3
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
        Esto va <strong>automático</strong>: pegas el link (o tocas el botón de La Casa) y la app lo
        lee en segundos. Si el directo está en vivo, <strong>empieza a escuchar el chat sola</strong>{" "}
        y <strong>saca los clips sola</strong> cada vez que el chat explota — tú solo bajas aquí y le
        das a <strong>descargar</strong> en cada clip. La Casa se transmite por el canal{" "}
        <strong>Alofoke Radio Show</strong> y sus directos no traen subtítulos de diálogo, por eso los
        momentos salen del chat; cada clip lleva quemado, estilo TikTok como en TalentClip, el{" "}
        <strong>texto real del chat de ese momento</strong> (lo que la gente escribió en ese segundo).
        Los clips quedan abajo, en la biblioteca de esta pestaña, en una rejilla de videos verticales,
        y el MP4 9:16 se corta con un toque cuando el directo termina y queda como repetición.
      </p>

      <button
        type="button"
        onClick={() => resolveM.mutate("")}
        disabled={busyResolve}
        className="mt-3 w-full rounded-[var(--radius)] bg-[var(--danger)] py-3.5 text-lg font-extrabold text-white disabled:opacity-50"
      >
        {busyResolve ? "Leyendo…" : "🏠 La Casa de Alofoke 3 — leer su en vivo"}
      </button>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) resolveM.mutate(link.trim());
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="…o pega el link de cualquier directo (youtube.com/live/…)"
          inputMode="url"
          autoComplete="off"
          aria-label="Link de un directo de YouTube"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
        />
        <button
          type="submit"
          disabled={busyResolve || !link.trim()}
          className="shrink-0 rounded-[var(--radius)] bg-[var(--danger)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {busyResolve ? "Leyendo…" : "Leer link"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 rounded-[var(--radius)] bg-[var(--danger)]/10 p-3 text-sm font-medium text-[var(--danger)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 rounded-[var(--radius)] bg-[var(--accent-soft)] p-3 text-sm font-medium text-[var(--text)]">
          {notice}
        </p>
      )}

      {target?.ok && badge && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-bold leading-snug text-[var(--text)]">{target.title}</h3>
              <p className="mt-0.5 text-xs text-[var(--dim)]">{target.creator}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${badge.classes}`} role="status">
              {badge.label}
            </span>
          </div>
          <a
            href={target.watchUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text)]"
          >
            Ver el directo en YouTube
          </a>

          {target.status === "upcoming" && (
            <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">
              Todavía no empieza ({target.detail.toLowerCase()}). Ya quedó registrado en «Directos
              seguidos» aquí abajo: la app lo revisa sola cada 30 minutos. Cuando empiece a
              transmitir, entra a esta pestaña, toca «Abrir» en su fila y la escucha del chat
              arranca sola.
            </p>
          )}
          {target.status === "ended" && (
            <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">
              Este directo ya terminó. Sus clips salían del chat mientras transmitía, así que de
              este ya no se puede escuchar nada; los que se sacaron en su momento están abajo, en
              la biblioteca de esta pestaña, listos para descargar. Para la próxima, pega el link
              con el directo en el aire y la app hace todo sola.
            </p>
          )}
          {(target.status === "live" || target.status === "unknown" || watchState !== "none") &&
            target.status !== "upcoming" &&
            target.status !== "ended" && (
              <div className="mt-3 rounded-xl bg-[var(--surface)] p-3">
                {watchState === "watching" && watch.data && (
                  <>
                    <p className="text-sm font-bold text-[var(--text)]" role="status" aria-live="polite">
                      🎧 Escuchando el chat… {fmtElapsed(watch.data.elapsedSec)} · 💬{" "}
                      {watch.data.messagesTotal} mensajes contados
                    </p>
                    {watch.data.peakLabel && watch.data.peakCount > 0 && (
                      <p className="mt-1 text-sm text-[var(--dim)]">
                        🔥 Momento más caliente hasta ahora:{" "}
                        <span className="time-mono font-semibold text-[var(--text)]">
                          {watch.data.peakLabel}
                        </span>{" "}
                        ({watch.data.peakCount} mensajes en 10 s)
                      </p>
                    )}
                    <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                      {watch.data.anchorExact
                        ? "Los tiempos salen de la hora oficial de inicio del directo: segundos exactos."
                        : "Los tiempos son aproximados: la app cuenta desde que detectó el directo en vivo. Si un clip cae corrido, lo ajustas con «Corregir tiempos» en su tarjeta."}{" "}
                      Los clips salen SOLOS cuando el chat explota: no tienes que tocar nada, solo
                      bajar a descargarlos. Puedes salir de la app: la escucha sigue en el servidor
                      hasta cumplir su hora o hasta que la detengas.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => makeM.mutate(false)}
                        disabled={makeM.isPending}
                        className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                      >
                        {makeM.isPending ? "Sacando clips…" : "🎬 Sacar clips ahora"}
                      </button>
                      <button
                        type="button"
                        onClick={() => stopM.mutate()}
                        disabled={stopM.isPending}
                        className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-60"
                      >
                        ⏹ Detener escucha
                      </button>
                    </div>
                  </>
                )}
                {watchState === "done" && watch.data && (
                  <>
                    <p className="text-sm font-bold text-[var(--text)]" role="status">
                      ✅ Escucha terminada: {watch.data.messagesTotal} mensajes en{" "}
                      {fmtElapsed(watch.data.elapsedSec)} escuchados.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => makeM.mutate(false)}
                        disabled={makeM.isPending}
                        className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                      >
                        {makeM.isPending ? "Sacando clips…" : "🎬 Sacar clips de lo escuchado"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startM.mutate()}
                        disabled={startM.isPending}
                        className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-60"
                      >
                        🎧 Escuchar otro rato (empieza de cero)
                      </button>
                    </div>
                  </>
                )}
                {(watchState === "none" || watchState === "error") && (
                  <>
                    {watchState === "error" && (
                      <p className="text-sm font-medium text-[var(--danger)]">
                        La escucha anterior se cortó (el chat dejó de responder). Puedes empezar
                        otra.
                      </p>
                    )}
                    {target.status === "live" ? (
                      <p className="text-sm leading-relaxed text-[var(--text)]" role="status">
                        {startM.isPending
                          ? "Arrancando la escucha del chat…"
                          : "La escucha arranca sola en unos segundos, sin tocar nada. Si no arranca, usa el botón:"}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                        Ahora mismo no pude confirmar que esté transmitiendo. Si está en vivo,
                        «Revisar ahora» en la lista de abajo lo confirma y la escucha arranca sola.
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <button
                        type="button"
                        onClick={() => startM.mutate()}
                        disabled={startM.isPending || target.status !== "live"}
                        className="rounded-full bg-[var(--danger)] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                      >
                        {startM.isPending ? "Arrancando…" : "🎧 Empezar la escucha"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
        </div>
      )}

      <div className="mt-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-extrabold text-[var(--text)]">Directos seguidos</h3>
          <button
            type="button"
            onClick={() => checkM.mutate()}
            disabled={checkM.isPending}
            className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] disabled:opacity-60"
          >
            {checkM.isPending ? "Revisando…" : "Revisar ahora"}
          </button>
        </div>
        {events.isPending && <p className="mt-2 text-sm text-[var(--dim)]">Cargando…</p>}
        {events.isSuccess && events.data.events.length === 0 && (
          <p className="mt-2 rounded-xl border border-dashed border-[var(--border)] p-3 text-sm leading-relaxed text-[var(--dim)]">
            Todavía no sigues ningún directo. Toca «🏠 La Casa de Alofoke 3 — leer su en vivo» y el
            directo (o su estreno programado) queda registrado aquí.
          </p>
        )}
        <div className="mt-2 flex flex-col gap-2">
          {(events.data?.events ?? []).map((ev) => {
            const b = liveStatusBadge(ev.status, ev.detail);
            return (
              <div
                key={ev.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--border)] p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-semibold text-[var(--text)]">{ev.title}</p>
                  <p className="mt-0.5 text-xs text-[var(--dim)]">
                    {ev.creator}
                    {ev.hasProject ? " · ya tiene clips en la Biblioteca" : ""}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${b.classes}`}>
                  {b.label}
                </span>
                <button
                  type="button"
                  onClick={() => resolveM.mutate(ev.watchUrl)}
                  disabled={busyResolve}
                  className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] disabled:opacity-60"
                >
                  Abrir
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}


// ------------------------------------------------------- cuentas / admin
//
// Multi-user (user, 2026-11-09: «cada usuario tenga su biblioteca
// aparte… yo seré admin y tendré el control de todas»). The server
// resolves each visitor to their own account from their verified
// Muse identity and filters every library by it; this card is the
// user's own space (name, role, counts) and, for the owner, the door
// to the admin panel. Nothing here can widen access by itself: the
// server re-checks the account on every action.

function MySpaceCard({
  space,
  onOpenAdmin,
  onLogout,
}: {
  space: MySpace;
  onOpenAdmin: () => void;
  onLogout: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.displayName);
  const [note, setNote] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () => api.updateMyName({ name: name.trim() }),
    onSuccess: (res) => {
      if (res.ok) {
        setEditing(false);
        setNote("Nombre guardado.");
        queryClient.invalidateQueries({ queryKey: ["mySpace"] });
        queryClient.invalidateQueries({ queryKey: ["accountsAdmin"] });
      } else {
        setNote(res.error ?? "No pude guardar el nombre.");
      }
    },
    onError: () => setNote("No pude guardar el nombre. Inténtalo de nuevo."),
  });

  return (
    <section
      aria-label="Mi cuenta y mi espacio"
      className="mt-4 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xl font-extrabold text-white"
          aria-hidden="true"
        >
          {space.displayName.slice(0, 1).toLocaleUpperCase("es")}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-extrabold leading-snug text-[var(--text)]">
              {space.displayName}
            </h2>
            {space.isAdmin ? (
              <span className="rounded-full bg-[var(--hot)] px-2.5 py-0.5 text-xs font-extrabold text-white">
                👑 Administrador
              </span>
            ) : (
              <span className="rounded-full bg-[var(--surface-alt)] px-2.5 py-0.5 text-xs font-bold text-[var(--dim)]">
                👤 Usuario
              </span>
            )}
            {space.status === "blocked" && (
              <span className="rounded-full bg-[var(--danger)] px-2.5 py-0.5 text-xs font-extrabold text-white">
                Cuenta bloqueada
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            Este es <strong>tu espacio</strong>: {space.projectsCount} video(s) · {space.clipsCount}{" "}
            clip(s) · {space.liveEventsCount} directo(s) seguido(s). Tu biblioteca es solo tuya:
            ninguna otra cuenta la ve ni la toca.
            {space.isAdmin
              ? " Y como admin, tú sí ves y controlas las cuentas de todos desde tu panel."
              : ""}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setName(space.displayName);
            setEditing((v) => !v);
          }}
          aria-expanded={editing}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
        >
          Cambiar mi nombre
        </button>
        {space.isAdmin && (
          <button
            type="button"
            onClick={onOpenAdmin}
            className="rounded-full bg-[var(--hot)] px-4 py-2 text-sm font-bold text-white"
          >
            👑 Panel de admin — todas las cuentas
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--dim)]"
        >
          Cerrar sesión
        </button>
      </div>
      {editing && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename.mutate();
          }}
        >
          <label htmlFor="my-name" className="sr-only">
            Tu nombre en la app
          </label>
          <input
            id="my-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)]"
          />
          <button
            type="submit"
            disabled={rename.isPending || !name.trim()}
            className="shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
          >
            {rename.isPending ? "Guardando…" : "Guardar"}
          </button>
        </form>
      )}
      {note && (
        <p role="status" className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
          {note}
        </p>
      )}
    </section>
  );
}

// The admin panel: every account in the app, with its size, state and
// controls — view its library, delete its videos/clips, block or
// reactivate it, or empty its whole library. All of it is enforced
// server-side too (the admin actions refuse non-admins); this panel
// only renders for the owner's account.
function AdminPanel() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmClearId, setConfirmClearId] = useState<number | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<number | null>(null);
  const [confirmDeleteClipId, setConfirmDeleteClipId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accountsAdmin"],
    queryFn: () => api.listAccountsAdmin({}),
  });
  const adminLib = useQuery({
    queryKey: ["adminLibrary", selectedId],
    queryFn: () => api.adminListLibrary({ accountId: selectedId as number }),
    enabled: selectedId != null,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["accountsAdmin"] });
    queryClient.invalidateQueries({ queryKey: ["adminLibrary"] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
    queryClient.invalidateQueries({ queryKey: ["mySpace"] });
    queryClient.invalidateQueries({ queryKey: ["liveEvents"] });
  };

  const setStatus = useMutation({
    mutationFn: (args: { accountId: number; status: "active" | "blocked" }) =>
      api.adminSetAccountStatus(args),
    onSuccess: (res) => {
      if (res.ok) {
        setNote("Listo: el estado de la cuenta quedó actualizado.");
        invalidateAll();
      } else {
        setNote(res.error ?? "No pude cambiar el estado de la cuenta.");
      }
    },
    onError: () => setNote("No pude cambiar el estado de la cuenta. Inténtalo de nuevo."),
  });
  const clearLibrary = useMutation({
    mutationFn: (accountId: number) => api.adminClearLibrary({ accountId }),
    onSuccess: (res) => {
      setConfirmClearId(null);
      if (res.ok) {
        setNote(`Biblioteca vaciada: se borraron ${res.removedProjects} video(s) de la cuenta.`);
        invalidateAll();
      } else {
        setNote(res.error ?? "No pude vaciar esa biblioteca.");
      }
    },
    onError: () => setNote("No pude vaciar esa biblioteca. Inténtalo de nuevo."),
  });
  const delProject = useMutation({
    mutationFn: (projectId: number) => api.deleteProject({ projectId }),
    onSuccess: () => {
      setConfirmDeleteProjectId(null);
      setNote("Video borrado de la biblioteca de esa cuenta.");
      invalidateAll();
    },
    onError: () => setNote("No pude borrar ese video. Inténtalo de nuevo."),
  });
  const delClip = useMutation({
    mutationFn: (clipId: number) => api.deleteClip({ clipId }),
    onSuccess: () => {
      setConfirmDeleteClipId(null);
      setNote("Clip borrado.");
      invalidateAll();
    },
    onError: () => setNote("No pude borrar ese clip. Inténtalo de nuevo."),
  });

  const rows: AdminAccount[] = accounts.data?.ok ? accounts.data.accounts : [];
  const selected: AdminAccount | null = rows.find((r) => r.id === selectedId) ?? null;
  const libGroups: AdminLibrary["creators"] =
    adminLib.data?.ok && selectedId != null ? adminLib.data.creators : [];

  return (
    <section aria-label="Panel de administrador" className="mt-5">
      <h2 className="text-2xl font-extrabold text-[var(--text)]">👑 Panel de admin</h2>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
        Todas las cuentas de la app. Cada usuario tiene su biblioteca aparte y solo ve la suya;
        tú, como admin, las ves y las controlas todas: abrir su biblioteca, borrar sus videos o
        clips, bloquear una cuenta (no puede usar la app hasta que la actives) o vaciar su
        biblioteca completa.
      </p>
      {accounts.isPending && <p className="mt-3 text-sm text-[var(--dim)]">Cargando las cuentas…</p>}
      {accounts.isError && (
        <div className="mt-3">
          <p className="text-sm font-medium text-[var(--danger)]">No pude cargar las cuentas.</p>
          <button
            type="button"
            onClick={() => accounts.refetch()}
            className="mt-2 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
          >
            Reintentar
          </button>
        </div>
      )}
      {accounts.data && !accounts.data.ok && (
        <p role="alert" className="mt-3 text-sm font-medium text-[var(--danger)]">
          {accounts.data.error ?? "Solo el administrador puede ver esta sección."}
        </p>
      )}
      {note && (
        <p role="status" className="mt-3 rounded-[var(--radius)] bg-[var(--accent-soft)] p-3 text-sm font-medium text-[var(--text)]">
          {note}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3">
        {rows.map((acc) => (
          <article
            key={acc.id}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-extrabold text-[var(--text)]">
                {acc.displayName}
                {acc.isMe ? " (tú)" : ""}
              </h3>
              {acc.role === "admin" ? (
                <span className="rounded-full bg-[var(--hot)] px-2.5 py-0.5 text-xs font-extrabold text-white">
                  👑 Admin
                </span>
              ) : (
                <span className="rounded-full bg-[var(--surface-alt)] px-2.5 py-0.5 text-xs font-bold text-[var(--dim)]">
                  Usuario
                </span>
              )}
              {acc.status === "blocked" ? (
                <span className="rounded-full bg-[var(--danger)] px-2.5 py-0.5 text-xs font-extrabold text-white">
                  Bloqueada
                </span>
              ) : (
                <span className="rounded-full bg-[var(--used)] px-2.5 py-0.5 text-xs font-extrabold text-white">
                  Activa
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {acc.projectsCount} video(s) · {acc.clipsCount} clip(s) · {acc.liveEventsCount}{" "}
              directo(s) · cuenta creada el{" "}
              {new Date(acc.createdAt).toLocaleDateString("es", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}{" "}
              · última visita{" "}
              {new Date(acc.lastSeenAt).toLocaleDateString("es", {
                day: "numeric",
                month: "short",
              })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedId(selectedId === acc.id ? null : acc.id)}
                aria-expanded={selectedId === acc.id}
                className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white"
              >
                {selectedId === acc.id ? "Ocultar su biblioteca" : "Ver su biblioteca"}
              </button>
              {acc.role !== "admin" &&
                (acc.status === "blocked" ? (
                  <button
                    type="button"
                    onClick={() => setStatus.mutate({ accountId: acc.id, status: "active" })}
                    disabled={setStatus.isPending}
                    className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-60"
                  >
                    ✅ Activar cuenta
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStatus.mutate({ accountId: acc.id, status: "blocked" })}
                    disabled={setStatus.isPending}
                    className="rounded-full border border-[var(--danger)] px-4 py-2 text-sm font-semibold text-[var(--danger)] disabled:opacity-60"
                  >
                    🚫 Bloquear cuenta
                  </button>
                ))}
              {acc.role !== "admin" &&
                (confirmClearId === acc.id ? (
                  <button
                    type="button"
                    onClick={() => clearLibrary.mutate(acc.id)}
                    disabled={clearLibrary.isPending}
                    className="rounded-full bg-[var(--danger)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                  >
                    {clearLibrary.isPending ? "Vaciando…" : "Sí, vaciar toda su biblioteca"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClearId(acc.id)}
                    className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--danger)]"
                  >
                    Vaciar su biblioteca
                  </button>
                ))}
            </div>

            {selectedId === acc.id && (
              <div className="mt-4 border-t border-[var(--border)] pt-3">
                {adminLib.isPending && (
                  <p className="text-sm text-[var(--dim)]">Cargando su biblioteca…</p>
                )}
                {adminLib.isError && (
                  <p className="text-sm font-medium text-[var(--danger)]">
                    No pude cargar su biblioteca.{" "}
                    <button type="button" onClick={() => adminLib.refetch()} className="underline">
                      Reintentar
                    </button>
                  </p>
                )}
                {adminLib.data && !adminLib.data.ok && (
                  <p className="text-sm font-medium text-[var(--danger)]">
                    {adminLib.data.error ?? "No pude cargar su biblioteca."}
                  </p>
                )}
                {adminLib.data?.ok && libGroups.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--border)] p-3 text-sm text-[var(--dim)]">
                    La biblioteca de {selected?.displayName ?? "esta cuenta"} está vacía: todavía
                    no ha guardado ningún video.
                  </p>
                )}
                {libGroups.map((group) => (
                  <div key={group.creator} className="mt-3">
                    <h4 className="text-sm font-extrabold text-[var(--accent-strong)]">
                      {group.creator}
                    </h4>
                    {group.projects.map((project) => (
                      <div
                        key={project.id}
                        className="mt-2 rounded-xl border border-[var(--border)] p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-bold leading-snug text-[var(--text)]">
                              {project.title}
                            </p>
                            <p className="time-mono mt-0.5 text-xs text-[var(--dim)]">
                              {project.isLive ? "🔴 En vivo · " : ""}Dura {project.durationLabel}{" "}
                              · {project.clips.length} clip(s)
                            </p>
                          </div>
                          {confirmDeleteProjectId === project.id ? (
                            <button
                              type="button"
                              onClick={() => delProject.mutate(project.id)}
                              disabled={delProject.isPending}
                              className="shrink-0 rounded-full bg-[var(--danger)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                            >
                              Sí, borrar video
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteProjectId(project.id)}
                              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--danger)]"
                            >
                              Borrar video
                            </button>
                          )}
                        </div>
                        {project.clips.length > 0 && (
                          <ul className="mt-2 flex flex-col gap-1.5">
                            {project.clips.map((clip) => (
                              <li
                                key={clip.id}
                                className="flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1.5"
                              >
                                <span
                                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-extrabold ${scoreClasses(clip.score)}`}
                                >
                                  {clip.score}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text)]">
                                  {clip.title}
                                </span>
                                <span className="time-mono shrink-0 text-[11px] text-[var(--dim)]">
                                  {clip.startLabel} → {clip.endLabel}
                                </span>
                                {confirmDeleteClipId === clip.id ? (
                                  <button
                                    type="button"
                                    onClick={() => delClip.mutate(clip.id)}
                                    disabled={delClip.isPending}
                                    className="shrink-0 rounded-full bg-[var(--danger)] px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-60"
                                  >
                                    Sí, borrar
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteClipId(clip.id)}
                                    aria-label={`Borrar el clip: ${clip.title}`}
                                    className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold text-[var(--danger)]"
                                  >
                                    Borrar
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {accounts.data?.ok && rows.length <= 1 && (
        <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm leading-relaxed text-[var(--dim)]">
          Por ahora solo está tu cuenta: cada persona que abra la app con su propia cuenta de
          Muse aparece aquí automáticamente con su biblioteca aparte, y desde aquí la
          controlas.
        </p>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- app
//
// The exported App (bottom of this file) is the login gate: without a
// signed-in session it renders ONLY the login screen; with one, it
// renders this MainApp. MainApp is the whole clip system, unchanged —
// every action it fires carries the session token automatically (see
// api.ts), so the server always resolves the signed-in account.

function MainApp({ onLogout }: { onLogout: () => void }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Two separate areas (user, 2026-11-09: «pon en otro apartado la
  // cosa de sacar clip de los en vivo»): the normal video clips and
  // the live mode live in their own tabs, each with its own library —
  // nothing of the en vivo is mixed into the video page anymore.
  const [tab, setTab] = useState<"videos" | "live" | "admin">("videos");
  // A live link pasted into the Videos form is handed to the live tab
  // through this seed: the tab opens with the link already being read.
  const [liveSeed, setLiveSeed] = useState<{ input: string; nonce: number } | null>(null);

  // AUTOMATION (user, 2026-11-09: «automatizado para lo clip porfa,
  // solo yo tenga que descargarlo y ya»): the moment an analysis or a
  // live pass creates clips, the app cuts every one of them by itself
  // in the background (same server render the download button uses,
  // just started without waiting for a tap). The user's only
  // remaining job is tapping «Descargar» on a finished MP4.
  const [autoCut, setAutoCut] = useState<{
    total: number;
    ready: number;
    failed: number;
    current: string;
    done: boolean;
  } | null>(null);
  const autoCutRunningRef = useRef(false);

  async function startAutoCut(projectId: number) {
    if (autoCutRunningRef.current) return;
    let lib: Library;
    try {
      lib = await api.listLibrary({});
    } catch {
      return;
    }
    const project = lib.creators.flatMap((c) => c.projects).find((p) => p.id === projectId);
    if (!project) return;
    const pending = project.clips.filter((c) => !c.videoUrl);
    if (pending.length === 0) return;
    autoCutRunningRef.current = true;
    let ready = 0;
    let failed = 0;
    setAutoCut({ total: pending.length, ready, failed, current: pending[0]?.title ?? "", done: false });
    for (const clip of pending) {
      setAutoCut((prev) => (prev ? { ...prev, current: clip.title } : prev));
      let cutOk = false;
      let consecutiveFailures = 0;
      for (let attempt = 0; attempt < 300 && !cutOk; attempt++) {
        try {
          const res = await api.prepareClipDownload({ clipId: clip.id });
          consecutiveFailures = 0;
          if (res.ok && res.downloadUrl) {
            cutOk = true;
          } else if (!res.rendering) {
            break; // real error (e.g. the stream is still live): the card's button stays as the route
          } else {
            await new Promise((r) => window.setTimeout(r, 3000));
          }
        } catch {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 6) break;
          await new Promise((r) => window.setTimeout(r, 3000));
        }
      }
      if (cutOk) ready += 1;
      else failed += 1;
      setAutoCut((prev) => (prev ? { ...prev, ready, failed } : prev));
      queryClient.invalidateQueries({ queryKey: ["library"] });
    }
    autoCutRunningRef.current = false;
    setAutoCut((prev) => (prev ? { ...prev, done: true, current: "" } : prev));
  }

  function goLiveWith(link: string) {
    setTab("live");
    setLiveSeed({ input: link, nonce: Date.now() });
  }

  // retry/retryDelay are set explicitly on the first-load queries:
  // the shared query client only auto-retries failures that happen
  // BEFORE the action runs, so a server 500 used to leave this first
  // screen dead — no «Mi espacio» card, «No pude cargar la
  // biblioteca» — and the app looked exactly like the old version
  // ("no veo que nada cambió"). A few real retries make the first
  // open self-heal instead.
  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.listLibrary({}),
    retry: 3,
    retryDelay: (attempt) => Math.min(1200 * 2 ** attempt, 8000),
  });
  // The caller's own account (created by the server on first sight):
  // drives the «Mi espacio» card, the blocked state and, for the
  // owner, the admin tab.
  const mySpace = useQuery({
    queryKey: ["mySpace"],
    queryFn: () => api.getMySpace({}),
    retry: 3,
    retryDelay: (attempt) => Math.min(1200 * 2 ** attempt, 8000),
  });
  const isAdmin = mySpace.data?.isAdmin === true;
  const isBlocked = mySpace.data?.status === "blocked" && !isAdmin;

  const analyze = useMutation({
    mutationFn: (args: { value: string; opts: Options }) =>
      api.analyzeVideo({ input: args.value, ...args.opts }),
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        setChannel(null);
        setNotice(
          res.note ??
            (res.clipsFound > 0
              ? `¡Listo! ${res.clipsFound} clip(s) de «${res.title}» guardados en tu biblioteca.`
              : `Analicé «${res.title}» pero no salió ningún clip con estas opciones.`),
        );
        queryClient.invalidateQueries({ queryKey: ["library"] });
        if (res.projectId && res.clipsFound > 0) void startAutoCut(res.projectId);
      } else {
        setNotice(null);
        setError(res.error ?? "No pude analizar ese link.");
      }
    },
    onError: () => {
      setNotice(null);
      setError("La conexión falló analizando el video. Inténtalo de nuevo.");
    },
  });

  const resolve = useMutation({
    mutationFn: (value: string) => api.resolveChannel({ url: value }),
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        setNotice(null);
        setChannel(res);
      } else {
        setChannel(null);
        setError(res.error ?? "No pude leer ese canal.");
      }
    },
    onError: () => setError("La conexión falló leyendo el canal. Inténtalo de nuevo."),
  });

  const busy = analyze.isPending || resolve.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || busy) return;
    setError(null);
    setNotice(null);
    // A live link never belongs to the subtitle pipeline: send it
    // straight to the En vivo tab, which reads it fast and without
    // the old "no subtitles / YouTube is limiting" dead-end errors.
    if (/\/live\//.test(value)) {
      goLiveWith(value);
      return;
    }
    const opts = sanitizeOptions(options);
    if (opts.minSec > opts.maxSec) {
      setError("La duración mínima no puede ser mayor que la máxima.");
      return;
    }
    // Channel links detour through the picker; video links go straight in.
    if (/@|\/channel\/|\/c\/|\/user\//.test(value) && !/[?&]v=|youtu\.be|\/shorts\/|\/live\//.test(value)) {
      resolve.mutate(value);
    } else {
      analyze.mutate({ value, opts });
    }
  }

  function analyzeChannelVideo(url: string) {
    setInput(url);
    setError(null);
    setNotice(null);
    analyze.mutate({ value: url, opts: sanitizeOptions(options) });
  }

  function setOpt<K extends keyof Options>(key: K, raw: string) {
    const n = Number.parseInt(raw, 10);
    setOptions((o) => ({ ...o, [key]: Number.isFinite(n) ? n : 0 }));
  }

  const creators = library.data?.creators ?? [];
  // Each tab shows ONLY its own projects: video projects in the
  // Videos tab, live projects in the En vivo tab.
  const splitGroups = (wantLive: boolean) =>
    creators
      .map((g) => ({
        creator: g.creator,
        projects: g.projects.filter((p) => p.isLive === wantLive),
      }))
      .filter((g) => g.projects.length > 0);
  const videoGroups = splitGroups(false);
  const liveGroups = splitGroups(true);
  const countClips = (groups: typeof videoGroups) =>
    groups.reduce((acc, c) => acc + c.projects.reduce((a, p) => a + p.clips.length, 0), 0);
  const totalClips = countClips(videoGroups);
  const totalLiveClips = countClips(liveGroups);

  const libraryError = library.isError ? (
    <div className="mt-3">
      <p className="text-sm font-medium text-[var(--danger)]">No pude cargar la biblioteca.</p>
      <button
        type="button"
        onClick={() => library.refetch()}
        className="mt-2 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
      >
        Reintentar
      </button>
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        {/* The account card goes FIRST, above the install/permission
            cards: it is the multi-user change (own space + admin
            panel) and it used to sit below two tall cards, so on a
            phone the app opened looking identical to the old version
            and the change was invisible ("no veo que nada cambió"). */}
        {mySpace.data && (
          <MySpaceCard
            space={mySpace.data}
            onOpenAdmin={() => setTab("admin")}
            onLogout={onLogout}
          />
        )}
        {!mySpace.data && mySpace.isError && (
          <div
            role="alert"
            className="mt-4 rounded-[var(--radius)] border-2 border-[var(--danger)] bg-[var(--danger)]/10 p-4"
          >
            <p className="text-base font-extrabold text-[var(--danger)]">
              No pude cargar tu cuenta y tu espacio
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
              Sin tu cuenta no puedo mostrarte tu biblioteca privada ni, si eres el admin, tu
              panel de control de todas las cuentas. La app ya lo reintentó sola; si sigue así,
              toca «Reintentar».
            </p>
            <button
              type="button"
              onClick={() => mySpace.refetch()}
              className="mt-3 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
            >
              Reintentar
            </button>
          </div>
        )}
        <InstallAppCard />
        <MediaPermissionsCard />
        {isBlocked && (
          <div
            role="alert"
            className="mt-4 rounded-[var(--radius)] border-2 border-[var(--danger)] bg-[var(--danger)]/10 p-4"
          >
            <p className="text-base font-extrabold text-[var(--danger)]">
              🚫 Tu cuenta está bloqueada
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
              El administrador bloqueó tu cuenta, así que por ahora no puedes analizar videos,
              sacar clips ni descargar MP4. Tu biblioteca queda guardada tal cual y vuelve en
              cuanto el administrador te active de nuevo.
            </p>
          </div>
        )}

        <div
          className="mt-5 grid grid-cols-2 gap-2"
          role="tablist"
          aria-label="Apartados de la app: clips de videos o clips de en vivo"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "videos"}
            onClick={() => setTab("videos")}
            className={`rounded-[var(--radius)] py-3.5 text-base font-extrabold ${
              tab === "videos"
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            🎬 Clips de videos
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "live"}
            onClick={() => setTab("live")}
            className={`rounded-[var(--radius)] py-3.5 text-base font-extrabold ${
              tab === "live"
                ? "bg-[var(--danger)] text-white"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            🔴 En vivo · La Casa
          </button>
        </div>

        {autoCut && (
          <div
            className="mt-4 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4"
            role="status"
          >
            <p className="text-base font-extrabold text-[var(--text)]">
              {autoCut.done ? "🤖 Corte automático terminado" : "🤖 Cortando tus clips automáticamente…"}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              {autoCut.ready} de {autoCut.total} clip(s) ya están cortados y listos abajo, en la
              biblioteca — tú solo tienes que descargarlos.
              {autoCut.failed > 0
                ? ` ${autoCut.failed} no se pudo cortar todavía (si es de un en vivo, se corta cuando el directo termine; también vale el botón de su tarjeta).`
                : ""}
              {!autoCut.done && autoCut.current ? ` Ahora estoy con: «${autoCut.current}».` : ""}
            </p>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all"
                style={{
                  width: `${Math.round(((autoCut.ready + autoCut.failed) / Math.max(1, autoCut.total)) * 100)}%`,
                }}
              />
            </div>
            {autoCut.done && (
              <button
                type="button"
                onClick={() => setAutoCut(null)}
                className="mt-3 rounded-full border border-[var(--border)] px-4 py-1.5 text-sm font-semibold text-[var(--text)]"
              >
                Entendido
              </button>
            )}
          </div>
        )}

        {tab === "videos" && !isBlocked && (
          <>
        <p className="pt-5 text-sm leading-relaxed text-[var(--dim)]">
          Pega el link de un video de YouTube — o el de un canal para elegir uno de sus videos — y la
          IA te saca los mejores momentos con su puntaje y el segundo exacto. Cada clip lo ves aquí
          mismo, sin salir de la app, y lo descargas ya cortado en MP4 vertical 9:16, con los
          subtítulos quemados dentro del video estilo TikTok — mayúsculas blancas con borde negro y
          la palabra clave en amarillo — directo a la galería de tu teléfono. Cada clip trae además
          su título y sus # para TikTok ya escritos, y con un toque lo mandas a TikTok con el video
          cortado y el texto copiado. Sin licencia, sin activación: entras y ya. Y todo es
          automático: en cuanto la IA saca los clips, la app los corta sola en segundo plano y te
          los deja listos en la biblioteca — tú solo tienes que descargarlos. ¿El link es de un
          EN VIVO? Pégalo igual: la app lo manda solo a la pestaña «🔴 En vivo · La Casa», que es su
          apartado propio.
        </p>

        <form onSubmit={onSubmit} className="mt-4">
          <label htmlFor="yt-link" className="text-sm font-bold text-[var(--text)]">
            Link de YouTube
          </label>
          <input
            id="yt-link"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="youtube.com/watch?v=… o youtube.com/@canal"
            inputMode="url"
            autoComplete="off"
            className="mt-2 w-full rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3.5 text-base text-[var(--text)] placeholder:text-[var(--dim)]"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="mt-3 w-full rounded-[var(--radius)] bg-[var(--accent)] py-3.5 text-lg font-extrabold text-white disabled:opacity-50"
          >
            {resolve.isPending ? "Leyendo el canal…" : analyze.isPending ? "Analizando…" : "Sacar clips"}
          </button>

          <fieldset className="mt-4">
            <legend className="text-sm font-bold text-[var(--text)]">Opciones del proyecto</legend>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="opt-min" className="text-xs font-medium text-[var(--dim)]">
                  Duración mínima (s)
                </label>
                <input
                  id="opt-min"
                  type="number"
                  min={10}
                  max={300}
                  value={options.minSec || ""}
                  onChange={(e) => setOpt("minSec", e.target.value)}
                  className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                />
              </div>
              <div>
                <label htmlFor="opt-max" className="text-xs font-medium text-[var(--dim)]">
                  Duración máxima (s)
                </label>
                <input
                  id="opt-max"
                  type="number"
                  min={15}
                  max={600}
                  value={options.maxSec || ""}
                  onChange={(e) => setOpt("maxSec", e.target.value)}
                  className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                />
              </div>
              <div>
                <label htmlFor="opt-score" className="text-xs font-medium text-[var(--dim)]">
                  Puntaje mínimo
                </label>
                <input
                  id="opt-score"
                  type="number"
                  min={0}
                  max={100}
                  value={options.minScore || ""}
                  placeholder="0"
                  onChange={(e) => setOpt("minScore", e.target.value)}
                  className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                />
              </div>
              <div>
                <label htmlFor="opt-count" className="text-xs font-medium text-[var(--dim)]">
                  Cantidad de clips
                </label>
                <input
                  id="opt-count"
                  type="number"
                  min={1}
                  max={10}
                  value={options.clipCount || ""}
                  onChange={(e) => setOpt("clipCount", e.target.value)}
                  className="time-mono mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-[var(--dim)]">
              Para clips largos y exigentes: mínimo 65 s, máximo 120 s y puntaje mínimo 90 (no todo
              video tiene momentos de 90).
            </p>
          </fieldset>

          {analyze.isPending && <AnalysisProgress />}
          {error && (
            <div className="mt-4 rounded-[var(--radius)] bg-[var(--danger)]/10 p-3">
              <p role="alert" className="text-sm font-medium text-[var(--danger)]">
                {error}
              </p>
              {/en vivo|EN VIVO|subtítulos/i.test(error) && (
                <button
                  type="button"
                  onClick={() => goLiveWith(input.trim())}
                  className="mt-2 rounded-full bg-[var(--danger)] px-4 py-2 text-sm font-bold text-white"
                >
                  🔴 Abrirlo en la pestaña En vivo
                </button>
              )}
            </div>
          )}
          {notice && !analyze.isPending && (
            <p role="status" className="mt-4 rounded-[var(--radius)] bg-[var(--accent-soft)] p-3 text-sm font-medium text-[var(--text)]">
              {notice}
            </p>
          )}
        </form>

        {channel && channel.ok && (
          <section className="mt-6" aria-label="Videos del canal">
            <h2 className="text-lg font-extrabold text-[var(--text)]">{channel.channelName}</h2>
            <p className="text-sm text-[var(--dim)]">
              Estos son sus videos más recientes. Toca uno y te saco los clips.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {channel.videos.map((v) => (
                <button
                  key={v.videoId}
                  type="button"
                  disabled={analyze.isPending}
                  onClick={() => analyzeChannelVideo(v.url)}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left disabled:opacity-60"
                >
                  <span className="block text-sm font-semibold leading-snug text-[var(--text)]">{v.title}</span>
                  {v.publishedAt && (
                    <span className="time-mono mt-0.5 block text-xs text-[var(--dim)]">
                      {new Date(v.publishedAt).toLocaleDateString("es", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mt-10" aria-label="Biblioteca de clips de videos">
          <h2 className="text-2xl font-extrabold text-[var(--text)]">
            Biblioteca{" "}
            {totalClips > 0 && (
              <span className="text-base font-semibold text-[var(--dim)]">· {totalClips} clip(s)</span>
            )}
          </h2>
          {library.isPending && <p className="mt-3 text-sm text-[var(--dim)]">Cargando tu biblioteca…</p>}
          {libraryError}
          {library.isSuccess && videoGroups.length === 0 && (
            <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-5 text-sm leading-relaxed text-[var(--dim)]">
              Tu biblioteca de videos está vacía. Pega arriba el link de un video que te guste y en
              un momento tienes aquí sus mejores clips, ordenados por creador, con el segundo exacto
              para cortarlos. Los clips de en vivo viven en su propia pestaña, «🔴 En vivo · La
              Casa».
            </p>
          )}
          {videoGroups.map((group) => (
            <div key={group.creator} className="mt-6">
              <h3 className="border-b-2 border-[var(--accent)] pb-1 text-lg font-extrabold text-[var(--accent-strong)]">
                {group.creator}
              </h3>
              {group.projects.map((project) => (
                <ProjectCard key={project.id} project={project} options={options} />
              ))}
            </div>
          ))}
        </section>
          </>
        )}

        {tab === "live" && !isBlocked && (
          <div className="mt-5">
            <LiveSection seed={liveSeed} onClipsCreated={(pid) => void startAutoCut(pid)} />
            <section className="mt-8" aria-label="Biblioteca de clips del en vivo">
              <h2 className="text-2xl font-extrabold text-[var(--text)]">
                Clips del en vivo{" "}
                {totalLiveClips > 0 && (
                  <span className="text-base font-semibold text-[var(--dim)]">
                    · {totalLiveClips} clip(s)
                  </span>
                )}
              </h2>
              {library.isPending && (
                <p className="mt-3 text-sm text-[var(--dim)]">Cargando los clips del en vivo…</p>
              )}
              {libraryError}
              {library.isSuccess && liveGroups.length === 0 && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-5 text-sm leading-relaxed text-[var(--dim)]">
                  Todavía no hay clips de en vivo. Cuando la app escuche el chat de un directo y el
                  chat explote, los clips salen aquí solos, en su rejilla: tú solo tendrás que darle
                  a descargar en cada uno.
                </p>
              )}
              {liveGroups.map((group) => (
                <div key={group.creator} className="mt-6">
                  <h3 className="border-b-2 border-[var(--danger)] pb-1 text-lg font-extrabold text-[var(--danger)]">
                    {group.creator}
                  </h3>
                  {group.projects.map((project) => (
                    <ProjectCard key={project.id} project={project} options={options} />
                  ))}
                </div>
              ))}
            </section>
          </div>
        )}

        {tab === "admin" && isAdmin && <AdminPanel />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------- login / sesión
//
// Login system (user, 2026-11-09: «un login / inicio de sesión para
// cada usuario… cada usuario entra con su cuenta (usuario y
// contraseña, o correo y contraseña) y llega a su propio
// espacio/biblioteca aparte. Ronal sigue siendo el admin»).
// The gate below is the ONLY entry: no token in this browser → the
// login screen and nothing else (no library query even fires). With
// a token, the server confirms the session (getSession) before
// MainApp mounts; a dead token is dropped and the login screen comes
// back with a notice. Signing in/out clears the whole query cache so
// one account's library can never bleed into the next account's
// screen on a shared phone.

function LoginScreen({
  notice,
  onSignedIn,
}: {
  notice: string | null;
  onSignedIn: (token: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginM = useMutation({
    mutationFn: () => api.loginAccount({ login: login.trim(), password }),
    onSuccess: (res) => {
      if (res.ok && res.token) onSignedIn(res.token);
      else setError(res.error ?? "No pude iniciar sesión. Inténtalo de nuevo.");
    },
    onError: () => setError("La conexión falló iniciando sesión. Inténtalo de nuevo."),
  });
  const registerM = useMutation({
    mutationFn: () =>
      api.registerAccount({ login: login.trim(), password, displayName: displayName.trim() }),
    onSuccess: (res) => {
      if (res.ok && res.token) onSignedIn(res.token);
      else setError(res.error ?? "No pude crear tu cuenta. Inténtalo de nuevo.");
    },
    onError: () => setError("La conexión falló creando tu cuenta. Inténtalo de nuevo."),
  });
  const busy = loginM.isPending || registerM.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!login.trim()) {
      setError("Escribe tu usuario o tu correo.");
      return;
    }
    if (mode === "register" && password.length < 6) {
      setError("La contraseña necesita al menos 6 caracteres.");
      return;
    }
    if (!password) {
      setError("Escribe tu contraseña.");
      return;
    }
    if (mode === "login") loginM.mutate();
    else registerM.mutate();
  }

  const inputCls =
    "mt-1.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-base text-[var(--text)]";
  const labelCls = "text-sm font-bold text-[var(--text)]";

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-md px-4 pb-10 pt-8">
        <div className="flex flex-col items-center text-center">
          <img
            src={appIcon}
            alt="Ícono de la app Creador de clips con IA"
            className="h-20 w-20 rounded-3xl"
          />
          <h1 className="mt-4 text-2xl font-extrabold leading-tight text-[var(--text)]">
            Creador de clips con IA
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            Entra con tu cuenta y llegas a <strong>tu propio espacio</strong>: tu biblioteca de
            clips es solo tuya, nadie más la ve ni la toca.
          </p>
        </div>

        <div
          className="mt-6 grid grid-cols-2 gap-2"
          role="tablist"
          aria-label="Iniciar sesión o crear una cuenta"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            className={`rounded-[var(--radius)] py-3 text-base font-extrabold ${
              mode === "login"
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
            className={`rounded-[var(--radius)] py-3 text-base font-extrabold ${
              mode === "register"
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            Crear cuenta
          </button>
        </div>

        <form
          onSubmit={onSubmit}
          className="mt-4 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4"
        >
          {notice && (
            <p role="status" className="mb-3 text-sm font-medium text-[var(--accent-strong)]">
              {notice}
            </p>
          )}
          {mode === "register" && (
            <div>
              <label htmlFor="reg-name" className={labelCls}>
                Tu nombre
              </label>
              <input
                id="reg-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={40}
                autoComplete="name"
                placeholder="Como quieres que te vea la app"
                className={inputCls}
              />
            </div>
          )}
          <div className={mode === "register" ? "mt-4" : ""}>
            <label htmlFor="login-id" className={labelCls}>
              Usuario o correo
            </label>
            <input
              id="login-id"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              maxLength={80}
              autoComplete="username"
              autoCapitalize="none"
              placeholder="tuusuario o tucorreo@ejemplo.com"
              className={inputCls}
            />
          </div>
          <div className="mt-4">
            <label htmlFor="login-pass" className={labelCls}>
              Contraseña
            </label>
            <input
              id="login-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder={mode === "register" ? "Mínimo 6 caracteres" : "Tu contraseña"}
              className={inputCls}
            />
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-[var(--radius)] bg-[var(--hot)] py-3.5 text-base font-extrabold text-white disabled:opacity-50"
          >
            {busy
              ? "Un momento…"
              : mode === "login"
                ? "Entrar a mi espacio"
                : "Crear mi cuenta y entrar"}
          </button>
          {mode === "register" && (
            <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
              ¿Eres <strong>Ronal, el dueño</strong>? Crea tu cuenta aquí mismo, en este teléfono:
              queda unida a tu biblioteca de siempre y a tu panel de admin, no a una cuenta nueva.
            </p>
          )}
        </form>
      </main>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => getStoredAuthToken());
  const [notice, setNotice] = useState<string | null>(null);

  const probe = useQuery({
    queryKey: ["sessionProbe", token],
    queryFn: () => api.getSession({ auth: token ?? "" }),
    enabled: token !== null,
    retry: 2,
    retryDelay: (attempt) => Math.min(1200 * 2 ** attempt, 8000),
  });

  useEffect(() => {
    if (token && probe.data && !probe.data.signedIn) {
      setStoredAuthToken(null);
      setToken(null);
      setNotice("Tu sesión anterior venció. Inicia sesión de nuevo para entrar a tu espacio.");
      queryClient.clear();
    }
  }, [token, probe.data, queryClient]);

  function handleSignedIn(newToken: string) {
    queryClient.clear();
    setStoredAuthToken(newToken);
    setNotice(null);
    setToken(newToken);
  }

  async function handleLogout() {
    try {
      await api.logout({});
    } catch {
      // The local sign-out below stands even if the server call fails.
    }
    setStoredAuthToken(null);
    setToken(null);
    setNotice(null);
    queryClient.clear();
  }

  if (token === null) {
    return <LoginScreen notice={notice} onSignedIn={handleSignedIn} />;
  }
  if (probe.data?.signedIn) {
    return <MainApp onLogout={() => void handleLogout()} />;
  }
  if (probe.isError) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <main className="mx-auto w-full max-w-md px-4 pb-10 pt-16 text-center">
          <p className="text-base font-extrabold text-[var(--text)]">
            No pude comprobar tu sesión
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            La conexión falló un momento. Tu cuenta y tu biblioteca están guardadas; toca
            «Reintentar».
          </p>
          <button
            type="button"
            onClick={() => probe.refetch()}
            className="mt-4 rounded-full bg-[var(--accent)] px-6 py-3 text-base font-extrabold text-white"
          >
            Reintentar
          </button>
        </main>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <main className="mx-auto w-full max-w-md px-4 pb-10 pt-16 text-center">
        <p role="status" className="text-base font-bold text-[var(--dim)]">
          Abriendo tu espacio…
        </p>
      </main>
    </div>
  );
}
