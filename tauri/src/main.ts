// BlobTELEvision frontend. Talks directly to the Python API (app/python/blobtv_api.py)
// over HTTP; the Rust shell only owns the engine's process lifecycle.

// Must match API_PORT in src-tauri/src/main.rs. Deliberately not 8420 (BlobVision's
// port) so both apps can run side by side.
const API_BASE = "http://127.0.0.1:8421";
const HEALTH_POLL_MS = 300; // short: the engine usually answers within a couple of seconds
// A fresh install bootstraps a whole Python + PyTorch environment before the API
// exists at all (several minutes), so the initial wait has to be generous.
const ENGINE_STARTUP_TIMEOUT_MS = 40 * 60 * 1000;
const ENGINE_STARTUP_SLOW_HINT_MS = 60000;

// ---------------------------------------------------------------- splash
// Shown for at least SPLASH_MIN_MS so the artwork is seen, then dismissed as soon as the
// engine answers; SPLASH_MAX_MS is the cap when it is slow (the app is usable behind it).
const SPLASH_MIN_MS = 6000;
const SPLASH_MAX_MS = 12000;
const SPLASH_DOTS_INTERVAL_MS = 450;
let splashMinElapsed = false;
let splashEngineReady = false;
let hideSplash: () => void = () => {};
function maybeHideSplash() {
  if (splashMinElapsed && splashEngineReady) hideSplash();
}
function initSplashScreen() {
  const splash = document.getElementById("splash-screen");
  const dots = document.getElementById("splash-dots");
  if (!splash) return;
  let dotCount = 0;
  const dotsTimer = window.setInterval(() => {
    if (dots) dots.textContent = ".".repeat(dotCount);
    dotCount = (dotCount + 1) % 4;
  }, SPLASH_DOTS_INTERVAL_MS);
  let hidden = false;
  hideSplash = () => {
    if (hidden) return;
    hidden = true;
    clearInterval(dotsTimer);
    splash.classList.add("hide");
    setTimeout(() => splash.remove(), 700);
  };
  setTimeout(() => {
    splashMinElapsed = true;
    maybeHideSplash();
  }, SPLASH_MIN_MS);
  setTimeout(hideSplash, SPLASH_MAX_MS);
}
// A type="module" script can run after DOMContentLoaded already fired.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initSplashScreen);
} else {
  initSplashScreen();
}

// ---------------------------------------------------------------- types
type Kind = "t2v" | "i2v";
type ModelKey = Kind | "esrgan" | "rife";

interface ModelStatus {
  ready: boolean;
  installing: boolean;
  progress: string | null;
}

interface JobSnapshot {
  phase: string;
  state: "running" | "done" | "error" | "cancelled";
  lines: string[];
  step: number;
  total: number;
  output_url: string | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

interface FormatMap {
  [key: string]: { width: number; height: number };
}

// ---------------------------------------------------------------- dom
function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error("Missing element: " + selector);
  return el;
}

const engineStatusEl = $<HTMLDivElement>("#engine-status");
const fastBootEl = $<HTMLInputElement>("#fast-boot-checkbox");
const modeBlurbEl = $<HTMLParagraphElement>("#mode-blurb");
const generateBtn = $<HTMLButtonElement>("#generate-btn");
const abortBtn = $<HTMLButtonElement>("#abort-btn");
const initFieldEl = $<HTMLDivElement>("#init-field");
const initDropEl = $<HTMLDivElement>("#init-drop");
const initHintEl = $<HTMLSpanElement>("#init-hint");
const initPreviewEl = $<HTMLImageElement>("#init-preview");
const initFileEl = $<HTMLInputElement>("#init-file");
const promptEl = $<HTMLTextAreaElement>("#prompt");
const negativeEl = $<HTMLInputElement>("#negative-prompt");
const formatEl = $<HTMLSelectElement>("#format");
const framesEl = $<HTMLInputElement>("#frames");
const fpsEl = $<HTMLInputElement>("#fps");
const stepsEl = $<HTMLInputElement>("#steps");
const guidanceEl = $<HTMLInputElement>("#guidance");
const seedEl = $<HTMLInputElement>("#seed");
const bootstrapPanelEl = $<HTMLDivElement>("#bootstrap-panel");
const bootstrapConsoleEl = $<HTMLPreElement>("#bootstrap-console");
const bootstrapTitleEl = $<HTMLSpanElement>("#bootstrap-title");
const bootstrapStepEl = $<HTMLParagraphElement>("#bootstrap-step");
const bootstrapFillEl = $<HTMLDivElement>("#bootstrap-fill");
const bootstrapElapsedEl = $<HTMLParagraphElement>("#bootstrap-elapsed");
const modelsPanelEl = $<HTMLDivElement>("#models-panel");
const modelsInstallBtnEl = $<HTMLButtonElement>("#models-install-btn");
const modelsInstallStatusEl = $<HTMLParagraphElement>("#models-install-status");
const outputEmptyEl = $<HTMLDivElement>("#output-empty");
const emptyHintEl = $<HTMLParagraphElement>("#empty-hint");
const outputTitleEl = $<HTMLParagraphElement>("#output-title");
const livePreviewEl = $<HTMLImageElement>("#live-preview");
const outputVideoEl = $<HTMLVideoElement>("#output-video");
const useFrameBtn = $<HTMLButtonElement>("#use-frame-btn");
const initFromTvBtn = $<HTMLButtonElement>("#init-from-tv");
const jobLogEl = $<HTMLPreElement>("#job-log");
const galleryEl = $<HTMLDivElement>("#gallery");
const upscaleEl = $<HTMLSelectElement>("#upscale");
const interpEl = $<HTMLSelectElement>("#interp");
const reduxHintEl = $<HTMLParagraphElement>("#redux-hint");
const reduxInstallBtn = $<HTMLButtonElement>("#redux-install-btn");
const formatWarningEl = $<HTMLDivElement>("#format-warning");

