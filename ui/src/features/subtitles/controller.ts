import { CMD, EVT, cmd, cmdSilent, emitEvent } from "@/lib/tauri";
import { float32ToBase64 } from "@/lib/audio-dsp";
import { useDictPrefs } from "@/store/useDictPrefs";
import { useProviderStore } from "@/store/useProviderStore";
import { useSubtitleStore, type SubtitlePrefs } from "@/store/useSubtitleStore";
import {
  clearMicShutdownTimer,
  ensureMic,
  getBackendMicSampleRate,
  scheduleMicShutdown,
  shutdownMic,
} from "@/features/dictation/micSession";
import {
  configureSubtitleHotkeys,
  startSubtitleShortcutCapture,
  clearSubtitleShortcut,
  isSubtitleCapturing,
  loadSubtitleShortcut,
  installSubtitleFocusHotkeyFallback,
  handleForwardedSubtitleKeydown,
  handleForwardedSubtitleKeyup,
} from "./hotkeys";

export {
  startSubtitleShortcutCapture,
  clearSubtitleShortcut,
  isSubtitleCapturing,
  loadSubtitleShortcut,
  installSubtitleFocusHotkeyFallback,
  handleForwardedSubtitleKeydown,
  handleForwardedSubtitleKeyup,
} from "./hotkeys";

let subtitleSessionId: string | null = null;
let busy = false;
let committedLines: string[] = [];
let currentSegment = "";
let displayText = "";

let systemStream: MediaStream | null = null;
let systemAudioCtx: AudioContext | null = null;
let systemSource: MediaStreamAudioSourceNode | null = null;
let systemProcessor: ScriptProcessorNode | null = null;
let pushChain: Promise<unknown> = Promise.resolve();

function setStatus(statusText: string, statusTone: "" | "ok" | "err" = "") {
  useSubtitleStore.getState().setRuntime({ statusText, statusTone });
}

configureSubtitleHotkeys({
  setStatus,
  toggle: () => toggleSubtitles(),
});

export function handleSubtitleShortcutError(payload: { key_code?: string; message?: string }) {
  setStatus(`实时字幕快捷键注册失败（${payload.key_code || "?"}）：${payload.message || "未知错误"}`, "err");
}

function pushLog(message: string) {
  if (useDictPrefs.getState().prefs.debugLog) {
    console.log(`[subtitles] ${message}`);
  }
}

