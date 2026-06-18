// Second Self - app backend. HTTP static + WebSocket orchestration over the vault,
// the knowledge graph, on-device embeddings/RAG, the LoRA trainer, and chat.
// Everything runs locally. The only network call in the whole app is the first-run
// model download into ~/.qvac/models. Privacy boundary is the product (recipe rule 4).
import "./lib/_boot.js"; // FIRST: silences the benign node:sqlite experimental warning before connectors load
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { Vault } from "./lib/vault.js";
import { buildGraph, addEmbedEdges } from "./lib/graph.js";
import { ModelManager, topKPairs, cosine, BASES } from "./lib/models.js";
import { ContextIndex, NEEDS_FDA } from "./lib/context.js";
import { resolveStorePath, SQLITE_TYPES } from "./lib/os-stores.js";
import { buildRecords, selectByEmbedding, refineWithLLM, buildCausalDataset } from "./lib/select.js";
import { Trainer } from "./lib/train.js";
import { buildCatalog, constantFor, modelTypeFor, deleteCached } from "./lib/catalog.js";
import { hardwareInfo, fit, recommend } from "./lib/hardware.js";
import { importCloudExport } from "./lib/cloud-chat.js";
import { MasterServer, MasterClient } from "./lib/master-link.js";
import { getConfig, saveConfig, rememberVault, forgetVault, CONFIG_DIR } from "./lib/config.js";
import { transcribeFile, speak, STT_LANGS, TTS_LANGS } from "./lib/voice.js";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

// Per-boot WS token. The product promise is "100% local": this stops a co-resident
// network-only process (a browser extension, another local service) that omits an Origin
// from driving the powerful ops (fs.browse, vault.setRoot -> arbitrary file read, etc.).
// The browser UI gets it injected into index.html; CLI/tests read it from the token file
// or set SECOND_SELF_TOKEN. (A process that can read the user's files can read the token
// too; this raises the bar against network-only local adversaries, not omnipotent ones.)
// Reuse the persisted token across restarts (env override wins). A fresh token every boot would
// orphan every already-open page (its injected token would no longer match) -> permanent
// "not connected" until a manual reload. Persisting keeps open tabs reconnecting cleanly after a
// restart, with no change to the threat model (this guards against network-only local adversaries;
// a process that can read ~/.second-self can read the token regardless).
const TOKEN_FILE = path.join(CONFIG_DIR, "ws-token");
function loadOrCreateToken() {
  if (process.env.SECOND_SELF_TOKEN) return process.env.SECOND_SELF_TOKEN;
  try { const t = fs.readFileSync(TOKEN_FILE, "utf8").trim(); if (/^[a-f0-9]{32,}$/.test(t)) return t; } catch { /* no/!readable file -> mint one */ }
  return crypto.randomBytes(24).toString("hex");
}
const WS_TOKEN = loadOrCreateToken();
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(TOKEN_FILE, WS_TOKEN, { mode: 0o600 }); } catch { /* non-fatal */ }
const SEGMENT_RE = /^[^/\\\x00-\x1f]+$/; // a single path segment: no separators, no control chars/NUL

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_ROOT = path.resolve(APP_DIR, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../../..");
const PUBLIC = path.join(APP_DIR, "public");
const PORT = Number(process.env.PORT || 3090);

// The bundled demo vault: always offered so the user can explore / get back to it.
const SAMPLE = path.join(APP_DIR, "sample-vault");
const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
// Like isDir but tells a TCC-blocked store (needs Full Disk Access) apart from a truly-absent one,
// so a preset whose directory itself is permission-denied still routes to the grant-access flow.
const dirStatus = (p) => { try { return fs.statSync(p).isDirectory() ? "dir" : "notdir"; } catch (e) { return (e && (e.code === "EPERM" || e.code === "EACCES")) ? "blocked" : "absent"; } };

// Identity + environment preamble for every chat. Gives the model a stable self (so a base model
// doesn't free-associate "I'm ChatGPT/Qwen") and awareness of what it can do here, so it can tell
// the user how to unlock its memory/vault access instead of flatly denying it.
// When the active vault changes, drop any indexed vault source pointing at a DIFFERENT folder, so
// stale chunks + broken citations don't linger in Memory. A same-path setRoot (e.g. on boot) is a
// no-op, so a previously-indexed vault survives a restart. The new vault shows as un-indexed in the
// Memory tab until the user re-indexes it.
function dropStaleVaultSources(newRoot) {
  const cur = path.resolve(newRoot || "");
  let dropped = 0;
  for (const s of contextIndex.sources.filter((x) => x.type === "vault" && path.resolve(x.path) !== cur)) { contextIndex.removeSource(s.id); dropped++; }
  if (dropped) broadcast({ type: "context.changed", reason: "vault-switched" });
  return dropped;
}

function identityPrompt() {
  const name = getConfig().agentName || "Second Self";
  return `You are ${name}, a private AI assistant that runs 100% on the owner's own computer through the QVAC on-device runtime. No data ever leaves this machine; there is no cloud. You are not ChatGPT, Gemini, Claude, or any hosted assistant - your identity is ${name}, running locally on top of an open model. Speak in the owner's language. The person you are talking to is the owner of this machine.`;
}

// Vault precedence: $SECOND_SELF_VAULT (explicit override) > last vault from config >
// bundled demo > this repo's docs/ (dev fallback). The chosen one is remembered in config.
const cfg = getConfig();
const DEFAULT_VAULT = (process.env.SECOND_SELF_VAULT && isDir(process.env.SECOND_SELF_VAULT) && process.env.SECOND_SELF_VAULT)
  || (isDir(cfg.current) && cfg.current)
  || (isDir(SAMPLE) ? SAMPLE
    : (isDir(path.join(REPO_ROOT, "docs")) ? path.join(REPO_ROOT, "docs") : RECIPE_ROOT));

const vault = new Vault(DEFAULT_VAULT);
const isDemoVault = () => path.resolve(vault.root) === path.resolve(SAMPLE);
// Seed the known-vaults list: the active one (made current) + the demo (kept reachable).
rememberVault(vault.root, isDemoVault() ? "Demo vault" : undefined);
if (isDir(SAMPLE)) {
  const c = getConfig();
  if (!c.vaults.some((v) => path.resolve(v.path) === path.resolve(SAMPLE))) {
    saveConfig({ vaults: [...c.vaults, { path: SAMPLE, name: "Demo vault" }].slice(0, 12) });
  }
}

// Browse the local filesystem for the folder/file pickers (dirs by default; the active
// user's own machine, localhost-only socket). Read-only metadata, never file contents.
function browseDir(target, { files = false, ext = null } = {}) {
  let dir = target && target.trim() ? path.resolve(target) : os.homedir();
  if (!isDir(dir)) dir = os.homedir();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const dirs = [], fileList = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;            // hide dotfiles/dirs by default
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      let notes = 0; try { notes = fs.readdirSync(full).filter((f) => /\.(md|markdown|txt)$/i.test(f)).length; } catch { /* */ }
      dirs.push({ name: e.name, path: full, notes });
    } else if (files && e.isFile() && (!ext || e.name.toLowerCase().endsWith(ext))) {
      fileList.push({ name: e.name, path: full });
    }
    if (dirs.length + fileList.length > 1000) break;  // cap pathological directories
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  fileList.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs, files: fileList };
}
const mm = new ModelManager({ ctxSize: 4096 });
const trainer = new Trainer(RECIPE_ROOT);
const contextIndex = new ContextIndex(); // personal context engine: source-tracked, citable, persisted
const embedFor = (texts, opts = {}) => mm.embedMany(texts, opts); // injected into the index so it stays SDK-agnostic
// "master machine" tunnel (Path 2): this process can BE a master (expose its vault+model
// over P2P) and/or connect to one as a satellite (proxy all ops to it). handle() is hoisted.
// SECURITY: the pairing code is a bearer capability, but the tunnel must NOT expose every op.
// Only these thin-client ops run on the master for a connected satellite. Everything else
// (vault re-rooting, fs.* browse/mkdir, import.cloud's unsandboxed read, master/provider/remote
// self-reconfig, config writes, model download/delete) is DENIED over the link. vault CRUD is
// allowed but stays confined to the master's vault root by vault.js. This allow-list lives on
// the MASTER side, where the frame is actually executed.
const TUNNEL_ALLOW = new Set([
  "vault.list", "vault.read", "vault.info", "vault.search", "vault.write", "vault.create", "vault.rename", "vault.delete",
  "graph.build", "graph.embed", "graph.highlight", "select.auto", "select.refine",
  "rag.ingest", "rag.forget", "model.status", "model.catalog", "model.hardware", "model.warm",
  "chat.send", "agent.chat", "train.adapters", "train.start", "train.stop",
  "context.sources", "context.search", // satellite may read the master's context (not manage its sources)
]);
const masterServer = new MasterServer((type, msg, cbs) => {
  if (!TUNNEL_ALLOW.has(type)) return cbs.fail("this operation is not allowed over the master link");
  return handle(type, msg, cbs);
});
let masterClient = null; // set when this machine is a satellite connected to a master
// ops that stay LOCAL even while connected to a master: link/prefs management AND vault/device
// management (switching, creating, browsing, importing) which always act on THIS device, never
// the master. Note CRUD (vault.write/create/rename/delete) is NOT here - it forwards to edit the
// master's notes. The satellite leaves the master before a local vault switch (see app.js).
const LOCAL_ONLY = new Set([
  "master.start", "master.stop", "master.connect", "master.disconnect", "master.status",
  "provider.start", "provider.stop", "remote.connect", "remote.disconnect", "remote.status",
  "config.get", "config.set",
  "vault.vaults", "vault.switchVault", "vault.setRoot", "vault.createVault", "vault.removeVault",
  "fs.browse", "fs.mkdir", "import.cloud", "system.openSettings",
]);
let graphCache = null;       // last built graph (link+tag), embed edges merged in place
let lastSelection = null;    // last auto-selection result
let docEmb = null;           // { records:[{path,prose,...}], vectors:number[][] } cache
function invalidateCaches() { graphCache = null; docEmb = null; lastSelection = null; }