const MODEL_KEYS: ModelKey[] = ["t2v", "i2v", "esrgan", "rife"];
const MODEL_CHECKBOXES = Object.fromEntries(
  MODEL_KEYS.map((k) => [k, $<HTMLInputElement>("#cb-" + k)]),
) as Record<ModelKey, HTMLInputElement>;
const MODEL_PROGRESS = Object.fromEntries(
  MODEL_KEYS.map((k) => [k, $<HTMLSpanElement>("#progress-" + k)]),
) as Record<ModelKey, HTMLSpanElement>;
const MODEL_UNINSTALL = Object.fromEntries(
  MODEL_KEYS.map((k) => [k, $<HTMLButtonElement>("#un-" + k)]),
) as Record<ModelKey, HTMLButtonElement>;
const modelsTitleEl = $<HTMLParagraphElement>("#models-title");
const modelsCloseBtnEl = $<HTMLButtonElement>("#models-close-btn");
// Set by the top-bar "Models" button: keeps the panel open even when everything is installed.
let modelsPanelPinned = false;

// ---------------------------------------------------------------- state
const MODE_BLURBS: Record<Kind, string> = {
  t2v: "ModelScope text-to-video (2023, 1.7B). 256 px native, short clips, faces that melt.",
  i2v: "I2VGen-XL: animates a source image. Heavy, uses CPU offload, much slower. Prefer the smaller formats.",
};

// Per-mode defaults, applied when the mode changes.
const MODE_DEFAULTS: Record<Kind, { frames: number; fps: number; steps: number; guidance: number; format: string }> = {
  t2v: { frames: 16, fps: 8, steps: 25, guidance: 9, format: "256x256" },
  i2v: { frames: 16, fps: 8, steps: 30, guidance: 9, format: "640x352" },
};

let formats: { t2v: FormatMap; i2v: FormatMap } | null = null;
let modelsStatus: Record<ModelKey, ModelStatus> | null = null;
let uploadId: string | null = null;
let lastSeed: number | null = null;
let engineUp = false;
let generating = false;
let pendingInstall: Set<ModelKey> = new Set();

function currentKind(): Kind {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return (checked?.value as Kind) ?? "t2v";
}

// Which optional Redux tools the current upscale / interpolation choice needs.
function reduxNeeds(): ModelKey[] {
  const need: ModelKey[] = [];
  if (upscaleEl.value.startsWith("esrgan")) need.push("esrgan");
  if (Number(interpEl.value) > 1) need.push("rife");
  return need;
}

function reduxMissing(): ModelKey[] {
  if (!modelsStatus) return reduxNeeds();
  return reduxNeeds().filter((k) => !modelDone(modelsStatus![k]));
}

const REDUX_HINT_DEFAULT =
  "Pushes the tiny native output past what the model can do. Ugly is fine, that is the point.";

function updateReduxUi() {
  const missing = reduxMissing();
  const installing = modelsStatus ? missing.filter((k) => modelsStatus![k].installing) : [];
  reduxInstallBtn.hidden = missing.length === 0;
  reduxInstallBtn.disabled = installing.length > 0;
  if (installing.length > 0 && modelsStatus) {
    reduxHintEl.textContent = installing.map((k) => modelsStatus![k].progress ?? "starting...").join(" | ");
  } else if (missing.length > 0) {
    const sizes: Record<string, string> = { esrgan: "Real-ESRGAN ~140 MB", rife: "RIFE ~430 MB download" };
    reduxHintEl.textContent =
      "Needs a small one-time download (" +
      missing.map((k) => sizes[k]).join(", ") +
      "). Nothing is fetched until you click.";
  } else {
    reduxHintEl.textContent = REDUX_HINT_DEFAULT;
  }
  updateGenerateEnabled();
}
upscaleEl.addEventListener("change", updateReduxUi);
interpEl.addEventListener("change", updateReduxUi);

reduxInstallBtn.addEventListener("click", async () => {
  const targets = reduxMissing().filter((k) => !(modelsStatus && modelsStatus[k].installing));
  if (targets.length === 0) return;
  reduxInstallBtn.disabled = true;
  reduxHintEl.textContent = "starting...";
  try {
    await fetchJson("/models/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
  } catch (err) {
    reduxHintEl.textContent = "Install failed to start: " + (err as Error).message;
    reduxInstallBtn.disabled = false;
    return;
  }
  const poll = async () => {
    await refreshModels();
    if (reduxMissing().some((k) => modelsStatus && modelsStatus[k].installing)) setTimeout(poll, 1500);
    else {
      // Finished or failed: surface a failure message if the tool is still missing.
      const failed = reduxMissing().find((k) => (modelsStatus![k].progress ?? "").startsWith("Failed"));
      if (failed) reduxHintEl.textContent = modelsStatus![failed].progress ?? "Install failed.";
    }
  };
  setTimeout(poll, 1500);
});

function setEngineStatus(text: string, cls: "status-pending" | "status-ok" | "status-error") {
  engineStatusEl.textContent = text;
  engineStatusEl.className = "status " + cls;
}

function errorDetailToString(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((item) =>
      item && typeof item === "object" && "msg" in item ? String((item as any).msg) : JSON.stringify(item),
    );
    if (msgs.length) return msgs.join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return fallback;
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(API_BASE + path, init);
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      // not JSON: keep statusText
    }
    throw new Error(errorDetailToString(detail, res.statusText));
  }
  return res.json();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- sliders / mode
function bindSlider(input: HTMLInputElement, valueId: string, fmt: (v: number) => string = (v) => String(v)) {
  const out = $<HTMLSpanElement>(valueId);
  const update = () => (out.textContent = fmt(Number(input.value)));
  input.addEventListener("input", update);
  update();
}
bindSlider(framesEl, "#frames-value");
bindSlider(fpsEl, "#fps-value");
bindSlider(stepsEl, "#steps-value");
bindSlider(guidanceEl, "#guidance-value", (v) => v.toFixed(1));

