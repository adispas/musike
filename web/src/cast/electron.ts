import { translated } from "./errors";
import type { CastBackend, CastEvents, CastLoad } from "./types";

/** The bridge the desktop preload script exposes as `musikeDesktop.cast` (desktop/src/preload.ts). */
export interface DesktopCastBridge {
  startDiscovery(): void;
  stopDiscovery(): void;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  load(media: CastLoad): Promise<void>;
  command(name: "play" | "pause" | "seek" | "volume" | "mute", value?: number | boolean): Promise<void>;
  onEvent(fn: (event: keyof CastEvents, payload: unknown) => void): void;
}

/** Windows/macOS/Linux app: the Cast protocol runs in Electron's main process (desktop/src/cast). */
export function electronBackend(bridge: DesktopCastBridge): CastBackend {
  const listeners: { [K in keyof CastEvents]?: CastEvents[K][] } = {};
  bridge.onEvent((event, payload) => {
    for (const fn of listeners[event] ?? []) (fn as (p: unknown) => void)(payload);
  });
  return {
    startDiscovery: () => bridge.startDiscovery(),
    stopDiscovery: () => bridge.stopDiscovery(),
    connect: (id) => translated(bridge.connect(id)),
    disconnect: () => bridge.disconnect(),
    load: (media) => translated(bridge.load(media)),
    play: () => bridge.command("play"),
    pause: () => bridge.command("pause"),
    seek: (s) => bridge.command("seek", s),
    setVolume: (v) => bridge.command("volume", v),
    setMuted: (m) => bridge.command("mute", m),
    on: (event, fn) => {
      (listeners[event] ??= [] as never[]).push(fn as never);
    },
  };
}
