import { registerPlugin } from "@capacitor/core";
import { streamSource } from "../lib/api";
import { translated } from "./errors";
import type { CastBackend, CastDevice, CastEvents, CastSession, CastStatus } from "./types";

/** MusikeCastPlugin.java: Google's Cast SDK, plus a small proxy on the phone the device streams from. */
interface CastPlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(options: { id: string }): Promise<void>;
  disconnect(): Promise<void>;
  load(options: {
    url: string;
    mime: string;
    userAgent: string;
    title: string;
    artist: string;
    album: string;
    artwork: string;
    startAt: number;
    autoplay: boolean;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setVolume(options: { level: number }): Promise<void>;
  setMuted(options: { muted: boolean }): Promise<void>;
  addListener(event: "devices", fn: (e: { devices: CastDevice[] }) => void): Promise<unknown>;
  addListener(event: "session", fn: (e: CastSession) => void): Promise<unknown>;
  addListener(event: "status", fn: (e: CastStatus) => void): Promise<unknown>;
  addListener(event: "error", fn: (e: { message: string }) => void): Promise<unknown>;
}

const Cast = registerPlugin<CastPlugin>("MusikeCast");

/** googlevideo URLs carry their type: mime=audio%2Fmp4 or audio%2Fwebm. */
function mimeOf(url: string): string {
  try {
    const mime = new URL(url).searchParams.get("mime");
    if (mime?.startsWith("audio/")) return mime;
  } catch {
    /* not a URL we know */
  }
  return "audio/mp4";
}

/** Android app: the phone resolves the stream as it does for itself, then hands it to the native side. */
export function androidBackend(): CastBackend {
  return {
    startDiscovery: () => void Cast.startDiscovery().catch(() => {}),
    stopDiscovery: () => void Cast.stopDiscovery().catch(() => {}),
    connect: (id) => translated(Cast.connect({ id })),
    disconnect: () => Cast.disconnect(),
    load: async (m) => {
      const url = await streamSource(m.id, "audio", "sd");
      await translated(Cast.load({
        url,
        mime: mimeOf(url),
        // The proxy asks YouTube as this web view does when it plays the same stream itself.
        userAgent: navigator.userAgent,
        title: m.title,
        artist: m.artist,
        album: m.album,
        artwork: m.artwork,
        startAt: m.startAt,
        autoplay: m.autoplay,
      }));
    },
    play: () => Cast.play(),
    pause: () => Cast.pause(),
    seek: (position) => Cast.seek({ position }),
    setVolume: (level) => Cast.setVolume({ level }),
    setMuted: (muted) => Cast.setMuted({ muted }),
    on: <K extends keyof CastEvents>(event: K, fn: CastEvents[K]) => {
      if (event === "devices") void Cast.addListener("devices", (e) => (fn as CastEvents["devices"])(e.devices));
      else if (event === "error") void Cast.addListener("error", (e) => (fn as CastEvents["error"])(e.message));
      else void Cast.addListener(event as "session", fn as never);
    },
  };
}