function setSlider(input: HTMLInputElement, value: number) {
  input.value = String(value);
  input.dispatchEvent(new Event("input"));
}

function populateFormats(kind: Kind, preferred?: string) {
  formatEl.innerHTML = "";
  if (!formats) return;
  const map = formats[kind];
  for (const key of Object.keys(map)) {
    const opt = document.createElement("option");
    opt.value = key;
    const note =
      kind === "t2v" && key === "256x256"
        ? "  (native)"
        : kind === "i2v" && key === "1280x704"
          ? "  (native, heavy)"
          : kind === "i2v" && key === "640x352"
            ? "  (fast)"
            : "";
    opt.textContent = key.replace("x", " × ") + note;
    formatEl.appendChild(opt);
  }
  if (preferred && map[preferred]) formatEl.value = preferred;
}

// Formats that only really work on big GPUs (same pixel count either way).
const HEAVY_FORMATS: Record<Kind, string[]> = { t2v: [], i2v: ["1280x704", "704x1280"] };

function updateFormatWarning() {
  formatWarningEl.hidden = !HEAVY_FORMATS[currentKind()].includes(formatEl.value);
  if (formatWarningEl.hidden) formatWarningEl.classList.remove("open");
}
formatEl.addEventListener("change", updateFormatWarning);
// Hover shows the bubble (CSS); a click toggles it too, for touchpads and keyboard users.
formatWarningEl.addEventListener("click", (e) => {
  e.stopPropagation();
  formatWarningEl.classList.toggle("open");
});
document.addEventListener("click", () => formatWarningEl.classList.remove("open"));

function applyMode() {
  const kind = currentKind();
  const d = MODE_DEFAULTS[kind];
  modeBlurbEl.textContent = MODE_BLURBS[kind];
  setSlider(framesEl, d.frames);
  setSlider(fpsEl, d.fps);
  setSlider(stepsEl, d.steps);
  setSlider(guidanceEl, d.guidance);
  populateFormats(kind, d.format);
  updateFormatWarning();
  initFieldEl.hidden = kind !== "i2v";
  updateGenerateEnabled();
  updateEmptyHint();
}
document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => r.addEventListener("change", applyMode));

function modelReady(kind: Kind): boolean {
  if (!modelsStatus) return false;
  const s = modelsStatus[kind];
  return s.ready && !s.installing;
}

function updateGenerateEnabled() {
  const kind = currentKind();
  const needsImage = kind === "i2v" && !uploadId;
  generateBtn.disabled = generating || !engineUp || !modelReady(kind) || needsImage || reduxMissing().length > 0;
}

function updateEmptyHint() {
  const kind = currentKind();
  if (!engineUp) {
    emptyHintEl.textContent = "Waiting for the engine...";
  } else if (!modelReady(kind)) {
    emptyHintEl.textContent = "Install the model weights first.";
  } else if (kind === "i2v" && !uploadId) {
    emptyHintEl.textContent = "Pick a source image, write a prompt, hit DEGENERATE.";
  } else {
    emptyHintEl.textContent = "Write a prompt and hit DEGENERATE.";
  }
}

// ---------------------------------------------------------------- seed
$<HTMLButtonElement>("#seed-random").addEventListener("click", () => {
  seedEl.value = "";
});
$<HTMLButtonElement>("#seed-last").addEventListener("click", () => {
  if (lastSeed !== null) seedEl.value = String(lastSeed);
});

// ---------------------------------------------------------------- init image
async function setInitFile(file: File) {
  initHintEl.textContent = "Uploading...";
  try {
    const form = new FormData();
    form.append("image", file);
    const res = await fetchJson("/upload", { method: "POST", body: form });
    uploadId = res.upload_id;
    initPreviewEl.src = URL.createObjectURL(file);
    initPreviewEl.hidden = false;
    initHintEl.hidden = true;
  } catch (err) {
    uploadId = null;
    initHintEl.hidden = false;
    initHintEl.textContent = "Upload failed: " + (err as Error).message;
  }
  updateGenerateEnabled();
  updateEmptyHint();
}
initFileEl.addEventListener("change", () => {
  const f = initFileEl.files?.[0];
  if (f) void setInitFile(f);
});
initDropEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  initDropEl.classList.add("over");
});
initDropEl.addEventListener("dragleave", () => initDropEl.classList.remove("over"));
initDropEl.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation(); // the window-level handler would load it a second time
  initDropEl.classList.remove("over");
  useDroppedImage(e.dataTransfer?.files?.[0]);
});

// Drop an image anywhere on the window: it becomes the source image (switching to image -> videslop).
// Without this, a drop that misses the box would make the webview navigate to the file.
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
function useDroppedImage(f: File | undefined) {
  if (!f || !f.type.startsWith("image/")) return;
  switchToI2v();
  void setInitFile(f);
}
function switchToI2v() {
  if (currentKind() === "i2v") return;
  const r = document.querySelector<HTMLInputElement>('input[name="mode"][value="i2v"]');
  if (r) {
    r.checked = true;
    applyMode();
  }
}
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  useDroppedImage(e.dataTransfer?.files?.[0]);
});

