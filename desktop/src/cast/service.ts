import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { CastChannel, NS, type CastMessage } from "./protocol.js";
import { Discovery, type FoundDevice } from "./discovery.js";

/**
 * Casting from the desktop app: finds devices, runs a session on Google's Default Media Receiver and serves the
 * audio to the device from a small proxy on this computer's LAN address.
 *
 * The proxy only answers /<secret>/<video id> and forwards to the Musike server's /api/stream/<id>/audio, which stays
 * on 127.0.0.1: the rest of the API (library, settings) is never exposed to the network.
 */

const DEFAULT_MEDIA_RECEIVER = "CC1AD845";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Events the web app hears (web/src/cast/electron.ts). Error payloads are codes it translates. */
export type CastEvent = "devices" | "session" | "status" | "error";

export interface LoadRequest {
  id: string;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  startAt: number;
  autoplay: boolean;
}

interface MediaStatus {
  mediaSessionId?: number;
  playerState?: "IDLE" | "PLAYING" | "PAUSED" | "BUFFERING";
  idleReason?: "FINISHED" | "CANCELLED" | "INTERRUPTED" | "ERROR";
  currentTime?: number;
  media?: { duration?: number };
}

interface ReceiverStatus {
  applications?: { appId: string; sessionId: string; transportId: string }[];
  volume?: { level?: number; muted?: boolean };
}

/** This computer's address on the same subnet as the device, so the device can reach the proxy. */
function addressFacing(deviceIp: string): string | null {
  const toInt = (ip: string) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const target = toInt(deviceIp);
  let fallback: string | null = null;
  for (const a of Object.values(networkInterfaces()).flat()) {
    if (!a || a.family !== "IPv4" || a.internal) continue;
    const mask = toInt(a.netmask);
    if (((toInt(a.address) & mask) >>> 0) === ((target & mask) >>> 0)) return a.address;
    fallback ??= a.address;
  }
  return fallback;
}

const IDLE_REASONS = { FINISHED: "finished", CANCELLED: "cancelled", INTERRUPTED: "interrupted", ERROR: "error" } as const;

export class CastService {
  private discovery = new Discovery();
  private channel: CastChannel | null = null;
  private device: FoundDevice | null = null;
  private transportId = "";
  private sessionId = "";
  private mediaSessionId: number | null = null;
  private poll: NodeJS.Timeout | null = null;
  private proxy: { server: Server; host: string; port: number } | null = null;
  private readonly secret = randomBytes(12).toString("hex");

  constructor(
    private readonly serverPort: () => number,
    private readonly emit: (event: CastEvent, payload: unknown) => void,
  ) {
    this.discovery.on("devices", (list: FoundDevice[]) =>
      this.emit("devices", list.map((d) => ({ id: d.id, name: d.name, model: d.model }))),
    );
  }

  startDiscovery() {
    this.discovery.start();
  }

  stopDiscovery() {
    this.discovery.stop();
  }

  async connect(id: string) {
    const device = this.discovery.devices.get(id);
    if (!device) throw new Error("The device is no longer on the network.");
    await this.disconnect(true);

    const channel = await CastChannel.open(device.host, device.port);
    this.channel = channel;
    this.device = device;
    channel.on("message", (msg: CastMessage) => this.onMessage(channel, msg));
    channel.on("close", () => {
      if (this.channel !== channel) return; // replaced or ended on purpose
      this.endSession();
      this.emit("error", "lost");
    });

    try {
      let status = (await channel.request("receiver-0", NS.receiver, { type: "GET_STATUS" })).data.status as ReceiverStatus;
      let app = status.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
      if (!app) {
        status = (await channel.request("receiver-0", NS.receiver, { type: "LAUNCH", appId: DEFAULT_MEDIA_RECEIVER }, 20_000)).data
          .status as ReceiverStatus;
        app = status.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
      }
      if (!app) throw new Error("The device didn't start the player.");
      channel.send("sender-0", app.transportId, NS.connection, { type: "CONNECT" });
      await this.ensureProxy(device.host);
      this.transportId = app.transportId;
      this.sessionId = app.sessionId;
      this.emit("session", {
        connected: true,
        device: { id: device.id, name: device.name, model: device.model },
        volume: status.volume?.level,
        muted: status.volume?.muted,
      });
      this.poll = setInterval(() => this.refresh(), 1000);
    } catch (e) {
      this.endSession(false);
      throw e;
    }
  }