export function rgba(hex: string, opacity: number) {
  const value = hex.replace("#", "").trim();
  const full =
    value.length === 3
      ? value
          .split("")
          .map((v) => `${v}${v}`)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, opacity / 100))})`;
}

export async function syncSubtitleIndicator(prefs: SubtitlePrefs = useSubtitleStore.getState().prefs) {
  // 单句替换模式下永远只显示当前一行，行高不应受"显示行数"设置影响。
  const effectiveLines = prefs.mode === "replace" ? 1 : prefs.lineCount;
  const lineHeight = Math.round(prefs.fontSize * 1.38);
  const height = Math.max(136, lineHeight * effectiveLines + 86);
  await cmdSilent(CMD.setIndicatorLayout, {
    width: prefs.width,
    height,
    anchor: prefs.anchor,
    offsetY: prefs.offsetY,
  });
  await emitEvent(EVT.indicatorConfig, {
    mode: "subtitle",
    subtitle: {
      displayMode: prefs.mode,
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineCount: effectiveLines,
      textColor: prefs.textColor,
      backgroundColor: rgba(prefs.backgroundColor, prefs.backgroundOpacity),
      rounded: prefs.rounded,
      width: prefs.width,
    },
  });
}

function renderSubtitle(nextSegment = currentSegment) {
  const prefs = useSubtitleStore.getState().prefs;
  const stable = committedLines.join("\n");
  const next =
    prefs.mode === "replace"
      ? nextSegment || committedLines[committedLines.length - 1] || ""
      : [stable, nextSegment].filter(Boolean).join(stable && nextSegment ? "\n" : "");
  displayText = next.length > 1800 ? next.slice(-1800).replace(/^\s+/, "") : next;
  useSubtitleStore.getState().setRuntime({ latestText: displayText });
  cmdSilent(CMD.setIndicatorText, { text: displayText });
}

function pushSystemSamples(samples: Float32Array) {
  const sessionId = subtitleSessionId;
  if (!sessionId || samples.length === 0) return;
  const audioBase64 = float32ToBase64(samples);
  pushChain = pushChain.then(() =>
    cmd(CMD.asrStreamPushF32Chunk, { sessionId, audioBase64 }).catch((error) => {
      pushLog(`系统音频推送失败：${String(error)}`);
    }),
  );
}

async function startSystemAudio() {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getDisplayMedia) {
    throw new Error("当前 WebView 不支持系统音频捕获");
  }
  const stream = await mediaDevices.getDisplayMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: true,
  });
  const audioTracks = stream.getAudioTracks();
  stream.getVideoTracks().forEach((track) => track.stop());
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("未获取到系统音频轨道，请在共享窗口中勾选系统音频");
  }

  systemStream = stream;
  systemAudioCtx = new AudioContext();
  systemSource = systemAudioCtx.createMediaStreamSource(stream);
  systemProcessor = systemAudioCtx.createScriptProcessor(4096, 1, 1);
  systemProcessor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const channels = Math.max(1, input.numberOfChannels);
    const output = new Float32Array(input.length);
    for (let ch = 0; ch < channels; ch += 1) {
      const data = input.getChannelData(ch);
      for (let i = 0; i < data.length; i += 1) output[i] += data[i] / channels;
    }
    pushSystemSamples(output);
  };
  systemSource.connect(systemProcessor);
  systemProcessor.connect(systemAudioCtx.destination);
}

function stopSystemAudio() {
  if (systemProcessor) {
    systemProcessor.disconnect();
    systemProcessor.onaudioprocess = null;
  }
  if (systemSource) systemSource.disconnect();
  if (systemAudioCtx && systemAudioCtx.state !== "closed") systemAudioCtx.close().catch(() => {});
  systemStream?.getTracks().forEach((track) => track.stop());
  systemStream = null;
  systemAudioCtx = null;
  systemSource = null;
  systemProcessor = null;
}

async function startSubtitles() {
  const prefs = useSubtitleStore.getState().prefs;
  committedLines = [];
  currentSegment = "";
  displayText = "";
  clearMicShutdownTimer();
  await syncSubtitleIndicator(prefs);

  let sampleRate = 48000;
  if (prefs.source === "microphone") {
    await ensureMic(pushLog);
    sampleRate = getBackendMicSampleRate() || 48000;
  } else {
    await startSystemAudio();
    sampleRate = systemAudioCtx?.sampleRate || 48000;
  }

  const session = await cmd<{ session_id: string }>(CMD.startAsrStream, {
    providerId: useProviderStore.getState().effective("asr"),
    sampleRate,
    params: useDictPrefs.getState().dspParams(),
  });
  subtitleSessionId = session.session_id;

  if (prefs.source === "microphone") {
    await cmd(CMD.attachBackendMicToAsr, { sessionId: subtitleSessionId });
  }

  useSubtitleStore.getState().setRuntime({
    running: true,
    statusText: prefs.source === "microphone" ? "实时字幕已开启：麦克风" : "实时字幕已开启：系统音频",
    statusTone: "ok",
    latestText: "",
  });
  cmdSilent(CMD.setIndicatorState, { state: "subtitle" });
  cmdSilent(CMD.setIndicatorText, { text: "" });
}

async function stopSubtitles() {
  const session = subtitleSessionId;
  subtitleSessionId = null;
  currentSegment = "";
  committedLines = [];
  stopSystemAudio();
  await cmdSilent(CMD.pauseBackendMic);
  scheduleMicShutdown(pushLog);
  if (session) await cmdSilent(CMD.stopAsrStream, { sessionId: session });
  await emitEvent(EVT.indicatorConfig, { mode: "dictation" });
  await cmdSilent(CMD.setIndicatorLayout, { width: 520, height: 220, anchor: "bottom", offsetY: 36 });
  await cmdSilent(CMD.setIndicatorState, { state: "hidden" });
  await cmdSilent(CMD.setIndicatorText, { text: "" });
  useSubtitleStore.getState().setRuntime({
    running: false,
    statusText: "实时字幕已停止",
    statusTone: "",
  });
}

export async function toggleSubtitles() {
  if (busy) return;
  busy = true;
  try {
    if (useSubtitleStore.getState().running) await stopSubtitles();
    else await startSubtitles();
  } catch (error) {
    const session = subtitleSessionId;
    subtitleSessionId = null;
    stopSystemAudio();
    await shutdownMic();
    if (session) await cmdSilent(CMD.stopAsrStream, { sessionId: session });
    await cmdSilent(CMD.setIndicatorState, { state: "hidden" });
    useSubtitleStore.getState().setRuntime({
      running: false,
      statusText: `实时字幕出错：${String(error)}`,
      statusTone: "err",
    });
  } finally {
    setTimeout(() => {
      busy = false;
    }, 250);
  }
}

export function handleSubtitleAsrEvent(data: {
  session_id?: string;
  kind?: string;
  payload?: { text?: string; final?: boolean; message?: string };
}): boolean {
  if (!data.session_id || data.session_id !== subtitleSessionId) return false;
  if (data.kind === "result") {
    const text = data.payload?.text || "";
    if (text) {
      currentSegment = text;
      renderSubtitle(text);
    }
    if (data.payload?.final && currentSegment.trim()) {
      committedLines.push(currentSegment.trim());
      committedLines = committedLines.slice(-12);
      currentSegment = "";
      renderSubtitle("");
    }
  } else if (data.kind === "error") {
    setStatus(`实时字幕 ASR 错误：${data.payload?.message || "未知错误"}`, "err");
  } else if (data.kind === "ended" || data.kind === "closed") {
    if (useSubtitleStore.getState().running) setStatus("实时字幕连接已结束", "err");
  }
  return true;
}

export async function shutdownSubtitles() {
  if (!useSubtitleStore.getState().running && !subtitleSessionId) return;
  await stopSubtitles();
}