// Use the frame currently showing on the TV (a finished videslop picked from the shelf) as the source image.
function tvFrameReady(): boolean {
  return !outputVideoEl.hidden && outputVideoEl.videoWidth > 0 && outputVideoEl.readyState >= 2;
}
function updateFrameButtons() {
  const ok = tvFrameReady() && !generating;
  useFrameBtn.hidden = !ok;
  initFromTvBtn.disabled = !ok;
}
async function useTvFrame() {
  if (!tvFrameReady()) return;
  outputVideoEl.pause();
  const canvas = document.createElement("canvas");
  canvas.width = outputVideoEl.videoWidth;
  canvas.height = outputVideoEl.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  try {
    ctx.drawImage(outputVideoEl, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("could not read the frame");
    switchToI2v();
    await setInitFile(new File([blob], "tv-frame.png", { type: "image/png" }));
  } catch (err) {
    initHintEl.hidden = false;
    initHintEl.textContent = "Frame capture failed: " + (err as Error).message;
  }
}
useFrameBtn.addEventListener("click", () => void useTvFrame());
initFromTvBtn.addEventListener("click", () => void useTvFrame());
["loadeddata", "emptied", "seeked", "pause", "play"].forEach((ev) => outputVideoEl.addEventListener(ev, updateFrameButtons));

// ---------------------------------------------------------------- fast reboot
async function initFastBoot() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    fastBootEl.checked = await invoke<boolean>("get_fast_boot");
    fastBootEl.addEventListener("change", () => {
      void invoke("set_fast_boot", { enabled: fastBootEl.checked });
    });
  } catch {
    // Not running inside Tauri (plain browser dev): hide the toggle.
    $("#fast-boot-toggle").hidden = true;
  }
}

$<HTMLButtonElement>("#open-outputs-btn").addEventListener("click", async () => {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_outputs_folder");
  } catch {
    // browser dev: nothing to open
  }
});

// ---------------------------------------------------------------- TV progress bar
// The speaker grille under the screen doubles as a progress bar: its slats light
// up one by one from yellow to red, and the red LED is on whenever anything works.
// A number is a 0..1 fraction, null is "busy, unknown progress" (a light sweeps
// across), undefined is "idle". Generation wins over downloads, which win over startup.
const TV_SEGMENTS = 28;
const tvGrilleEl = $<HTMLDivElement>("#tv-grille");
const tvLedEl = $<HTMLDivElement>("#tv-led");
const tvSegs: HTMLElement[] = [];
for (let i = 0; i < TV_SEGMENTS; i++) {
  const seg = document.createElement("i");
  const hue = Math.round(55 - (55 * i) / (TV_SEGMENTS - 1)); // 55 = yellow ... 0 = red
  seg.style.setProperty("--c", "hsl(" + hue + " 100% 52%)");
  tvGrilleEl.appendChild(seg);
  tvSegs.push(seg);
}
type TvValue = number | null | undefined;
type TvSource = "gen" | "load" | "models" | "startup";
const TV_PRIORITY: TvSource[] = ["gen", "load", "models", "startup"];
const tvSources: Record<TvSource, TvValue> = {
  gen: undefined,
  load: undefined,
  models: undefined,
  startup: undefined,
};
let tvScanTimer: number | null = null;
let tvScanPos = 0;

function tvLight(isOn: (i: number) => boolean) {
  tvSegs.forEach((seg, i) => seg.classList.toggle("on", isOn(i)));
}
function tvStopScan() {
  if (tvScanTimer !== null) {
    clearInterval(tvScanTimer);
    tvScanTimer = null;
  }
}
function tvRender() {
  const key = TV_PRIORITY.find((k) => tvSources[k] !== undefined);
  tvLedEl.classList.toggle("on", key !== undefined);
  const v = key === undefined ? undefined : tvSources[key];
  if (typeof v === "number") {
    tvStopScan();
    const lit = Math.round(Math.min(1, Math.max(0, v)) * TV_SEGMENTS);
    tvLight((i) => i < Math.max(lit, v > 0 ? 1 : 0));
  } else if (v === null) {
    if (tvScanTimer === null) {
      tvScanTimer = window.setInterval(() => {
        tvScanPos = (tvScanPos + 1) % (TV_SEGMENTS + 5);
        tvLight((i) => i <= tvScanPos && i > tvScanPos - 5);
      }, 70);
    }
  } else {
    tvStopScan();
    tvLight(() => false);
  }
}
function tvSet(source: TvSource, value: TvValue) {
  tvSources[source] = value;
  tvRender();
}

// ---------------------------------------------------------------- about / credits
const aboutOverlayEl = $<HTMLDivElement>("#about-overlay");
function setAboutOpen(open: boolean) {
  aboutOverlayEl.hidden = !open;
  if (open) $<HTMLDivElement>("#about-body").scrollTop = 0;
}
$<HTMLButtonElement>("#about-btn").addEventListener("click", () => setAboutOpen(true));
$<HTMLButtonElement>("#about-close").addEventListener("click", () => setAboutOpen(false));
aboutOverlayEl.addEventListener("click", (e) => {
  if (e.target === aboutOverlayEl) setAboutOpen(false); // click outside the dialog
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !aboutOverlayEl.hidden) setAboutOpen(false);
});
// Links go to the system browser: left alone, the webview would navigate away from the app.
aboutOverlayEl.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ext]");
  if (!a) return;
  e.preventDefault();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external", { url: a.href });
  } catch {
    window.open(a.href, "_blank", "noopener"); // browser dev mode
  }
});

// ---------------------------------------------------------------- TV knobs
// Small knob = SCAN (scanlines, then rolling bar + grain, then jitter), big knob =
// GLASS (glare, vignette, bloom, then colour fringing). Click to go to the next
// notch; after the last one it comes back to OFF. Both are OFF by default.
const outputBoxEl = $<HTMLDivElement>("#output-box");
const KNOB_ANGLES = [-130, -45, 45, 130]; // off, low, medium, heavy
const KNOB_LEVEL_NAMES = ["off", "low", "medium", "heavy"];
const KNOB_STORAGE_PREFIX = "blobtv.knob.";

