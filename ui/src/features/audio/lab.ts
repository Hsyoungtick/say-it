// 音频调校（增益 / 降噪试听台）。命令式音频 + canvas，移植自旧 app.js 的 LAB 段。
// 参数直接读写 useDictPrefs，改动即时作用于运行中的速记管线。
// 录音走后端麦克风采集（与语音输入/实时字幕同一条路径），不用浏览器 getUserMedia，
// 避免弹出网页式的录音权限提示、且和其它录音入口共用同一个"选定输入设备"。
import { CMD, EVT, cmd, cmdSilent, on } from "@/lib/tauri";
import { float32ToBase64, base64ToFloat32, measure } from "@/lib/audio-dsp";
import { useDictPrefs } from "@/store/useDictPrefs";
import { useAudioStore, emptyMeters } from "@/store/useAudioStore";

let unlistenChunk: (() => void) | null = null;
let unlistenEnded: (() => void) | null = null;
let chunks: Float32Array[] = [];
let sampleRate = 48000;
let recording = false;
let raw: Float32Array | null = null;
let processed: Float32Array | null = null;
let processedSampleRate = 48000;
let stats: { inLufs?: number; outLufs?: number; outPeakDb?: number } | null = null;
let audioEl: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let reprocTimer: ReturnType<typeof setTimeout> | null = null;

let origCanvas: HTMLCanvasElement | null = null;
let procCanvas: HTMLCanvasElement | null = null;

export function setCanvases(orig: HTMLCanvasElement | null, processedC: HTMLCanvasElement | null) {
  origCanvas = orig;
  procCanvas = processedC;
  drawWaves();
}

function setRecInfo(text: string, tone: "" | "ok" | "err" = "") {
  useAudioStore.setState({ recInfo: text, recTone: tone });
}

function dspParams() {
  return useDictPrefs.getState().dspParams();
}

function toDb(x: number): string {
  if (x <= 1e-6) return "-∞";
  return (20 * Math.log10(x)).toFixed(1);
}

function fmtLufs(v: number): string {
  return v <= -119 ? "-∞ LUFS" : `${Number(v).toFixed(1)} LUFS`;
}

function drawWave(canvas: HTMLCanvasElement | null, samples: Float32Array | null, color: string) {
  if (!canvas) return;
  const c = canvas.getContext("2d");
  if (!c) return;
  const W = canvas.width;
  const H = canvas.height;
  c.clearRect(0, 0, W, H);
  c.strokeStyle = "rgba(255,255,255,0.12)";
  c.beginPath();
  c.moveTo(0, H / 2);
  c.lineTo(W, H / 2);
  c.stroke();
  if (!samples || !samples.length) return;
  c.strokeStyle = color;
  c.beginPath();
  const step = Math.max(1, Math.floor(samples.length / W));
  for (let x = 0; x < W; x += 1) {
    let min = 1;
    let max = -1;
    const start = x * step;
    for (let j = 0; j < step; j += 1) {
      const v = samples[start + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    c.moveTo(x, (1 - (max + 1) / 2) * H);
    c.lineTo(x, (1 - (min + 1) / 2) * H);
  }
  c.stroke();
}

function drawWaves() {
  drawWave(origCanvas, raw, "#8a93b0");
  drawWave(procCanvas, processed, "#ffffff");
}

function updateMeters() {
  const m = { ...emptyMeters };
  if (raw) {
    const o = measure(raw);
    m.olufs = stats ? fmtLufs(stats.inLufs ?? -120) : "-";
    m.orms = toDb(o.rms);
    m.opeak = toDb(o.peak);
  }
  if (processed) {
    const p = measure(processed);
    m.plufs = stats ? fmtLufs(stats.outLufs ?? -120) : "-";
    m.prms = toDb(p.rms);
    m.ppeak = stats ? `${Number(stats.outPeakDb).toFixed(1)}` : toDb(p.peak);
    let clipped = 0;
    for (let i = 0; i < processed.length; i += 1) {
      if (Math.abs(processed[i]) >= 0.999) clipped += 1;
    }
    m.clip = String(clipped);
  }
  useAudioStore.setState({ meters: m });
}

/** 等后端麦克风原始音频 channel 真正关闭（`pause_backend_mic` 触发），保证尾块已经通过事件送达前端。 */
function waitForCaptureEnded(timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unlistenEnded?.();
      unlistenEnded = null;
      resolve();
    };
    on(EVT.backendMicRawEnded, finish).then((fn) => {
      if (done) {
        fn();
        return;
      }
      unlistenEnded = fn;
    });
    setTimeout(finish, timeoutMs);
  });
}

