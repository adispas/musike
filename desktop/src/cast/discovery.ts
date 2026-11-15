import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import makeMdns from "multicast-dns";

/**
 * Finds Cast devices on the local network over mDNS (`_googlecast._tcp`). Each device answers with a PTR (its
 * instance name), an SRV (port and host name), a TXT (id, friendly name, model) and an A record (its IP), not
 * always in the same packet, so records are collected until a device is complete.
 *
 * One mDNS socket per network adapter: Windows PCs often have VPN or Hyper-V adapters, and a query sent only on the
 * "default" one would never reach the Wi-Fi.
 */

const SERVICE = "_googlecast._tcp.local";

export interface FoundDevice {
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  seen: number;
}

type Mdns = ReturnType<typeof makeMdns>;

interface Answer {
  name: string;
  type: string;
  data: unknown;
}

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);

function parseTxt(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of Array.isArray(data) ? data : [data]) {
    const text = Buffer.isBuffer(part) ? part.toString("utf8") : String(part ?? "");
    const eq = text.indexOf("=");
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

export class Discovery extends EventEmitter {
  private sockets: Mdns[] = [];
  private timer: NodeJS.Timeout | null = null;
  private srv = new Map<string, { port: number; target: string }>();
  private txt = new Map<string, Record<string, string>>();
  private addr = new Map<string, string>();
  private instances = new Set<string>();
  readonly devices = new Map<string, FoundDevice>();

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    // Forget devices that haven't answered for a while (unplugged, renamed).
    const stale = Date.now() - 10 * 60_000;
    for (const [id, d] of this.devices) if (d.seen < stale) this.devices.delete(id);

    for (const address of lanAddresses()) {
      try {
        const mdns = makeMdns({ interface: address, bind: "0.0.0.0", reuseAddr: true });
        mdns.on("response", (res: { answers: Answer[]; additionals: Answer[] }) => this.onResponse([...res.answers, ...res.additionals]));
        mdns.on("error", () => {}); // port busy on this adapter: the others still work
        mdns.on("warning", () => {});
        this.sockets.push(mdns);
      } catch {
        /* adapter went away */
      }
    }
    this.query();
    this.timer = setInterval(() => this.query(), 3000);
    this.emit("devices", this.list());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
  }

  list(): FoundDevice[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private query() {
    for (const s of this.sockets) s.query({ questions: [{ name: SERVICE, type: "PTR" }] }, () => {});
  }

  private onResponse(records: Answer[]) {
    let touched = false;
    for (const r of records) {
      if (r.type === "PTR" && r.name === SERVICE && typeof r.data === "string") {
        this.instances.add(r.data);
        touched = true;
      } else if (r.type === "SRV") {
        const d = r.data as { port: number; target: string };
        this.srv.set(r.name, { port: d.port, target: d.target });
        touched = true;
      } else if (r.type === "TXT") {
        this.txt.set(r.name, parseTxt(r.data));
        touched = true;
      } else if (r.type === "A" && typeof r.data === "string") {
        this.addr.set(r.name, r.data);
        touched = true;
      }
    }
    if (touched) this.assemble();
  }

  private assemble() {
    let changed = false;
    for (const instance of this.instances) {
      const srv = this.srv.get(instance);
      const txt = this.txt.get(instance);
      const host = srv && this.addr.get(srv.target);
      if (!srv || !txt || !host) continue;
      const id = txt.id || instance;
      const device: FoundDevice = {
        id,
        name: txt.fn || instance.replace(`.${SERVICE}`, ""),
        model: txt.md || "",
        host,
        port: srv.port,
        seen: Date.now(),
      };
      const before = this.devices.get(id);
      if (!before || before.name !== device.name || before.host !== device.host || before.port !== device.port) changed = true;
      this.devices.set(id, device);
    }
    if (changed) this.emit("devices", this.list());
  }
}