  async disconnect(quiet = false) {
    const channel = this.channel;
    if (!channel) return;
    const sessionId = this.sessionId;
    this.sessionId = ""; // its absence from the reply is expected now, not another app taking over
    if (sessionId && !channel.isClosed) {
      // Stop the receiver so the speaker goes quiet instead of playing out what it buffered.
      await channel.request("receiver-0", NS.receiver, { type: "STOP", sessionId }, 3000).catch(() => {});
    }
    this.endSession(!quiet);
  }

  async load(m: LoadRequest) {
    const channel = this.requireSession();
    if (!VIDEO_ID.test(m.id)) throw new Error("Invalid track.");
    // Resolve the stream on the server first: it warms YouTube's URL for the device and gives a readable error
    // (outdated yt-dlp, track unavailable) instead of a silent failure on the speaker.
    const mime = await this.probe(m.id);
    const url = `http://${this.proxy!.host}:${this.proxy!.port}/${this.secret}/${m.id}`;
    const reply = await channel.request(
      this.transportId,
      NS.media,
      {
        type: "LOAD",
        autoplay: m.autoplay,
        currentTime: m.startAt,
        media: {
          contentId: url,
          contentUrl: url,
          contentType: mime,
          streamType: "BUFFERED",
          metadata: {
            metadataType: 3, // MUSIC_TRACK
            title: m.title,
            artist: m.artist,
            albumName: m.album,
            images: m.artwork ? [{ url: m.artwork }] : [],
          },
        },
      },
      30_000,
    );
    if (reply.data.type !== "MEDIA_STATUS") throw new Error("streamFailed");
    const status = (reply.data.status as MediaStatus[] | undefined)?.[0];
    this.mediaSessionId = status?.mediaSessionId ?? null;
    if (status) this.emitStatus(status);
  }

  command(name: "play" | "pause" | "seek" | "volume" | "mute", value?: number | boolean) {
    const channel = this.channel;
    if (!channel || channel.isClosed) return;
    const ignore = () => {};
    if (name === "volume") {
      void channel.request("receiver-0", NS.receiver, { type: "SET_VOLUME", volume: { level: Number(value) } }).catch(ignore);
      return;
    }
    if (name === "mute") {
      void channel.request("receiver-0", NS.receiver, { type: "SET_VOLUME", volume: { muted: !!value } }).catch(ignore);
      return;
    }
    if (this.mediaSessionId === null) return;
    const base = { mediaSessionId: this.mediaSessionId };
    const data =
      name === "seek"
        ? { ...base, type: "SEEK", currentTime: Number(value) }
        : { ...base, type: name === "play" ? "PLAY" : "PAUSE" };
    void channel.request(this.transportId, NS.media, data).catch(ignore);
  }

  async shutdown() {
    this.stopDiscovery();
    await this.disconnect(true);
    this.proxy?.server.close();
    this.proxy = null;
  }

  // ---

  private requireSession(): CastChannel {
    if (!this.channel || this.channel.isClosed || !this.transportId) throw new Error("Not connected to a cast device.");
    return this.channel;
  }

  private refresh() {
    const channel = this.channel;
    if (!channel || channel.isClosed || this.mediaSessionId === null) return;
    void channel.request(this.transportId, NS.media, { type: "GET_STATUS", mediaSessionId: this.mediaSessionId }, 5000).catch(() => {});
  }