// Embed every prose note once and cache it (shared by graph semantic edges, NL highlight).
async function ensureDocEmb(push) {
  if (docEmb) return docEmb;
  const records = buildRecords(vault).filter((r) => r.kind === "prose" && r.prose);
  if (push) push({ type: "embed.progress", done: 0, total: records.length });
  const vectors = records.length
    ? await mm.embedMany(records.map((r) => r.prose.slice(0, 1500)), {
        onProgress: (d, t) => push && push({ type: "embed.progress", done: d, total: t }),
      })
    : [];
  docEmb = { records, vectors };
  return docEmb;
}

// ---- weekly auto-retrain (opt-in). Re-selects relevant docs from the CURRENT vault and
// retrains, so the voice model keeps up with new notes. Guarded: never runs while a manual
// run is active; catches up shortly after boot if the interval has already lapsed. ----
let retrainTimer = null;
let retrainBusy = false; // true while doRetrain holds the shared model worker (embed -> unload -> train)
let syncBusy = false;    // true for the WHOLE doSync loop, so a retrain (which bypasses the worker mutex) can't slip between sources
async function doRetrain() {
  const c = getConfig();
  if (!c.autoRetrain.enabled) return;
  if (trainer.isRunning() || retrainBusy || syncBusy) { scheduleAutoRetrain(60 * 1000); return; } // busy (incl. a background sync): retry in a minute
  retrainBusy = true; // block user MODEL_OPS during the embed+unload window (before trainer.isRunning() flips)
  try {
    broadcast({ type: "autoRetrain.start" });
    const recs = buildRecords(vault);
    const selection = await selectByEmbedding(recs, mm, {});
    const paths = selection.filter((s) => s.selected).map((s) => s.path);
    if (!paths.length) { broadcast({ type: "autoRetrain.skip", reason: "no documents selected" }); return; }
    const outDir = path.join(RECIPE_ROOT, "data", "vault-build");
    const ds = buildCausalDataset(vault, paths, outDir);
    if (ds.trainChars < 500) { broadcast({ type: "autoRetrain.skip", reason: "not enough text in the vault yet" }); return; }
    await mm.unloadAll();
    const baseKey = BASES[c.autoRetrain.baseKey] ? c.autoRetrain.baseKey : "1.7b"; // validate against known bases
    // namespace frames as autoRetrain.* so the background run never drives the manual Train UI
    trainer.start(
      { baseKey, mode: "causal", dataset: "vault", trainPath: ds.trainPath, evalPath: ds.evalPath, ctx: 256, epochs: 1 },
      (ev) => broadcast({ ...ev, type: "autoRetrain." + ev.type }),
    );
  } catch (e) { broadcast({ type: "autoRetrain.skip", reason: String(e?.message || e) }); }
  finally { retrainBusy = false; saveConfig({ autoRetrain: { lastRun: Date.now() } }); scheduleAutoRetrain(); }
}
function scheduleAutoRetrain(overrideMs) {
  if (retrainTimer) { clearTimeout(retrainTimer); retrainTimer = null; }
  const c = getConfig();
  if (!c.autoRetrain.enabled) return;
  let ms;
  if (overrideMs != null) ms = overrideMs;
  else {
    const intervalMs = Math.max(1, c.autoRetrain.intervalDays || 7) * 86400000;
    const since = c.autoRetrain.lastRun ? Date.now() - c.autoRetrain.lastRun : Infinity;
    ms = since >= intervalMs ? 60 * 1000 : Math.min(intervalMs - since, 2 ** 31 - 1); // overdue -> run soon
  }
  retrainTimer = setTimeout(doRetrain, ms);
}

