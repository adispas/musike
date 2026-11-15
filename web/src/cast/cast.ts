import { Capacitor } from "@capacitor/core";
import { create } from "zustand";
import { getT } from "../i18n";
import { desktop } from "../lib/desktop";
import { toast } from "../stores/ui";
import { androidBackend } from "./android";
import { electronBackend } from "./electron";
import type { CastBackend, CastDevice } from "./types";

export type { CastDevice, CastStatus } from "./types";

/** The platform's way to cast, or null where Musike can't (a browser, iOS for now, Android TV — a cast target itself). */
export const castBackend: CastBackend | null = desktop?.cast
  ? electronBackend(desktop.cast)
  : Capacitor.getPlatform() === "android"
    ? androidBackend()
    : null;

interface CastState {
  devices: CastDevice[];
  /** The device Musike is casting to. */
  device: CastDevice | null;
  /** The device being connected to. */
  connecting: string | null;
  /** The device's own volume while casting (the app's volume is left as it was). */
  volume: number;
  muted: boolean;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  connect: (id: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setVolume: (level: number) => void;
  toggleMute: () => void;
}

export const useCast = create<CastState>((set, get) => ({
  devices: [],
  device: null,
  connecting: null,
  volume: 0.5,
  muted: false,
  pickerOpen: false,

  openPicker: () => {
    if (!castBackend) return;
    set({ pickerOpen: true });
    castBackend.startDiscovery();
  },
  closePicker: () => {
    set({ pickerOpen: false });
    castBackend?.stopDiscovery();
  },

  connect: async (id) => {
    if (!castBackend || get().connecting) return;
    set({ connecting: id });
    try {
      await castBackend.connect(id);
      get().closePicker();
    } catch (e) {
      const name = get().devices.find((d) => d.id === id)?.name ?? "";
      toast(getT().cast.couldNotConnect(name, (e as Error).message), "error");
    } finally {
      set({ connecting: null });
    }
  },

  disconnect: async () => {
    get().closePicker();
    await castBackend?.disconnect().catch(() => {});
  },

  setVolume: (level) => {
    const volume = Math.max(0, Math.min(1, level));
    set({ volume, muted: volume === 0 });
    void castBackend?.setVolume(volume).catch(() => {});
  },
  toggleMute: () => {
    const muted = !get().muted;
    set({ muted });
    void castBackend?.setMuted(muted).catch(() => {});
  },
}));

export const isCasting = () => useCast.getState().device !== null;

if (castBackend) {
  castBackend.on("devices", (devices) => set({ devices }));
  castBackend.on("session", (s) => {
    const was = useCast.getState().device;
    set({
      device: s.connected ? (s.device ?? was ?? { id: "", name: "" }) : null,
      ...(s.volume != null ? { volume: s.volume } : {}),
      ...(s.muted != null ? { muted: s.muted } : {}),
    });
  });
  // Platforms report known problems as codes, translated here; anything else arrives as a message.
  castBackend.on("error", (message) => {
    const known = getT().cast.errors as Record<string, string>;
    toast(known[message] ?? message, "error");
  });
}

function set(partial: Partial<CastState>) {
  useCast.setState(partial);
}