async function startRec() {
  chunks = [];
  raw = null;
  processed = null;
  stats = null;
  useAudioStore.setState({ canPlay: false, meters: { ...emptyMeters } });
  drawWaves();

  const deviceName = useDictPrefs.getState().prefs.micDeviceId || undefined;
  const started = await cmd<{ sampleRate?: number }>(CMD.startBackendMic, { deviceName });
  sampleRate = started.sampleRate || 48000;

  unlistenChunk = await on<string>(EVT.backendMicRawChunk, (base64) => {
    const samples = base64ToFloat32(base64);
    chunks.push(samples);
    const { peak } = measure(samples);
    useAudioStore.setState({ level: Math.min(100, peak * 140) });
  });
  await cmd(CMD.attachBackendMicRawCapture);

  recording = true;
  useAudioStore.setState({ recording: true });
  setRecInfo("录音中…对着麦克风正常说几句话");
}

async function stopRec() {
  recording = false;
  useAudioStore.setState({ recording: false });

  const ended = waitForCaptureEnded();
  await cmdSilent(CMD.pauseBackendMic);
  await ended;
  unlistenChunk?.();
  unlistenChunk = null;
  await cmdSilent(CMD.releaseBackendMic);
  useAudioStore.setState({ level: 0 });

  let total = 0;
  for (const ch of chunks) total += ch.length;
  raw = new Float32Array(total);
  let off = 0;
  for (const ch of chunks) {
    raw.set(ch, off);
    off += ch.length;
  }
  const secs = (total / sampleRate).toFixed(1);
  setRecInfo(`已录制 ${secs}s（${sampleRate}Hz）`, "ok");
  useAudioStore.setState({ canPlay: true });
  await reprocess();
}

export async function reprocess() {
  if (!raw) return;
  setRecInfo("正在用 Rust DSP 处理录音…");
  const result = await cmd<{
    processedBase64: string;
    sampleRate?: number;
    inLufs: number;
    outLufs: number;
    outPeakDb: number;
  }>(CMD.processAudioOffline, {
    request: { samplesBase64: float32ToBase64(raw), sampleRate, params: dspParams() },
  });
  stats = result;
  processed = base64ToFloat32(result.processedBase64);
  processedSampleRate = result.sampleRate || 48000;
  drawWaves();
  updateMeters();
  setRecInfo(`处理完成：${fmtLufs(result.inLufs)} → ${fmtLufs(result.outLufs)}`, "ok");
}

function scheduleReprocess() {
  if (reprocTimer) clearTimeout(reprocTimer);
  reprocTimer = setTimeout(() => {
    reprocess().catch((e) => setRecInfo(`处理失败：${e}`, "err"));
  }, 120);
}

/** 滑块/复选框改动后：已持久化（由 prefs.patch 完成），这里只触发重处理。 */
export function paramChanged() {
  scheduleReprocess();
}

export async function toggleRecord() {
  try {
    if (!recording) await startRec();
    else await stopRec();
  } catch (e) {
    setRecInfo(`录音失败：${e}`, "err");
    recording = false;
    useAudioStore.setState({ recording: false });
    unlistenChunk?.();
    unlistenChunk = null;
  }
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i += 1) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(off, s, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function play(samples: Float32Array | null, rate: number) {
  if (!samples || !samples.length) return;
  if (!audioEl) audioEl = new Audio();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(encodeWav(samples, rate));
  audioEl.src = audioUrl;
  audioEl.play().catch((e) => setRecInfo(`播放失败：${e}`, "err"));
}

export function playOriginal() {
  play(raw, sampleRate);
}

export function playProcessed() {
  play(processed, processedSampleRate);
}

export function resetParams() {
  // 由 view 负责把 prefs 重置为 dsp 默认；这里只重绘并重处理。
  useAudioStore.setState({ labStatus: "已恢复默认参数并应用到速记。", labStatusTone: "ok" });
  scheduleReprocess();
}
