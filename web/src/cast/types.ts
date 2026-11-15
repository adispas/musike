/**
 * Casting to Google Cast devices (Chromecast, Google TV, Nest speakers). Each platform reaches the device its own
 * way — the desktop app speaks the Cast protocol from Electron's main process (desktop/src/cast), the Android app
 * uses Google's Cast SDK (MusikeCastPlugin.java) — and both sit behind this one interface.
 *
 * Every platform plays on Google's Default Media Receiver and serves the audio from a small proxy on the local
 * network, so the device streams from this computer or phone (YouTube's stream URLs are bound to the IP that
 * resolved them). Casting is always audio: Nest speakers have no screen, and it keeps one code path.
 */

export interface CastDevice {
  id: string;
  name: string;
  /** "Google Nest Mini", "Chromecast"… when the device says. */
  model?: string;
}

export type CastPlayerState = "idle" | "buffering" | "playing" | "paused";

export interface CastStatus {
  state: CastPlayerState;
  /** Seconds. */
  position: number;
  duration: number;
  /** Why the device went idle: "finished" moves the queue on, "error" reports the track. */
  idleReason?: "finished" | "error" | "cancelled" | "interrupted";
}

export interface CastSession {
  connected: boolean;
  device?: CastDevice;
  /** The device's own volume, 0–1. */
  volume?: number;
  muted?: boolean;
}

export interface CastLoad {
  /** YouTube id of the track; the platform turns it into a URL the device can reach. */
  id: string;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  startAt: number;
  autoplay: boolean;
}

export interface CastEvents {
  devices: (devices: CastDevice[]) => void;
  session: (session: CastSession) => void;
  status: (status: CastStatus) => void;
  /** A failure the user should hear about (couldn't connect, the device dropped). */
  error: (message: string) => void;
}

export interface CastBackend {
  startDiscovery(): void;
  stopDiscovery(): void;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  load(media: CastLoad): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  on<K extends keyof CastEvents>(event: K, fn: CastEvents[K]): void;
}