function setKnob(name: "scan" | "glass", level: number, save: boolean) {
  const knob = $<HTMLButtonElement>("#knob-" + name);
  outputBoxEl.dataset[name] = String(level);
  knob.style.setProperty("--a", KNOB_ANGLES[level] + "deg");
  const title = (name === "scan" ? "Scanlines and interference: " : "CRT glass glow: ") + KNOB_LEVEL_NAMES[level];
  knob.title = title + " (click to change)";
  knob.setAttribute("aria-label", title);
  document
    .querySelectorAll<HTMLElement>('.tv-pips[data-for="' + name + '"] i')
    .forEach((pip, i) => pip.classList.toggle("on", level >= i + 1));
  if (save) {
    try {
      localStorage.setItem(KNOB_STORAGE_PREFIX + name, String(level));
    } catch {
      // storage can be unavailable: the setting just will not be remembered
    }
  }
}
(["scan", "glass"] as const).forEach((name) => {
  let level = 0;
  try {
    const saved = Number(localStorage.getItem(KNOB_STORAGE_PREFIX + name));
    if (Number.isInteger(saved) && saved >= 0 && saved < KNOB_ANGLES.length) level = saved;
  } catch {
    // no storage: stay OFF
  }
  setKnob(name, level, false);
  $<HTMLButtonElement>("#knob-" + name).addEventListener("click", () => {
    level = (level + 1) % KNOB_ANGLES.length;
    setKnob(name, level, true);
  });
});

// ---------------------------------------------------------------- engine startup
let bootstrapLogOffset = 0;
// Tails logs/bootstrap.log through the Rust side: the one phase with no HTTP
// endpoint to poll, since the Python API does not exist yet while it runs.
async function pollBootstrapLog(): Promise<boolean> {
  let text: string;
  let newOffset: number;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    [text, newOffset] = await invoke<[string, number]>("read_bootstrap_log", { offset: bootstrapLogOffset });
  } catch {
    return false;
  }
  if (newOffset < bootstrapLogOffset) bootstrapConsoleEl.textContent = "";
  bootstrapLogOffset = newOffset;
  if (!text) return bootstrapLogSeen;
  bootstrapLogSeen = true;
  bootstrapConsoleEl.textContent += text;
  bootstrapConsoleEl.scrollTop = bootstrapConsoleEl.scrollHeight;
  // Lines look like "[bootstrap] [4/5] Installing PyTorch ..." (see bootstrap_venv.ps1).
  const steps = Array.from(text.matchAll(/\[(\d+)\/(\d+)\]\s*(.*)/g));
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    bootstrapStep = { n: Number(last[1]), total: Number(last[2]), label: last[3].trim(), since: Date.now() };
  }
  if (/Bootstrap complete/.test(text)) bootstrapStep = { n: 0, total: 0, label: "Environment ready, starting the engine...", since: Date.now() };
  return true;
}

let bootstrapLogSeen = false;
let bootstrapStep: { n: number; total: number; label: string; since: number } | null = null;
// Rough share of the whole setup each step takes (PyTorch dominates). The bar
// creeps toward the next step's start so it never looks frozen during the long ones.
const STEP_START = [0, 0, 6];
const STEP_TAU_S = [0, 10, 240];

function renderStartup(startedAt: number) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  // Show the screen as soon as startup is visibly slow, or as soon as there is a log to show.
  if (bootstrapLogSeen || elapsed >= 2) {
    bootstrapPanelEl.hidden = false;
    outputEmptyEl.hidden = true;
  }
  if (bootstrapLogSeen) {
    bootstrapTitleEl.textContent = bootstrapStep && bootstrapStep.n > 0 ? "Setting up the Python environment" : "Starting the engine";
    if (bootstrapStep && bootstrapStep.n > 0) {
      bootstrapStepEl.textContent = "Step " + bootstrapStep.n + " / " + bootstrapStep.total + ": " + bootstrapStep.label;
      const n = Math.min(bootstrapStep.n, STEP_START.length - 1);
      const from = STEP_START[n];
      const to = n + 1 < STEP_START.length ? STEP_START[n + 1] : 100;
      const t = (Date.now() - bootstrapStep.since) / 1000;
      bootstrapFillEl.style.width = from + (to - from) * (1 - Math.exp(-t / STEP_TAU_S[n])) + "%";
    } else {
      bootstrapStepEl.textContent = bootstrapStep ? bootstrapStep.label : "Starting...";
      bootstrapFillEl.style.width = "100%";
    }
    bootstrapElapsedEl.textContent = "Elapsed " + mm + ":" + ss + ". First launch only, later launches skip this.";
  } else {
    bootstrapTitleEl.textContent = "Starting the engine";
    bootstrapStepEl.textContent = "Loading Python and the API...";
    bootstrapFillEl.style.width = Math.min(90, 100 * (1 - Math.exp(-elapsed / 8))) + "%";
    bootstrapElapsedEl.textContent = "Elapsed " + mm + ":" + ss;
  }
  if (bootstrapLogSeen || elapsed >= 2) tvSet("startup", parseFloat(bootstrapFillEl.style.width) / 100);
}

async function waitForEngine() {
  const start = Date.now();
  let shownSlowHint = false;
  while (Date.now() - start < ENGINE_STARTUP_TIMEOUT_MS) {
    try {
      await fetchJson("/health");
      bootstrapPanelEl.hidden = true;
      outputEmptyEl.hidden = false;
      tvSet("startup", undefined);
      splashEngineReady = true;
      maybeHideSplash();
      engineUp = true;
      setEngineStatus("Engine reachable", "status-ok");
      formats = await fetchJson("/formats");
      applyMode();
      await refreshModels();
      void refreshGallery();
      void warmupIfReady();
      return;
    } catch {
      const bootstrapping = await pollBootstrapLog();
      renderStartup(start);
      if (!shownSlowHint && (bootstrapping || Date.now() - start > ENGINE_STARTUP_SLOW_HINT_MS)) {
        shownSlowHint = true;
        setEngineStatus(
          "Still starting... first launch downloads a Python environment, speed depends on your connection and disk.",
          "status-pending",
        );
      }
    }
    await sleep(HEALTH_POLL_MS);
  }
  setEngineStatus("Engine unreachable. Is blobtv_api.py running on :8421?", "status-error");
}