// ---- auto-sync (opt-in): re-index every context source on a schedule so memory stays near-live.
// Re-embed only (light); skips while a training run holds the worker. Build-then-swap per source,
// so a now-blocked/deleted source is skipped (old data kept), not wiped. ----
let syncTimer = null;
async function doSync() {
  const c = getConfig();
  if (!c.autoSync.enabled) return;
  if (syncBusy) return;                                                                  // a sync is already running; it re-arms the timer when it finishes
  if (trainer.isRunning() || retrainBusy) { scheduleAutoSync(10 * 60 * 1000); return; }  // busy: retry in 10 min
  syncBusy = true;
  try {
    let reindexed = 0;
    for (const s of contextIndex.sources.slice()) {
      try { const r = await contextIndex.reindexSource(s.id, embedFor); if (r) reindexed++; } // null => source was removed mid-sync; don't count it
      catch (e) { broadcast({ type: "context.syncSkip", source: s.label, reason: String(e?.message || e) }); }
    }
    saveConfig({ autoSync: { lastRun: Date.now() } });
    broadcast({ type: "context.synced", sources: reindexed });
  } finally { syncBusy = false; scheduleAutoSync(); }
}
function scheduleAutoSync(overrideMs) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  const c = getConfig();
  if (!c.autoSync.enabled) return;
  let ms;
  if (overrideMs != null) ms = overrideMs;
  else {
    const intervalMs = Math.max(1, c.autoSync.intervalHours || 24) * 3600000;
    const since = c.autoSync.lastRun ? Date.now() - c.autoSync.lastRun : Infinity;
    ms = since >= intervalMs ? 30 * 1000 : Math.min(intervalMs - since, 2 ** 31 - 1); // overdue -> run soon
  }
  syncTimer = setTimeout(doSync, ms);
}

