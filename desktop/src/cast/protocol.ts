import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";

/**
 * The Google Cast v2 protocol, the part Musike needs. Senders talk to a device over TLS on port 8009 in
 * length-prefixed protobuf frames (CastMessage); every payload is a JSON string on a namespace.
 * The message has six fields worth encoding, so it's done by hand instead of pulling in a protobuf library.
 */

export const NS = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
} as const;

export interface CastMessage {
  source: string;
  destination: string;
  namespace: string;
  data: Record<string, unknown>;
}

// --- protobuf: CastMessage { protocol_version=1 (enum), source_id=2, destination_id=3, namespace=4,
//                             payload_type=5 (enum, 0 = STRING), payload_utf8=6, payload_binary=7 }

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

const stringField = (field: number, value: string) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
};
const enumField = (field: number, value: number) => Buffer.concat([varint(field << 3), varint(value)]);

export function encode(msg: CastMessage): Buffer {
  const body = Buffer.concat([
    enumField(1, 0),
    stringField(2, msg.source),
    stringField(3, msg.destination),
    stringField(4, msg.namespace),
    enumField(5, 0),
    stringField(6, JSON.stringify(msg.data)),
  ]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

export function decode(body: Buffer): CastMessage | null {
  const fields: Record<number, string> = {};
  let i = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= body.length) throw new Error("truncated");
      const b = body[i++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
  };
  try {
    while (i < body.length) {
      const key = readVarint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      if (wire === 0) readVarint();
      else if (wire === 2) {
        const len = readVarint();
        fields[field] = body.subarray(i, i + len).toString("utf8");
        i += len;
      } else return null; // nothing the Cast protocol sends
    }
    const payload = fields[6];
    if (payload === undefined) return null; // binary payloads (device auth) aren't used here
    return { source: fields[2] ?? "", destination: fields[3] ?? "", namespace: fields[4] ?? "", data: JSON.parse(payload) };
  } catch {
    return null;
  }
}

/**
 * One TLS connection to a device. Emits "message" for every JSON message and "close" once.
 * Keeps itself alive with the protocol's heartbeat and gives up when the device stops answering.
 */
export class CastChannel extends EventEmitter {
  private socket: TLSSocket;
  private buffer = Buffer.alloc(0);
  private ping: NodeJS.Timeout | null = null;
  private lastSeen = Date.now();
  private closed = false;
  private requestId = 1;
  private waiting = new Map<number, { resolve: (m: CastMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  static open(host: string, port: number, timeoutMs = 8000): Promise<CastChannel> {
    return new Promise((resolve, reject) => {
      // Cast devices present a certificate signed by Google's device CA, not a public one: there is nothing to verify
      // it against here (Google's own senders authenticate the device separately, which playback doesn't need).
      const socket = connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs });
      const fail = (e: Error) => {
        socket.destroy();
        reject(e);
      };
      socket.once("secureConnect", () => {
        socket.off("error", fail);
        socket.setTimeout(0);
        resolve(new CastChannel(socket));
      });
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error("timed out")));
    });
  }

  private constructor(socket: TLSSocket) {
    super();
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    this.send("sender-0", "receiver-0", NS.connection, { type: "CONNECT" });
    this.ping = setInterval(() => {
      if (Date.now() - this.lastSeen > 16_000) return this.close();
      this.send("sender-0", "receiver-0", NS.heartbeat, { type: "PING" });
    }, 5000);
  }

  private onData(chunk: Buffer) {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = decode(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
      if (!msg) continue;
      if (msg.namespace === NS.heartbeat && msg.data.type === "PING") {
        this.send(msg.destination, msg.source, NS.heartbeat, { type: "PONG" });
        continue;
      }
      const id = msg.data.requestId;
      if (typeof id === "number" && this.waiting.has(id)) {
        const w = this.waiting.get(id)!;
        this.waiting.delete(id);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
      this.emit("message", msg);
    }
  }

  send(source: string, destination: string, namespace: string, data: Record<string, unknown>) {
    if (this.closed) return;
    this.socket.write(encode({ source, destination, namespace, data }));
  }

  /** Sends a message with a fresh requestId and waits for the reply that carries it. */
  request(destination: string, namespace: string, data: Record<string, unknown>, timeoutMs = 10_000): Promise<CastMessage> {
    if (this.closed) return Promise.reject(new Error("closed"));
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("the device didn't answer"));
      }, timeoutMs);
      this.waiting.set(requestId, { resolve, reject, timer });
      this.send("sender-0", destination, namespace, { ...data, requestId });
    });
  }

  get isClosed() {
    return this.closed;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("closed"));
    }
    this.waiting.clear();
    this.socket.destroy();
    this.emit("close");
  }
}
