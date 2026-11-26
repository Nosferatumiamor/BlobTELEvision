// BlobTELEvision frontend. Talks directly to the Python API (app/python/blobtv_api.py)
// over HTTP; the Rust shell only owns the engine's process lifecycle.

// Must match API_PORT in src-tauri/src/main.rs. Deliberately not 8420 (BlobVision's
// port) so both apps can run side by side.
const API_BASE = "http://127.0.0.1:8421";
const HEALTH_POLL_MS = 1000;
// A fresh install bootstraps a whole Python + PyTorch environment before the API
// exists at all (several minutes), so the initial wait has to be generous.
const ENGINE_STARTUP_TIMEOUT_MS = 40 * 60 * 1000;
const ENGINE_STARTUP_SLOW_HINT_MS = 60000;

// ---------------------------------------------------------------- splash
// Purely cosmetic and on a fixed timer, independent of the real load progress.
const SPLASH_SCREEN_MS = 12000;
const SPLASH_DOTS_INTERVAL_MS = 450;
function initSplashScreen() {
  const splash = document.getElementById("splash-screen");
  const dots = document.getElementById("splash-dots");
  if (!splash) return;
  let dotCount = 0;
  const dotsTimer = window.setInterval(() => {
    if (dots) dots.textContent = ".".repeat(dotCount);
    dotCount = (dotCount + 1) % 4;
  }, SPLASH_DOTS_INTERVAL_MS);
  setTimeout(() => {
    clearInterval(dotsTimer);
    splash.classList.add("hide");
    setTimeout(() => splash.remove(), 700);
  }, SPLASH_SCREEN_MS);
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
const livePreviewEl = $<HTMLImageElement>("#live-preview");
const outputVideoEl = $<HTMLVideoElement>("#output-video");
const progressWrapEl = $<HTMLDivElement>("#progress-wrap");
const progressFillEl = $<HTMLDivElement>("#progress-fill");
const progressTextEl = $<HTMLSpanElement>("#progress-text");
const jobLogEl = $<HTMLPreElement>("#job-log");
const galleryEl = $<HTMLDivElement>("#gallery");
const upscaleEl = $<HTMLSelectElement>("#upscale");
const interpEl = $<HTMLSelectElement>("#interp");
const reduxHintEl = $<HTMLParagraphElement>("#redux-hint");
const reduxInstallBtn = $<HTMLButtonElement>("#redux-install-btn");
const formatWarningEl = $<HTMLDivElement>("#format-warning");

const MODEL_CHECKBOXES: Record<Kind, HTMLInputElement> = {
  t2v: $<HTMLInputElement>("#cb-t2v"),
  i2v: $<HTMLInputElement>("#cb-i2v"),
};
const MODEL_PROGRESS: Record<Kind, HTMLSpanElement> = {
  t2v: $<HTMLSpanElement>("#progress-t2v"),
  i2v: $<HTMLSpanElement>("#progress-i2v"),
};

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
  initDropEl.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")) void setInitFile(f);
});

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

// Purely cosmetic: the TV knobs turn a bit when clicked.
document.querySelectorAll<HTMLButtonElement>(".tv-knob").forEach((knob) => {
  let angle = 0;
  knob.addEventListener("click", () => {
    angle += 50 + Math.floor(Math.random() * 60);
    knob.style.transform = "rotate(" + angle + "deg)";
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
const STEP_START = [0, 0, 10, 14, 18, 82];
const STEP_TAU_S = [0, 20, 15, 10, 150, 60];

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
}

async function waitForEngine() {
  const start = Date.now();
  let shownSlowHint = false;
  while (Date.now() - start < ENGINE_STARTUP_TIMEOUT_MS) {
    try {
      await fetchJson("/health");
      bootstrapPanelEl.hidden = true;
      outputEmptyEl.hidden = false;
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

async function refreshModels(): Promise<boolean> {
  let status: Record<ModelKey, ModelStatus>;
  try {
    status = await fetchJson("/models/status");
  } catch {
    return true;
  }
  modelsStatus = status;
  updateReduxUi();
  const keys = Object.keys(MODEL_CHECKBOXES) as Kind[];
  keys.forEach((key) => {
    const cb = MODEL_CHECKBOXES[key];
    const done = modelDone(status[key]);
    cb.checked = done ? true : cb.checked;
    cb.disabled = status[key].ready || status[key].installing;
    cb.parentElement!.classList.toggle("models-row-done", done);
    MODEL_PROGRESS[key].textContent = done ? "done" : status[key].progress ?? "";
  });
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
    modelDone(status.t2v) &&
    pendingInstall.size === 0 &&
    !status.i2v.installing &&
    modelsInstallStatusEl.hidden;
  updateGenerateEnabled();
  updateEmptyHint();
  return modelDone(status.t2v);
}

modelsInstallBtnEl.addEventListener("click", async () => {
  const targets = (Object.keys(MODEL_CHECKBOXES) as Kind[]).filter(
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
  try {
    await fetchJson("/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "t2v" }),
    });
  } catch {
    // a failed warmup just means the first Generate pays the load itself
  }
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
}

function showVideo(url: string) {
  showOutputState("video");
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

function renderProgress(job: JobSnapshot) {
  if (job.total > 0) {
    const pct = Math.min(100, Math.round((job.step / job.total) * 100));
    progressFillEl.style.width = pct + "%";
    progressTextEl.textContent = (job.phase ? job.phase + " " : "step ") + job.step + " / " + job.total;
  } else {
    progressFillEl.style.width = "0%";
    progressTextEl.textContent = job.phase || (job.lines.length ? job.lines[job.lines.length - 1].slice(0, 60) : "");
  }
  jobLogEl.textContent = job.lines.join("\n");
  jobLogEl.scrollTop = jobLogEl.scrollHeight;
}

function setGenerating(on: boolean) {
  generating = on;
  $<HTMLDivElement>("#tv-led").classList.toggle("on", on);
  generateBtn.hidden = on;
  abortBtn.hidden = !on;
  progressWrapEl.hidden = !on && jobLogEl.hidden;
  updateGenerateEnabled();
}

async function onGenerate() {
  const kind = currentKind();
  if (kind === "t2v" && !promptEl.value.trim()) {
    emptyHintEl.textContent = "Write a prompt first.";
    return;
  }
  setGenerating(true);
  progressWrapEl.hidden = false;
  jobLogEl.hidden = false;
  jobLogEl.textContent = "";
  progressFillEl.style.width = "0%";
  progressTextEl.textContent = "starting...";
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
  setGenerating(false);
  setEngineStatus(status, cls);
  if (cls === "status-error") {
    showOutputState("empty");
    emptyHintEl.textContent = status;
  }
}

generateBtn.addEventListener("click", () => void onGenerate());
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
}

async function refreshGallery() {
  try {
    galleryItems = await fetchJson("/outputs/recent?limit=40");
  } catch {
    return;
  }
  renderGallery();
}
window.addEventListener("resize", () => renderGallery());

// ---------------------------------------------------------------- boot
applyMode();
renderGallery(); // empty VHS slots right away, real videos fill in once the engine answers
void initFastBoot();
void waitForEngine();