// ---- static HTTP ----
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", ""];
const server = http.createServer(async (req, res) => {
  try {
    // Host allow-list: blocks DNS-rebinding even if an attacker page presents an allowed Origin.
    const host = (req.headers.host || "").split(":")[0];
    if (!LOCAL_HOSTS.includes(host)) { res.writeHead(403); res.end("forbidden"); return; }

    // ---- voice I/O API (token-gated, 127.0.0.1 only, on-device). Audio bytes in/out. ----
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname.startsWith("/api/voice/")) {
      if (u.searchParams.get("t") !== WS_TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
      const readRaw = async () => { const c = []; for await (const ch of req) c.push(ch); return Buffer.concat(c); };
      if (req.method === "POST" && u.pathname === "/api/voice/transcribe") {
        const lang = (u.searchParams.get("lang") || "en").toLowerCase();
        const tmp = path.join(os.tmpdir(), `ss-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        try { fs.writeFileSync(tmp, await readRaw()); const text = await transcribeFile(tmp, lang); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ text })); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
        finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
        return;
      }
      if (req.method === "POST" && u.pathname === "/api/voice/speak") {
        let body = {}; try { body = JSON.parse((await readRaw()).toString() || "{}"); } catch { /* */ }
        const text = String(body.text || "").trim(); const lang = String(body.lang || "en").toLowerCase();
        if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "text required" })); return; }
        try { const wav = await speak(text, lang); res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length }); res.end(wav); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
        return;
      }
      res.writeHead(404); res.end("not found"); return;
    }

    let p = decodeURIComponent((req.url || "/").split("?")[0]); // can throw URIError on bad %-escapes
    if (p === "/") p = "/index.html";
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    if (file === path.join(PUBLIC, "index.html")) {
      // inject the per-boot WS token so the browser UI can authenticate its socket
      const html = fs.readFileSync(file, "utf8").replace("</head>", `<script>window.__SS_TOKEN=${JSON.stringify(WS_TOKEN)};</script></head>`);
      // no-store: the token rotates each boot, so a cached page must never serve a stale one
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); res.end(html); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    try { res.writeHead(400); res.end("bad request"); } catch { /* */ }
  }
});

// ---- vault file watcher: keep the app's view current when files change on disk
// (external edits, or a folder synced via iCloud/Dropbox/git = built-in sync for a
// local-first app). Debounced; broadcast to all clients. ----
let watchTimer = null, watcher = null;
function broadcast(obj) { const s = JSON.stringify(obj); for (const c of wss.clients) { if (c.readyState === 1) { try { c.send(s); } catch { /* */ } } } }
function startVaultWatch() {
  if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
  try {
    watcher = fs.watch(vault.root, { recursive: true }, (_evt, file) => {
      if (!file || /(^|\/)\.|\/(node_modules|\.git|train|\.obsidian)\//.test(file)) return;
      if (!/\.(md|markdown|txt)$/i.test(file)) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { invalidateCaches(); broadcast({ type: "vault.changed" }); }, 500);
    });
  } catch { /* recursive watch may be unsupported on some platforms; non-fatal */ }
}

// ---- WebSocket protocol: {id, type, ...} request -> {id, ok, data|error} reply;
// streaming handlers also push {type, id, ...} frames before the final reply. ----
// Reject cross-origin browser connections (CSRF / DNS-rebinding): a malicious page the
// operator visits could otherwise drive vault.delete / setRoot / train.start. Browsers
// always send Origin; local CLI tools (our smoke tests) send none and are allowed.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => {
    // Require the per-boot token from EVERY client (browser gets it injected into index.html;
    // CLI/tests read SECOND_SELF_TOKEN / the token file). No Origin fallback: that previously let
    // ANY other localhost page/app drive the full API without the token (review P1). Host check
    // still blocks DNS-rebinding.
    const host = (req.headers.host || "").split(":")[0];
    if (!LOCAL_HOSTS.includes(host)) return false;
    try { return new URL(req.url, "http://x").searchParams.get("t") === WS_TOKEN; } catch { return false; }
  },
});
wss.on("connection", (ws) => {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* */ } };
  const cid = crypto.randomBytes(12).toString("hex"); // routes proxied master replies back to this browser (wide enough to avoid collisions)
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, type } = msg || {};
    // satellite mode: when connected to a master, proxy every non-local op to it (the master
    // holds the vault + runs the model). Replies/pushes are relayed back verbatim.
    if (masterClient && masterClient.connected() && !LOCAL_ONLY.has(type)) {
      masterClient.ensure(cid, send);
      masterClient.forward(cid, msg);
      return;
    }
    const reply = (data) => send({ id, type, ok: true, data });
    const fail = (e) => send({ id, type, ok: false, error: String(e?.message || e) });
    const push = (frame) => send({ id, ...frame });
    try {
      await handle(type, msg, { reply, fail, push });
    } catch (e) { fail(e); }
  });
  ws.on("close", () => { if (masterClient) masterClient.detach(cid); });
  // greet with current state
  send({ type: "hello", data: { vaultRoot: vault.root, model: mm.status(), running: trainer.isRunning(), adapters: trainer.listAdapters(), voice: { stt: STT_LANGS, tts: TTS_LANGS } } });
});

// Ops that load an SDK model. While a training child holds the global ~/.qvac lock,
// these would contend with it, so refuse them until the run finishes.
// Back up a note's prior content before the agent overwrites it, so an agent edit is NEVER
// destructive (P0 safety: write_note was create-or-overwrite with no confirmation/undo). Backups
// live under ~/.second-self/agent-backups/ (outside the vault: not shown in the editor/graph, not
// re-indexed) as <ISO-timestamp>__<flattened-rel-path>. Best-effort; returns the backup path or null.
const AGENT_BACKUP_DIR = path.join(CONFIG_DIR, "agent-backups");
function backupNote(rel, content) {
  try {
    fs.mkdirSync(AGENT_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(AGENT_BACKUP_DIR, `${stamp}__${rel.replace(/[/\\]/g, "__")}`);
    fs.writeFileSync(dest, content, "utf8");
    return dest;
  } catch { return null; }
}

const MODEL_OPS = new Set(["graph.embed", "graph.highlight", "select.auto", "select.refine", "model.warm", "model.download", "rag.ingest", "chat.send", "agent.chat", "provider.start", "remote.connect", "context.addSource", "context.reindex", "context.search"]);

async function handle(type, msg, { reply, fail, push }) {
  if (MODEL_OPS.has(type) && (trainer.isRunning() || retrainBusy)) return fail("training in progress - try again when it finishes");
  if ((type === "train.start" || type === "chat.send" || type === "model.warm" || type === "agent.chat") && msg.baseKey && !BASES[msg.baseKey]) {
    return fail(`unknown base ${msg.baseKey}`);
  }
  switch (type) {
    case "vault.info": return reply({ root: vault.root, name: path.basename(vault.root), isDemo: isDemoVault(), repoDocs: path.join(REPO_ROOT, "docs"), sample: SAMPLE });
    case "vault.vaults": { const c = getConfig(); return reply({ vaults: c.vaults, current: vault.root, isDemo: isDemoVault(), sample: SAMPLE }); }
    case "fs.browse": return reply(browseDir(msg.path, { files: !!msg.files, ext: msg.ext || null }));
    case "fs.mkdir": {
      // constrain to a single new segment under an existing parent (no traversal / absolute escape)
      if (!msg.name || !SEGMENT_RE.test(msg.name) || msg.name === "." || msg.name === "..") return fail("invalid folder name");
      if (!isDir(msg.path)) return fail("pick an existing parent folder first");
      const dir = path.join(path.resolve(msg.path), msg.name);
      fs.mkdirSync(dir, { recursive: true });
      return reply({ path: dir });
    }
    case "vault.setRoot": { const root = vault.setRoot(msg.path); rememberVault(root); invalidateCaches(); startVaultWatch(); dropStaleVaultSources(root); return reply({ root, isDemo: isDemoVault() }); }
    case "vault.switchVault": {
      if (!isDir(msg.path)) return fail("that folder no longer exists");
      const root = vault.setRoot(msg.path); rememberVault(root); invalidateCaches(); startVaultWatch(); dropStaleVaultSources(root);
      return reply({ root, isDemo: isDemoVault() });
    }
    case "vault.removeVault": { forgetVault(msg.path); const c = getConfig(); return reply({ vaults: c.vaults }); }
    case "vault.createVault": {
      // make a new vault folder + a starter note, then switch to it (onboarding "create vault")
      const dir = path.resolve(msg.path);
      fs.mkdirSync(dir, { recursive: true });
      const welcome = path.join(dir, "Welcome.md");
      if (!fs.existsSync(welcome)) fs.writeFileSync(welcome, "# Welcome to your vault\n\nThis is your second brain. Create notes, link them with [[wikilinks]], and watch the graph grow. When you have enough notes, train a model on yourself from the Chat tab (Train your voice).\n\n- [[ideas]]\n- [[projects]]\n", "utf8");
      vault.setRoot(dir); rememberVault(dir, msg.name); invalidateCaches(); startVaultWatch(); dropStaleVaultSources(vault.root);
      return reply({ root: vault.root, isDemo: isDemoVault() });
    }
    case "config.get": { const c = getConfig(); return reply({ agentName: c.agentName, autoRetrain: c.autoRetrain, autoSync: c.autoSync, ui: c.ui }); }
    case "config.set": {
      // only touch the section(s) the client actually sent (autoRetrain and autoSync are
      // independent toggles in different panels; sending one must not reset the other).
      const cur = getConfig(); const patch = {};
      if (typeof msg.agentName === "string") { const n = msg.agentName.trim().slice(0, 40); patch.agentName = n || "Second Self"; }
      if (msg.autoRetrain) {
        const prev = cur.autoRetrain, inA = msg.autoRetrain;
        const enabled = !!inA.enabled;
        const intervalDays = Math.min(365, Math.max(1, Number(inA.intervalDays) || prev.intervalDays || 7));
        const baseKey = BASES[inA.baseKey] ? inA.baseKey : (BASES[prev.baseKey] ? prev.baseKey : "1.7b");
        let lastRun = prev.lastRun; if (enabled && !prev.enabled && !lastRun) lastRun = Date.now(); // first enable: don't fire immediately
        patch.autoRetrain = { enabled, intervalDays, baseKey, lastRun };
      }
      if (msg.autoSync) {
        const prev = cur.autoSync, inS = msg.autoSync;
        const enabled = !!inS.enabled;
        const intervalHours = Math.min(168, Math.max(1, Number(inS.intervalHours) || prev.intervalHours || 24));
        let lastRun = prev.lastRun; if (enabled && !prev.enabled && !lastRun) lastRun = Date.now();
        patch.autoSync = { enabled, intervalHours, lastRun };
      }
      if (msg.ui && typeof msg.ui === "object") patch.ui = msg.ui;
      const c = saveConfig(patch);
      // re-arm only the scheduler whose config actually changed (re-arming sync needlessly could
      // start an overdue run while another is in flight; the syncBusy guard catches it, but don't poke it)
      if (msg.autoRetrain) scheduleAutoRetrain();
      if (msg.autoSync) scheduleAutoSync();
      return reply({ agentName: c.agentName, autoRetrain: c.autoRetrain, autoSync: c.autoSync, ui: c.ui });
    }
    case "vault.list": return reply({ root: vault.root, files: vault.list() });
    case "vault.read": return reply({ path: msg.path, content: vault.read(msg.path) });
    case "vault.write": { const r = vault.write(msg.path, msg.content); invalidateCaches(); return reply(r); }
    case "vault.create": { const r = vault.create(msg.path, msg.content || `# ${path.basename(msg.path).replace(/\.md$/, "")}\n\n`); invalidateCaches(); return reply(r); }
    case "vault.rename": { const r = vault.rename(msg.from, msg.to); invalidateCaches(); return reply(r); }
    case "vault.delete": { const r = vault.remove(msg.path); invalidateCaches(); return reply(r); }
    case "vault.search": return reply({ results: vault.search(msg.query, msg.limit || 50) });
    case "import.cloud": { const r = importCloudExport(msg.path, vault, msg.dest || "imported"); invalidateCaches(); return reply(r); }

    case "graph.build": { graphCache = buildGraph(vault); return reply(graphCache); }
    case "graph.embed": {
      const { records, vectors } = await ensureDocEmb(push);
      // build the graph AFTER the embed await: a vault-watcher invalidateCaches() can fire
      // during the (slow) embedder load and null graphCache, so building here keeps it non-null
      // through addEmbedEdges (no await between build and use).
      if (!graphCache) graphCache = buildGraph(vault);
      if (records.length < 2) return reply({ ...graphCache, embedNote: "not enough prose notes to embed" });
      const pairs = topKPairs(records.map((r) => r.path), vectors, 4, 0.6);
      addEmbedEdges(graphCache, pairs, 0.6);
      return reply(graphCache);
    }
    case "graph.highlight": {
      // "highlight all docs of the recipe" etc: embed the query, rank notes by cosine,
      // boosted when a query word matches the note's folder/path. Model-powered (embedder).
      const q = String(msg.query || "").trim();
      if (!q) return reply({ matches: [], query: q });
      const { records, vectors } = await ensureDocEmb(push);
      if (!records.length) return reply({ matches: [], query: q, note: "no prose notes embedded" });
      const qvec = (await mm.embedMany([q]))[0];
      const tokens = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const scored = records.map((r, i) => {
        let score = cosine(qvec, vectors[i]);
        const hay = r.path.toLowerCase();
        if (tokens.some((t) => hay.includes(t))) score += 0.15; // folder/filename match
        return { path: r.path, score: Number(score.toFixed(4)) };
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0]?.score || 0;
      const matches = scored.filter((s) => s.score >= Math.max(0.45, top - 0.12)).slice(0, 30);
      return reply({ matches, query: q, count: matches.length });
    }

    case "select.auto": {
      const recs = buildRecords(vault);
      push({ type: "select.progress", done: 0, total: recs.filter((r) => r.kind === "prose").length });
      lastSelection = await selectByEmbedding(recs, mm, {
        onProgress: (d, t) => push({ type: "select.progress", done: d, total: t }),
      });
      return reply({ selection: lastSelection, selected: lastSelection.filter((s) => s.selected).length });
    }
    case "select.refine": {
      const recs = buildRecords(vault);
      const ll = await refineWithLLM(recs, mm, { baseKey: msg.baseKey || "1.7b", limit: msg.limit || 20 });
      return reply({ refine: ll });
    }

    case "model.status": return reply(mm.status());
    // ---- remote / delegated inference over QVAC P2P ----
    case "provider.start": { const pk = await mm.startProvider(msg.allowedKeys); return reply({ publicKey: pk }); }
    case "provider.stop": { await mm.stopProvider(); return reply({ stopped: true }); }
    case "remote.status": return reply({ remote: mm.getRemote(), provider: mm.provider });
    case "remote.connect": {
      const pk = String(msg.providerPublicKey || "").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(pk)) return fail("the pairing code must be a 64-character hex public key");
      mm.setRemote(pk);
      try { await mm.ensureLLM({ baseKey: msg.baseKey && BASES[msg.baseKey] ? msg.baseKey : "1.7b" }); return reply({ connected: true, providerPublicKey: pk }); }
      catch (e) { mm.setRemote(null); return fail("could not reach the remote machine: " + e.message); }
    }
    case "remote.disconnect": { mm.setRemote(null); return reply({ connected: false }); }
    // ---- "master machine": this box holds the vault + runs the model; satellites proxy to it ----
    case "master.start": { const pk = await masterServer.start(process.env.QVAC_HYPERSWARM_SEED); return reply({ publicKey: pk }); }
    case "master.stop": { await masterServer.stop(); return reply({ stopped: true }); }
    case "master.status": return reply({ master: masterServer.isOn(), publicKey: masterServer.publicKey, connected: !!(masterClient && masterClient.connected()), masterKey: (masterClient && masterClient.pubkey) || null });
    case "master.connect": {
      const pk = String(msg.publicKey || msg.pubkey || "").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(pk)) return fail("the pairing code must be a 64-character hex public key");
      if (masterClient) { try { await masterClient.disconnect(); } catch { /* */ } masterClient = null; }
      const c = new MasterClient();
      try { await c.connect(pk); masterClient = c; return reply({ connected: true, masterKey: pk }); }
      catch (e) { try { await c.disconnect(); } catch { /* */ } return fail("could not connect to the master machine: " + e.message); }
    }
    case "master.disconnect": { if (masterClient) { try { await masterClient.disconnect(); } catch { /* */ } masterClient = null; } return reply({ connected: false }); }
    case "model.warm": { await mm.ensureLLM({ baseKey: msg.baseKey || "1.7b" }); return reply(mm.status()); }
    case "model.catalog": {
      const models = buildCatalog();
      const hw = hardwareInfo();
      for (const m of models) m.fit = fit(m, hw);
      return reply({ models, hardware: hw, recommend: recommend(models, hw) });
    }
    case "model.hardware": { const hw = hardwareInfo(); return reply({ ...hw, recommend: recommend(buildCatalog(), hw) }); }
    case "model.download": {
      const m = constantFor(msg.name);
      if (!m) return fail(`unknown or non-catalog model: ${msg.name}`);
      push({ type: "download.progress", name: msg.name, pct: 0 });
      await mm.download(m, modelTypeFor(m), (p) => push({ type: "download.progress", name: msg.name, pct: Math.round(p?.percentage ?? 0) }));
      return reply({ name: msg.name, cached: true });
    }
    case "model.delete": {
      const m = constantFor(msg.name);
      if (!m) return fail(`unknown or non-catalog model: ${msg.name}`);
      const removed = deleteCached(m);
      return reply({ name: msg.name, removed });
    }

    // "Index vault for memory" = (re)index the current vault as source #1 of the context engine.
    // Build-then-swap so a failed/empty re-index never wipes existing memory (review P0-4).
    case "rag.ingest": {
      const onProgress = (d, t, phase) => push({ type: "rag.progress", phase: phase || "embedding", done: d, total: t });
      const existing = contextIndex.sources.find((s) => s.type === "vault");
      let src;
      if (existing && path.resolve(existing.path) === path.resolve(vault.root)) {
        src = await contextIndex.reindexSource(existing.id, embedFor, onProgress); // same vault, refresh (atomic)
      } else {
        // first index, or the vault changed: build the new one (throws before touching anything if empty),
        src = await contextIndex.addFolderSource({ rootPath: vault.root, label: path.basename(vault.root), type: "vault", exts: ["md", "markdown", "txt", "pdf", "docx"] }, embedFor, onProgress);
        for (const s of contextIndex.sources.filter((x) => x.type === "vault" && x.id !== src.id)) contextIndex.removeSource(s.id); // then drop stale vault sources
      }
      if (!src) return reply({ ingested: 0, chunks: 0 }); // reindexSource returns null if the vault source was removed mid-embed (rare race); nothing to report
      return reply({ ingested: src.docCount, chunks: src.chunkCount });
    }
    case "rag.forget": { for (const s of contextIndex.sources.filter((x) => x.type === "vault")) contextIndex.removeSource(s.id); return reply({ ok: true }); }

    // ---- personal context engine: sources beyond the vault ----
    case "context.sources": return reply(contextIndex.stats());
    case "context.addSource": {
      // presets point at known macOS stores (TCC-protected -> may throw FULL_DISK_ACCESS_REQUIRED,
      // which the UI turns into a "grant access" flow). Otherwise a plain user-picked folder.
      // Folder stores (calendar/mail) live at a fixed dir; SQLite stores (browser/contacts/messages)
      // are file-backed and resolved across known browsers / locations.
      const home = os.homedir();
      const PRESETS = {
        calendar: { path: path.join(home, "Library", "Calendars"), label: "Apple Calendar", type: "calendar", exts: ["ics"] },
        mail:     { path: resolveStorePath("mail"),     label: "Apple Mail",      type: "mail", exts: ["emlx"] },
        browser:  { path: resolveStorePath("browser"),  label: "Browser history", type: "browser" },
        contacts: { path: resolveStorePath("contacts"), label: "Contacts",        type: "contacts" },
        messages: { path: resolveStorePath("messages"), label: "Messages",        type: "messages" },
      };
      if (msg.preset && !PRESETS[msg.preset]) return fail("unknown source preset");
      const p = (msg.preset && PRESETS[msg.preset]) || { path: msg.path, label: msg.label, type: "folder", exts: msg.exts || null };
      if (msg.preset && !p.path) return fail(`No ${p.label} found on this machine.`); // app not installed / store absent
      // folder-type sources get a friendly existence/permission precheck; SQLite stores are file-backed
      // and validated inside _buildSqlite (which throws NEEDS_FDA on a TCC block), so skip the dir check.
      if (!SQLITE_TYPES.has(p.type)) {
        const st = dirStatus(p.path);
        if (st === "blocked") return fail(NEEDS_FDA); // even stat-ing it is TCC-denied -> open the grant-access flow
        if (st !== "dir") return fail(msg.preset ? `${p.label} store not found` : "pick an existing folder");
      }
      const onProgress = (d, t, phase) => push({ type: "context.progress", phase: phase || "embedding", done: d, total: t });
      const src = await contextIndex.addFolderSource({ rootPath: p.path, label: p.label, type: p.type, exts: p.exts }, embedFor, onProgress);
      return reply({ source: src, ...contextIndex.stats() });
    }
    // open macOS System Settings to the Full Disk Access pane (so the user can grant it in one click)
    case "system.openSettings": {
      if (process.platform === "darwin") { try { execFile("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]); } catch { /* */ } }
      return reply({ opened: process.platform === "darwin" });
    }
    // NB: param is sourceId, NOT id - the WS frame already uses `id` for request matching;
    // a payload `id` would be spread over it and the reply would never match (silent hang).
    case "context.removeSource": { contextIndex.removeSource(msg.sourceId); return reply(contextIndex.stats()); }
    case "context.reindex": {
      const onProgress = (d, t, phase) => push({ type: "context.progress", phase: phase || "embedding", done: d, total: t });
      await contextIndex.reindexSource(msg.sourceId, embedFor, onProgress);
      return reply(contextIndex.stats());
    }
    case "context.search": {
      const q = String(msg.query || "").trim();
      if (!q || !contextIndex.records.length) return reply({ hits: [] });
      const qv = (await mm.embedMany([q]))[0];
      const hits = contextIndex.search(qv, { topK: Math.min(Number(msg.topK) || 8, 50), sourceIds: msg.sourceIds || null });
      return reply({ hits: hits.map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: h.text })) });
    }

    case "train.adapters": return reply({ adapters: trainer.listAdapters() });
    case "train.start": {
      if (trainer.isRunning()) return fail("a run is already active");
      if (retrainBusy) return fail("a background retrain is starting - try again in a moment"); // avoid racing doRetrain for the worker lock before it flips isRunning()
      if (syncBusy) return fail("a background sync is running - try again in a moment"); // training bypasses the worker mutex; don't collide with an in-flight re-index
      const paths = (msg.paths && msg.paths.length) ? msg.paths
        : (lastSelection ? lastSelection.filter((s) => s.selected).map((s) => s.path) : []);
      if (!paths.length) return fail("no documents selected to train on (run auto-select first)");
      const outDir = path.join(RECIPE_ROOT, "data", "vault-build");
      const ds = buildCausalDataset(vault, paths, outDir);
      push({ type: "train.dataset", ...ds, docs: paths.length });
      if (ds.trainChars < 500) return fail("selected docs produced too little text to train on");
      // finetune.js runs in its own child process with its OWN SDK worker. The SDK takes
      // a global lock on ~/.qvac, so the server must release its embedder/LLM worker first
      // or the two contend ("Another worker is still running"). Reloads lazily after.
      await mm.unloadAll();
      const info = trainer.start(
        { baseKey: msg.baseKey || "1.7b", mode: "causal", dataset: "vault", trainPath: ds.trainPath, evalPath: ds.evalPath, ctx: msg.ctx || 256, epochs: msg.epochs || 1 },
        (ev) => push({ ...ev, type: "train." + ev.type }), // type AFTER spread, else ev.type overwrites it
      );
      return reply({ started: true, ...info, dataset: ds });
    }
    case "train.stop": { trainer.stop(); return reply({ stopped: true }); }

    case "agent.chat": {
      // Agentic chat: the model uses vault tools to find/read (and, with edit permission, write)
      // notes when you talk to it. Permission: "read" (default) or "edit".
      const { message, history = [], baseKey = "1.7b", permission = "read" } = msg;
      const tools = [
        { name: "search_vault", description: "Search the owner's notes by keywords. Returns the most relevant note paths with snippets.", parameters: z.object({ query: z.string().describe("keywords to search for") }) },
        { name: "read_note", description: "Read the full text of one note, by its vault-relative path.", parameters: z.object({ path: z.string().describe("e.g. projects/foo.md") }) },
        { name: "list_notes", description: "List the paths of all notes in the vault.", parameters: z.object({}) },
      ];
      if (permission === "edit") tools.push({ name: "write_note", description: "Create or overwrite a note (only when the user asks you to write or edit). path is vault-relative.", parameters: z.object({ path: z.string(), content: z.string() }) });
      const actions = [];
      const executeTool = async (call) => {
        const a = call.arguments || {};
        if (call.name === "search_vault") { const r = vault.search(a.query || "", 6); actions.push({ tool: "search", arg: a.query }); return r.length ? r.map((x) => `- ${x.path}: ${x.snippet}`).join("\n") : "no matching notes"; }
        if (call.name === "read_note") { actions.push({ tool: "read", arg: a.path }); try { return vault.read(a.path).slice(0, 4000); } catch { return "could not read " + a.path; } }
        if (call.name === "list_notes") { actions.push({ tool: "list" }); return vault.list().map((f) => f.path).slice(0, 200).join("\n"); }
        if (call.name === "write_note") {
          if (permission !== "edit") return "permission denied: the vault is read-only for the agent";
          try {
            // never silently clobber: back up the prior version (if any) before overwriting, and tell
            // the user whether this CREATED or OVERWROTE a note so an agent edit is always recoverable.
            let prior = null; try { prior = vault.read(a.path); } catch { prior = null; }
            const backup = prior != null ? backupNote(a.path, prior) : null;
            vault.write(a.path, a.content || "");
            invalidateCaches();
            actions.push({ tool: prior != null ? "edit" : "create", arg: a.path });
            push({ type: "agent.edited", path: a.path, created: prior == null, backup });
            return `${prior != null ? "overwrote" : "created"} ${a.path}${backup ? " (previous version backed up)" : ""}`;
          }
          catch (e) { return "could not write " + a.path + ": " + e.message; }
        }
        return "unknown tool";
      };
      const sys = identityPrompt()
        + ` Agent mode is ON: you have LIVE access to the owner's note vault through tools. Use search_vault / read_note / list_notes to FIND and READ their actual notes before answering, and cite the note paths you used. Do not claim you lack access - you have it. `
        + (permission === "edit" ? "You may also create or edit notes with write_note when the owner asks." : "You can read notes but you may NOT edit them (the vault is read-only this session).");
      const hist = [{ role: "system", content: sys }, ...history, { role: "user", content: message }];
      push({ type: "chat.start" });
      const { contentText } = await mm.agentChat(hist, { baseKey, tools, executeTool,
        onToken: (t) => push({ type: "chat.token", text: t }),
        onTool: (c) => push({ type: "agent.tool", name: c.name, args: c.arguments }) });
      return reply({ contentText, actions, model: { baseKey, agent: true, permission } });
    }
    case "chat.send": {
      const { message, history = [], adapter = null, memory = false, voice = false } = msg;
      let baseKey = BASES[msg.baseKey] ? msg.baseKey : "1.7b";
      let lora = null;
      if (voice && adapter) {
        const found = trainer.listAdapters().find((a) => a.file === adapter || a.abs === adapter);
        if (found) {
          lora = found.abs;
          // A LoRA only fits the base it was trained on; applying it to a different base makes the
          // llama.cpp worker SIGSEGV. Force the adapter's base so a mismatched pick can't crash it.
          if (found.baseKey && found.baseKey !== baseKey) {
            push({ type: "chat.warn", message: `Your voice was trained on ${found.baseKey}; running on that model (not ${baseKey}).` });
            baseKey = found.baseKey;
          }
        }
      }
      let hits = [];
      let grounding = "";
      if (memory) {
        try {
          if (contextIndex.records.length) {
            const qv = (await mm.embedMany([message]))[0];
            // numbered sources go to the model; the SAME records go back to the UI as citation chips,
            // so citations come from the retrieval layer (reliable), never from the model's text.
            hits = contextIndex.search(qv, { topK: 6 }).map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: h.text }));
            if (hits.length) grounding = "Relevant excerpts from the owner's sources (cite by [n]):\n" + hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.content}`).join("\n") + "\n\n";
          }
          if (!hits.length) push({ type: "chat.warn", message: "no indexed context yet - index a source for memory" });
        } catch (e) { push({ type: "chat.warn", message: "retrieval failed: " + e.message }); }
      }
      // identity + environment + capability-awareness, then mode-specific guidance.
      let sys = identityPrompt() + " ";
      sys += voice ? "You have been fine-tuned on the owner's own writing - reply in their voice (same tone, length, phrasing). " : "";
      if (memory && grounding) {
        sys += "Memory is ON: below are real excerpts retrieved from the owner's indexed notes and data. Answer using these excerpts and cite them by their [n]; if they don't cover the question, say so.\n\n" + grounding;
      } else if (memory) {
        sys += "Memory is ON but nothing relevant was found in the owner's index for this question (their index may be empty or unrelated). Say what you can, and suggest they index more sources under Settings > Memory.";
      } else {
        sys += "Right now Memory and Agent mode are OFF, so you cannot see the owner's personal notes, calendar, mail, contacts, browser history, or messages. If they ask about their own data, explain that you CAN access it once they turn on Memory (to recall indexed facts) or Agent mode (to actively search and read their vault) from the controls in this Chat tab.";
      }
      const fullHistory = [{ role: "system", content: sys }, ...history, { role: "user", content: message }];
      push({ type: "chat.start", hits });
      const { contentText, stats } = await mm.chat(fullHistory, {
        baseKey, lora, reasoningBudget: 0,
        onToken: (t) => push({ type: "chat.token", text: t }),
      });
      return reply({ contentText, hits, stats, model: { baseKey, voice: !!lora, memory } });
    }

    default: return fail(`unknown type: ${type}`);
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Second Self app on http://localhost:${PORT}`);
  console.log(`default vault: ${vault.root}`);
  startVaultWatch();
  scheduleAutoRetrain();
  scheduleAutoSync();
});

async function shutdown() { try { await masterServer.stop(); } catch { /* */ } try { await masterClient?.disconnect(); } catch { /* */ } await mm.unloadAll(); trainer.stop(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
