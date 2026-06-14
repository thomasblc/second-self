// "Master machine" tunnel (Path 2): the master holds the vault AND runs the model; a
// satellite is a thin client that browses the master's vault and runs inference on it.
//
// Transport: an encrypted hyperdht P2P socket, paired by the master's public key (same
// shape as the QVAC delegate's pairing code) and NAT-traversing off-LAN via the DHT.
// The master exposes its FULL app protocol over the socket by reusing the server's
// existing handle() dispatch; the satellite forwards every browser frame to the master
// and pipes replies + push frames straight back, so it is a transparent proxy.
//
// Framing: newline-delimited JSON. App frames never contain a raw newline (JSON.stringify
// escapes them), so splitting on "\n" is safe.
import DHT from "hyperdht";

const MAX_FRAME = 8 * 1024 * 1024; // 8 MB: bounds a peer that never sends a newline (OOM guard)
function frameReader(socket, onFrame) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_FRAME) { try { socket.destroy(); } catch { /* */ } return; }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try { onFrame(m); } catch { /* one bad frame must not kill the reader */ }
    }
  });
}
function writeFrame(socket, obj) { try { socket.write(JSON.stringify(obj) + "\n"); } catch { /* */ } }

// ---- MASTER: accept satellites, run each incoming frame through the app's handle() ----
export class MasterServer {
  constructor(dispatch) { this.dispatch = dispatch; this.dht = null; this.server = null; this.publicKey = null; this.conns = new Set(); }
  isOn() { return !!this.publicKey; }
  async start(seedHex) {
    if (this.server) return this.publicKey;
    this.dht = new DHT();
    const keyPair = seedHex && /^[0-9a-fA-F]{64}$/.test(seedHex) ? DHT.keyPair(Buffer.from(seedHex, "hex")) : DHT.keyPair();
    this.server = this.dht.createServer((socket) => this._onConn(socket));
    await this.server.listen(keyPair);
    this.publicKey = keyPair.publicKey.toString("hex");
    return this.publicKey;
  }
  _onConn(socket) {
    this.conns.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => this.conns.delete(socket));
    frameReader(socket, (msg) => {
      const { id, type } = msg || {};
      // mirror the WS reply/fail/push shape exactly, so satellites relay frames verbatim
      const reply = (data) => writeFrame(socket, { id, type, ok: true, data });
      const fail = (e) => writeFrame(socket, { id, type, ok: false, error: String(e?.message || e) });
      const push = (frame) => writeFrame(socket, { id, ...frame });
      Promise.resolve().then(() => this.dispatch(type, msg, { reply, fail, push })).catch((e) => fail(e));
    });
  }
  async stop() {
    for (const s of this.conns) { try { s.destroy(); } catch { /* */ } }
    this.conns.clear();
    try { await this.server?.close(); } catch { /* */ }
    try { await this.dht?.destroy(); } catch { /* */ }
    this.server = null; this.dht = null; this.publicKey = null;
  }
}

// ---- SATELLITE: connect to a master, forward browser frames, relay responses back ----
// Frames are tagged "cid:origId" so replies/pushes route to the right browser connection.
export class MasterClient {
  constructor() { this.dht = null; this.socket = null; this.relays = new Map(); this.pubkey = null; }
  connected() { return !!this.socket; }
  async connect(pubkeyHex, { timeout = 15000 } = {}) {
    if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex || "")) throw new Error("the pairing code must be a 64-character hex public key");
    this.dht = new DHT();
    const socket = this.dht.connect(Buffer.from(pubkeyHex, "hex"));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("could not reach the master machine (timeout)")), timeout);
      socket.once("open", () => { clearTimeout(t); resolve(); });
      socket.once("error", (e) => { clearTimeout(t); reject(e); });
    });
    this.socket = socket; this.pubkey = pubkeyHex;
    frameReader(socket, (m) => {
      const raw = String(m.id || ""); const sep = raw.indexOf(":");
      if (sep < 0) return;
      const cid = raw.slice(0, sep), origId = raw.slice(sep + 1);
      const relay = this.relays.get(cid);
      if (relay) relay({ ...m, id: origId || undefined });
    });
    socket.on("close", () => { const lost = this.socket; this.socket = null; if (lost) for (const [, relay] of this.relays) relay({ type: "remote.lost" }); });
    return true;
  }
  ensure(cid, relay) { this.relays.set(cid, relay); }       // register a browser connection's relay
  forward(cid, frame) { if (this.socket) writeFrame(this.socket, { ...frame, id: cid + ":" + (frame.id || "") }); }
  detach(cid) { this.relays.delete(cid); }
  async disconnect() {
    try { this.socket?.destroy(); } catch { /* */ }
    try { await this.dht?.destroy(); } catch { /* */ }
    this.socket = null; this.dht = null; this.relays.clear(); this.pubkey = null;
  }
}
