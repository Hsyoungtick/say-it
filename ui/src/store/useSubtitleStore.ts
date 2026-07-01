import { create } from "zustand";

export type SubtitleSource = "microphone" | "system";
export type SubtitleAnchor = "top" | "center" | "bottom";
export type SubtitleMode = "scroll" | "replace";

export interface SubtitlePrefs {
  source: SubtitleSource;
  mode: SubtitleMode;
  fontFamily: string;
  fontSize: number;
  lineCount: number;
  width: number;
  anchor: SubtitleAnchor;
  offsetY: number;
  textColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  rounded: number;
}

type Tone = "" | "ok" | "err";

interface SubtitleState {
  prefs: SubtitlePrefs;
  running: boolean;
  statusText: string;
  statusTone: Tone;
  latestText: string;
  capturing: boolean;
  shortcutLabel: string;
  patch: (partial: Partial<SubtitlePrefs>) => void;
  setRuntime: (
    partial: Partial<
      Pick<SubtitleState, "running" | "statusText" | "statusTone" | "latestText" | "capturing" | "shortcutLabel">
    >,
  ) => void;
}

const SUBTITLE_PREFS_KEY = "sayItSubtitlePrefs";

const defaults = (): SubtitlePrefs => ({
  source: "microphone",
  mode: "replace",
  fontFamily: "Microsoft YaHei",
  fontSize: 28,
  lineCount: 1,
  width: 880,
  anchor: "bottom",
  offsetY: 64,
  textColor: "#ffffff",
  backgroundColor: "#05070a",
  backgroundOpacity: 72,
  rounded: 18,
});

function clampPrefs(prefs: SubtitlePrefs): SubtitlePrefs {
  return {
    ...prefs,
    fontSize: Math.min(64, Math.max(18, Number(prefs.fontSize) || 28)),
    lineCount: Math.min(4, Math.max(1, Math.round(Number(prefs.lineCount) || 1))),
    width: Math.min(1280, Math.max(420, Number(prefs.width) || 880)),
    offsetY: Math.min(220, Math.max(-180, Number(prefs.offsetY) || 64)),
    backgroundOpacity: Math.min(100, Math.max(0, Number(prefs.backgroundOpacity) || 72)),
    rounded: Math.min(36, Math.max(0, Number(prefs.rounded) || 18)),
  };
}

function readStored(): SubtitlePrefs {
  const base = defaults();
  try {
    const raw = localStorage.getItem(SUBTITLE_PREFS_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch {
    /* noop */
  }
  return clampPrefs(base);
}

function persist(prefs: SubtitlePrefs) {
  try {
    localStorage.setItem(SUBTITLE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* noop */
  }
}

export const useSubtitleStore = create<SubtitleState>((set, get) => ({
  prefs: readStored(),
  running: false,
  statusText: "实时字幕未开启",
  statusTone: "",
  latestText: "",
  capturing: false,
  shortcutLabel: "",
  patch: (partial) => {
    const next = clampPrefs({ ...get().prefs, ...partial });
    persist(next);
    set({ prefs: next });
  },
  setRuntime: (partial) => set(partial),
}));