// ---------------------------------------------------------------- models
function modelDone(s: ModelStatus) {
  return s.ready && !s.installing;
}

const MANUAL_FALLBACK: Record<ModelKey, string> = {
  esrgan:
    "Manual fallback: put RealESRGAN_x2plus.pth and RealESRGAN_x4plus.pth (github.com/xinntao/Real-ESRGAN releases) into models/upscale/.",
  rife:
    "Manual fallback: unzip rife-ncnn-vulkan (github.com/nihui/rife-ncnn-vulkan releases, windows.zip) so rife-ncnn-vulkan.exe sits directly in models/rife/ next to its model folders.",
  t2v: 'Manual fallback: download "damo-vilab/text-to-video-ms-1.7b" from huggingface.co (fp16 safetensors, diffusers layout) into models/modelscope-t2v/, then create an empty file named .blobtv_complete in that folder.',
  i2v: 'Manual fallback: download "ali-vilab/i2vgen-xl" from huggingface.co (fp16 safetensors, diffusers layout) into models/i2vgen-xl/, then create an empty file named .blobtv_complete in that folder.',
};

// Combined download progress for everything currently installing, weighted by size.
// Progress text looks like "Downloading X (0.4 / ~3.7 GB)"; anything that does not
// parse (zip extraction, tiny files) counts as busy with unknown progress.
function modelsProgressFraction(status: Record<ModelKey, ModelStatus>): TvValue {
  let got = 0;
  let total = 0;
  let any = false;
  let unknown = false;
  for (const key of Object.keys(status) as ModelKey[]) {
    const s = status[key];
    if (!s.installing) continue;
    any = true;
    const m = /\(([\d.]+)\s*\/\s*~?([\d.]+)\s*GB\)/.exec(s.progress ?? "");
    if (m) {
      got += Number(m[1]);
      total += Number(m[2]);
    } else {
      unknown = true;
    }
  }
  if (!any) return undefined;
  if (unknown || total <= 0) return null;
  return got / total;
}

async function refreshModels(): Promise<boolean> {
  let status: Record<ModelKey, ModelStatus>;
  try {
    status = await fetchJson("/models/status");
  } catch {
    return true;
  }
  modelsStatus = status;
  tvSet("models", modelsProgressFraction(status));
  updateReduxUi();
  MODEL_KEYS.forEach((key) => {
    const cb = MODEL_CHECKBOXES[key];
    const done = modelDone(status[key]);
    cb.checked = done ? true : cb.checked;
    cb.disabled = status[key].ready || status[key].installing;
    cb.closest(".models-row")!.classList.toggle("models-row-done", done);
    MODEL_PROGRESS[key].textContent = done ? "installed" : status[key].progress ?? "not installed";
    // Uninstall only for what is installed and not busy; the two-click confirm resets on every refresh.
    const un = MODEL_UNINSTALL[key];
    un.hidden = !done;
    un.disabled = generating;
    if (!un.classList.contains("confirm")) un.textContent = "Uninstall";
  });
  modelsTitleEl.textContent = modelDone(status.t2v) ? "Models" : "Model weights not installed";
  modelsCloseBtnEl.hidden = !modelsPanelPinned;
  if (pendingInstall.size > 0) {
    const failed = Array.from(pendingInstall).filter((k) => !status[k].installing && !modelDone(status[k]));
    modelsInstallStatusEl.hidden = failed.length === 0;
    modelsInstallStatusEl.textContent = failed.map((k) => MANUAL_FALLBACK[k]).join("\n");
    const stillGoing = Array.from(pendingInstall).some((k) => status[k].installing);
    if (!stillGoing) {
      modelsInstallBtnEl.disabled = false;
      const anyFailed = failed.length > 0;
      pendingInstall = new Set();
      if (!anyFailed) void warmupIfReady();
    }
  }
  // Decided last, once pendingInstall has been settled above: only text-to-video
  // is mandatory, so the panel collapses as soon as it is installed, unless a
  // download is still running or a failure message is waiting to be read.
  modelsPanelEl.hidden =
    !modelsPanelPinned &&
    modelDone(status.t2v) &&
    pendingInstall.size === 0 &&
    !status.i2v.installing &&
    modelsInstallStatusEl.hidden;
  updateGenerateEnabled();
  updateEmptyHint();
  return modelDone(status.t2v);
}

// Top-bar "Models" button: bring the install screen back to see what is installed.
$<HTMLButtonElement>("#models-btn").addEventListener("click", () => {
  modelsPanelPinned = !modelsPanelPinned;
  modelsInstallStatusEl.hidden = true;
  void refreshModels();
});
modelsCloseBtnEl.addEventListener("click", () => {
  modelsPanelPinned = false;
  modelsInstallStatusEl.hidden = true;
  void refreshModels();
});

// Uninstall a la carte. First click arms it ("Really delete?"), second click within 4 s does it.
MODEL_KEYS.forEach((key) => {
  const btn = MODEL_UNINSTALL[key];
  let armTimer: number | null = null;
  btn.addEventListener("click", async () => {
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = "Really delete?";
      armTimer = window.setTimeout(() => {
        btn.classList.remove("confirm");
        btn.textContent = "Uninstall";
      }, 4000);
      return;
    }
    if (armTimer !== null) clearTimeout(armTimer);
    btn.classList.remove("confirm");
    btn.disabled = true;
    btn.textContent = "Deleting...";
    try {
      const res = await fetchJson("/models/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [key] }),
      });
      if (!res.ok) throw new Error(Object.values(res.errors as Record<string, string>).join("; "));
    } catch (err) {
      modelsInstallStatusEl.hidden = false;
      modelsInstallStatusEl.textContent = "Uninstall failed: " + (err as Error).message;
    }
    await refreshModels();
    if (key === "t2v") void warmupIfReady(); // refreshes the engine status text
  });
});