  private onMessage(channel: CastChannel, msg: CastMessage) {
    if (channel !== this.channel) return;
    if (msg.namespace === NS.receiver && msg.data.type === "RECEIVER_STATUS") {
      // While connecting (no session yet) or stopping (session cleared first), the requester reads the reply itself.
      if (!this.sessionId || !this.transportId) return;
      const status = msg.data.status as ReceiverStatus;
      const ours = status.applications?.some((a) => a.sessionId === this.sessionId);
      if (this.sessionId && !ours) {
        // Someone cast something else, or stopped it from the Google Home app.
        this.endSession();
        this.emit("error", "takenOver");
        return;
      }
      if (status.volume) this.emit("session", { connected: true, volume: status.volume.level, muted: status.volume.muted });
      return;
    }
    if (msg.namespace === NS.connection && msg.data.type === "CLOSE" && msg.source === this.transportId) {
      this.endSession();
      return;
    }
    if (msg.namespace === NS.media && msg.data.type === "MEDIA_STATUS" && msg.source === this.transportId) {
      // A status for an older media session is about the previous track (load() handles its own reply).
      for (const s of (msg.data.status as MediaStatus[] | undefined) ?? []) {
        if (this.mediaSessionId !== null && s.mediaSessionId !== this.mediaSessionId) continue;
        this.emitStatus(s);
      }
    }
  }

  private emitStatus(s: MediaStatus) {
    const state = { PLAYING: "playing", PAUSED: "paused", BUFFERING: "buffering", IDLE: "idle" }[s.playerState ?? "IDLE"];
    this.emit("status", {
      state,
      position: s.currentTime ?? 0,
      duration: s.media?.duration ?? 0,
      idleReason: s.idleReason ? IDLE_REASONS[s.idleReason] : undefined,
    });
  }

  private endSession(announce = true) {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const channel = this.channel;
    this.channel = null;
    this.device = null;
    this.transportId = "";
    this.sessionId = "";
    this.mediaSessionId = null;
    channel?.close();
    if (announce) this.emit("session", { connected: false });
  }

  /** Asks the local server for the first byte: it resolves the stream and says what type it is, or why it can't. */
  private probe(id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: this.serverPort(), path: `/api/stream/${id}/audio`, headers: { Range: "bytes=0-0" } },
        (res) => {
          const type = String(res.headers["content-type"] ?? "");
          if (res.statusCode && res.statusCode < 400) {
            res.resume();
            return resolve(type.startsWith("audio/") ? type : "audio/mp4");
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            let message = `Error ${res.statusCode}`;
            let code: string | undefined;
            try {
              const parsed = JSON.parse(body) as { error?: string; code?: string };
              message = parsed.error ?? message;
              code = parsed.code;
            } catch {
              /* not JSON */
            }
            reject(Object.assign(new Error(message), { code }));
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(60_000, () => req.destroy(new Error("timed out")));
      req.end();
    });
  }

  private async ensureProxy(deviceIp: string) {
    const host = addressFacing(deviceIp);
    if (!host) throw new Error("noNetwork");
    if (this.proxy?.host === host) return;
    this.proxy?.server.close();
    this.proxy = null;

    const server = createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges");
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-headers", "range");
        res.writeHead(204).end();
        return;
      }
      const [, secret, id] = (req.url ?? "").split("?")[0]!.split("/");
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      if (secret !== this.secret || !id || !VIDEO_ID.test(id)) return void res.writeHead(404).end();

      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: this.serverPort(),
          method: req.method,
          path: `/api/stream/${id}/audio`,
          headers: typeof req.headers.range === "string" ? { Range: req.headers.range } : {},
        },
        (up) => {
          const headers: Record<string, string> = {};
          for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
            const v = up.headers[h];
            if (typeof v === "string") headers[h] = v;
          }
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      res.on("close", () => upstream.destroy());
      upstream.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("noNetwork");
    this.proxy = { server, host, port: address.port };
  }
}