modelsInstallBtnEl.addEventListener("click", async () => {
  const targets = MODEL_KEYS.filter(
    (k) => MODEL_CHECKBOXES[k].checked && !MODEL_CHECKBOXES[k].disabled,
  );
  if (targets.length === 0) return;
  modelsInstallBtnEl.disabled = true;
  modelsInstallStatusEl.hidden = true;
  targets.forEach((k) => (MODEL_PROGRESS[k].textContent = "starting..."));
  try {
    await fetchJson("/models/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
  } catch (err) {
    modelsInstallStatusEl.hidden = false;
    modelsInstallStatusEl.textContent = "Install failed to start: " + (err as Error).message;
    modelsInstallBtnEl.disabled = false;
    return;
  }
  pendingInstall = new Set(targets);
  const poll = async () => {
    await refreshModels();
    if (pendingInstall.size > 0) setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
});

// Load the text-to-video model in the background so the first DEGENERATE is not
// a cold load. Safe to call repeatedly.
async function warmupIfReady() {
  if (!modelsStatus || !modelDone(modelsStatus.t2v)) {
    setEngineStatus("Engine reachable. Weights missing.", "status-pending");
    return;
  }
  setEngineStatus("Loading ModelScope...", "status-pending");
  // Loading a multi-GB model has no real progress to report: the grille sweeps and the LED is on.
  tvSet("load", null);
  try {
    await fetchJson("/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "t2v" }),
    });
  } catch {
    // a failed warmup just means the first Generate pays the load itself
  }
  try {
    for (let i = 0; i < 600; i++) {
      try {
        const st = await fetchJson("/status");
        if (st.loaded) {
          setEngineStatus("Ready (" + st.loaded + " loaded)", "status-ok");
          return;
        }
        if (!st.loading && st.error) {
          setEngineStatus("Load failed: " + st.error, "status-error");
          return;
        }
      } catch {
        return;
      }
      await sleep(1000);
    }
  } finally {
    tvSet("load", undefined);
  }
}

// ---------------------------------------------------------------- generation
function resolveSeed(): number | null {
  const raw = seedEl.value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function showOutputState(state: "empty" | "preview" | "video") {
  outputEmptyEl.hidden = state !== "empty";
  livePreviewEl.hidden = state !== "preview";
  outputVideoEl.hidden = state !== "video";
  if (state !== "video") outputVideoEl.pause();
  updateFrameButtons();
}

function showVideo(url: string) {
  showOutputState("video");
  updateFrameButtons();
  outputVideoEl.src = API_BASE + url + "?t=" + Date.now();
  void outputVideoEl.play().catch(() => {});
  document.querySelectorAll(".gallery-item").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.url === url);
  });
}

let previewTimer: number | null = null;
function startPreviewPolling() {
  stopPreviewPolling();
  const tick = () => {
    const probe = new Image();
    probe.onload = () => {
      if (!generating) return;
      livePreviewEl.src = probe.src;
      if (outputVideoEl.hidden) showOutputState("preview");
    };
    // A 404 before the first preview exists is normal: just ignore it.
    probe.src = API_BASE + "/outputs/_live_preview.png?t=" + Date.now();
    previewTimer = window.setTimeout(tick, 1500);
  };
  tick();
}
function stopPreviewPolling() {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}

// While no video or preview is on the screen (model load/swap, i2v denoising, encoding), say on the
// screen itself what the engine is doing and for how long, instead of a static "warming up" line.
let screenPhase = "";
let screenPhaseSince = 0;
function renderScreenStatus(job: JobSnapshot) {
  if (outputEmptyEl.hidden || !job.phase) return;
  if (job.phase !== screenPhase) {
    screenPhase = job.phase;
    screenPhaseSince = Date.now();
  }
  const secs = Math.round((Date.now() - screenPhaseSince) / 1000);
  const loading = /^(Loading|Unloading)/.test(job.phase);
  outputTitleEl.textContent = job.total > 0 ? job.phase + " " + job.step + " / " + job.total : job.phase + "...";
  emptyHintEl.textContent = loading
    ? "Swapping models: reading the weights from disk can take a while the first time. " + secs + " s"
    : secs + " s";
}

function renderProgress(job: JobSnapshot) {
  tvSet("gen", job.total > 0 ? job.step / job.total : null);
  renderScreenStatus(job);
  jobLogEl.textContent = job.lines.join("\n");
  jobLogEl.scrollTop = jobLogEl.scrollHeight;
}

function setGenerating(on: boolean) {
  generating = on;
  tvSet("gen", on ? null : undefined);
  generateBtn.hidden = on;
  abortBtn.hidden = !on;
  updateFrameButtons();
  updateGenerateEnabled();
}

async function onGenerate() {
  const kind = currentKind();
  if (kind === "t2v" && !promptEl.value.trim()) {
    emptyHintEl.textContent = "Write a prompt first.";
    return;
  }
  setGenerating(true);
  screenPhase = "";
  outputTitleEl.textContent = "Nothing on the air";
  jobLogEl.textContent = "starting...";
  showOutputState("empty");
  emptyHintEl.textContent = "Warming up the tubes...";
  setEngineStatus("Generating...", "status-pending");
  if (kind === "t2v") startPreviewPolling();

  const body = {
    kind,
    prompt: promptEl.value,
    negative_prompt: negativeEl.value,
    num_frames: Number(framesEl.value),
    fps: Number(fpsEl.value),
    steps: Number(stepsEl.value),
    guidance: Number(guidanceEl.value),
    seed: resolveSeed(),
    format: formatEl.value,
    upscale: upscaleEl.value,
    interp: Number(interpEl.value),
    upload_id: kind === "i2v" ? uploadId : null,
  };

  let jobId: string;
  try {
    const res = await fetchJson("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    jobId = res.job_id;
  } catch (err) {
    finishGeneration("Generation failed: " + (err as Error).message, "status-error");
    return;
  }

  while (true) {
    await sleep(700);
    let job: JobSnapshot;
    try {
      job = await fetchJson("/jobs/" + jobId);
    } catch (err) {
      finishGeneration("Lost the engine: " + (err as Error).message, "status-error");
      return;
    }
    renderProgress(job);
    if (job.state === "running") continue;
    if (job.state === "done" && job.output_url) {
      const seed = job.metadata?.seed;
      if (typeof seed === "number") lastSeed = seed;
      showVideo(job.output_url);
      finishGeneration("Done", "status-ok");
      void refreshGallery();
    } else if (job.state === "cancelled") {
      showOutputState("empty");
      emptyHintEl.textContent = "Aborted.";
      finishGeneration("Aborted", "status-pending");
    } else {
      showOutputState("empty");
      emptyHintEl.textContent = job.error ?? "Generation failed.";
      finishGeneration("Generation failed", "status-error");
    }
    return;
  }
}

function finishGeneration(status: string, cls: "status-pending" | "status-ok" | "status-error") {
  stopPreviewPolling();
  outputTitleEl.textContent = "Nothing on the air";
  setGenerating(false);
  setEngineStatus(status, cls);
  if (cls === "status-error") {
    showOutputState("empty");
    emptyHintEl.textContent = status;
  }
}

generateBtn.addEventListener("click", () => void onGenerate());

// Enter in the prompt boxes starts the generation; Shift+Enter still adds a new line in the prompt.
[promptEl, negativeEl].forEach((el) =>
  el.addEventListener("keydown", (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (!generateBtn.hidden && !generateBtn.disabled) generateBtn.click();
  }),
);
abortBtn.addEventListener("click", async () => {
  abortBtn.disabled = true;
  try {
    await fetchJson("/cancel", { method: "POST" });
  } catch {
    // the poll loop reports whatever really happened
  }
  abortBtn.disabled = false;
});

// ---------------------------------------------------------------- gallery
const VHS_SVG =
  '<svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">' +
  '<rect x="2" y="2" width="60" height="36" rx="3" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
  '<rect x="9" y="7" width="46" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="14" y1="11" x2="38" y2="11" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="14" y1="15" x2="30" y2="15" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M17 38 L21 27 H43 L47 38" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="25" cy="32" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="39" cy="32" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  "</svg>";

const GALLERY_SLOT_WIDTH = 158; // card width + gap, keep in sync with .gallery-item in style.css
let galleryItems: { filename: string; output_url: string }[] = [];

// Real videos first, then empty VHS slots until the row spans the full width.
function renderGallery() {
  galleryEl.innerHTML = "";
  const activeUrl = outputVideoEl.hidden ? "" : new URL(outputVideoEl.src, location.href).pathname;
  for (const it of galleryItems) {
    const card = document.createElement("div");
    card.className = "gallery-item";
    card.dataset.url = it.output_url;
    const vid = document.createElement("video");
    vid.src = API_BASE + it.output_url + "#t=0.1";
    vid.muted = true;
    vid.preload = "metadata";
    const label = document.createElement("span");
    label.textContent = it.filename;
    card.append(vid, label);
    card.addEventListener("click", () => {
      if (!generating) showVideo(it.output_url);
    });
    if (activeUrl && activeUrl === it.output_url) card.classList.add("active");
    galleryEl.appendChild(card);
  }
  const slots = Math.max(galleryItems.length, Math.floor((galleryEl.clientWidth + 8) / GALLERY_SLOT_WIDTH));
  for (let i = galleryItems.length; i < slots; i++) {
    const empty = document.createElement("div");
    empty.className = "gallery-item gallery-empty";
    empty.innerHTML = VHS_SVG;
    galleryEl.appendChild(empty);
  }
  updateGalleryArrows();
}

// Arrows only exist when there are more videos than fit, and only on the side that has more.
const galleryPrevEl = $<HTMLButtonElement>("#gallery-prev");
const galleryNextEl = $<HTMLButtonElement>("#gallery-next");
function updateGalleryArrows() {
  const max = galleryEl.scrollWidth - galleryEl.clientWidth;
  galleryPrevEl.hidden = galleryEl.scrollLeft <= 2;
  galleryNextEl.hidden = max - galleryEl.scrollLeft <= 2;
}
function scrollGallery(dir: number) {
  galleryEl.scrollBy({ left: dir * galleryEl.clientWidth * 0.8, behavior: "smooth" });
}
galleryPrevEl.addEventListener("click", () => scrollGallery(-1));
galleryNextEl.addEventListener("click", () => scrollGallery(1));
galleryEl.addEventListener("scroll", updateGalleryArrows);
// Mouse wheel over the shelf scrolls it sideways (only when it actually overflows).
galleryEl.addEventListener(
  "wheel",
  (e) => {
    if (galleryEl.scrollWidth <= galleryEl.clientWidth) return;
    e.preventDefault();
    galleryEl.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  },
  { passive: false },
);

async function refreshGallery() {
  try {
    galleryItems = await fetchJson("/outputs/recent?limit=40");
  } catch {
    return;
  }
  renderGallery();
  // newest generation is always the first card: bring it into view
  galleryEl.scrollLeft = 0;
  updateGalleryArrows();
}
window.addEventListener("resize", () => renderGallery());

// ---------------------------------------------------------------- boot
applyMode();
renderGallery(); // empty VHS slots right away, real videos fill in once the engine answers
void initFastBoot();
void waitForEngine();
