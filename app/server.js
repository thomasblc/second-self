// Second Self - app backend. HTTP static + WebSocket orchestration over the vault,
// the knowledge graph, on-device embeddings/RAG, the LoRA trainer, and chat.
// Everything runs locally. The only network call in the whole app is the first-run
// model download into ~/.qvac/models. Privacy boundary is the product (recipe rule 4).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Vault } from "./lib/vault.js";
import { buildGraph, addEmbedEdges } from "./lib/graph.js";
import { ModelManager, topKPairs, cosine, BASES } from "./lib/models.js";
import { buildRecords, selectByEmbedding, refineWithLLM, buildCausalDataset } from "./lib/select.js";
import { Trainer } from "./lib/train.js";
import { buildCatalog, constantFor, modelTypeFor, deleteCached } from "./lib/catalog.js";
import { hardwareInfo, fit, recommend } from "./lib/hardware.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_ROOT = path.resolve(APP_DIR, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../../..");
const PUBLIC = path.join(APP_DIR, "public");
const PORT = Number(process.env.PORT || 3090);

// Vault: $SECOND_SELF_VAULT if set, else a bundled sample, else this repo's docs/ (dev).
const SAMPLE = path.join(APP_DIR, "sample-vault");
const DEFAULT_VAULT = process.env.SECOND_SELF_VAULT && fs.existsSync(process.env.SECOND_SELF_VAULT)
  ? process.env.SECOND_SELF_VAULT
  : (fs.existsSync(SAMPLE) ? SAMPLE
    : (fs.existsSync(path.join(REPO_ROOT, "docs")) ? path.join(REPO_ROOT, "docs") : RECIPE_ROOT));

const vault = new Vault(DEFAULT_VAULT);
const mm = new ModelManager({ ctxSize: 4096 });
const trainer = new Trainer(RECIPE_ROOT);
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

// ---- static HTTP ----
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]); // can throw URIError on bad %-escapes
    if (p === "/") p = "/index.html";
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    try { res.writeHead(400); res.end("bad request"); } catch { /* */ }
  }
});

// ---- WebSocket protocol: {id, type, ...} request -> {id, ok, data|error} reply;
// streaming handlers also push {type, id, ...} frames before the final reply. ----
// Reject cross-origin browser connections (CSRF / DNS-rebinding): a malicious page the
// operator visits could otherwise drive vault.delete / setRoot / train.start. Browsers
// always send Origin; local CLI tools (our smoke tests) send none and are allowed.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => {
    if (!origin) return true;
    try { const u = new URL(origin); return u.hostname === "localhost" || u.hostname === "127.0.0.1"; }
    catch { return false; }
  },
});
wss.on("connection", (ws) => {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* */ } };
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, type } = msg || {};
    const reply = (data) => send({ id, type, ok: true, data });
    const fail = (e) => send({ id, type, ok: false, error: String(e?.message || e) });
    const push = (frame) => send({ id, ...frame });
    try {
      await handle(type, msg, { reply, fail, push });
    } catch (e) { fail(e); }
  });
  // greet with current state
  send({ type: "hello", data: { vaultRoot: vault.root, model: mm.status(), running: trainer.isRunning(), adapters: trainer.listAdapters() } });
});

// Ops that load an SDK model. While a training child holds the global ~/.qvac lock,
// these would contend with it, so refuse them until the run finishes.
const MODEL_OPS = new Set(["graph.embed", "graph.highlight", "select.auto", "select.refine", "model.warm", "model.download", "rag.ingest", "chat.send"]);

async function handle(type, msg, { reply, fail, push }) {
  if (MODEL_OPS.has(type) && trainer.isRunning()) return fail("training in progress - try again when it finishes");
  if ((type === "train.start" || type === "chat.send" || type === "model.warm") && msg.baseKey && !BASES[msg.baseKey]) {
    return fail(`unknown base ${msg.baseKey}`);
  }
  switch (type) {
    case "vault.info": return reply({ root: vault.root, repoDocs: path.join(REPO_ROOT, "docs"), sample: SAMPLE });
    case "vault.setRoot": { const root = vault.setRoot(msg.path); invalidateCaches(); return reply({ root }); }
    case "vault.list": return reply({ root: vault.root, files: vault.list() });
    case "vault.read": return reply({ path: msg.path, content: vault.read(msg.path) });
    case "vault.write": { const r = vault.write(msg.path, msg.content); invalidateCaches(); return reply(r); }
    case "vault.create": { const r = vault.create(msg.path, msg.content || `# ${path.basename(msg.path).replace(/\.md$/, "")}\n\n`); invalidateCaches(); return reply(r); }
    case "vault.rename": { const r = vault.rename(msg.from, msg.to); invalidateCaches(); return reply(r); }
    case "vault.delete": { const r = vault.remove(msg.path); invalidateCaches(); return reply(r); }
    case "vault.search": return reply({ results: vault.search(msg.query, msg.limit || 50) });

    case "graph.build": { graphCache = buildGraph(vault); return reply(graphCache); }
    case "graph.embed": {
      if (!graphCache) graphCache = buildGraph(vault);
      const { records, vectors } = await ensureDocEmb(push);
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

    case "rag.ingest": {
      const paths = (msg.paths && msg.paths.length) ? msg.paths : vault.list().map((f) => f.path);
      const docs = [];
      for (const rel of paths) { try { docs.push(vault.read(rel)); } catch { /* */ } }
      push({ type: "rag.progress", phase: "ingesting", count: docs.length });
      const r = await mm.ragIngestDocs(docs, "me");
      return reply({ ingested: r.docs, chunks: r.chunks });
    }
    case "rag.forget": { await mm.ragForget("me"); return reply({ ok: true }); }

    case "train.adapters": return reply({ adapters: trainer.listAdapters() });
    case "train.start": {
      if (trainer.isRunning()) return fail("a run is already active");
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

    case "chat.send": {
      const { message, history = [], baseKey = "1.7b", adapter = null, memory = false, voice = false } = msg;
      let lora = null;
      if (voice && adapter) {
        const found = trainer.listAdapters().find((a) => a.file === adapter || a.abs === adapter);
        if (found) { lora = found.abs; }
      }
      let hits = [];
      let grounding = "";
      if (memory) {
        try {
          const res = await mm.ragSearchQuery(message, { workspace: "me", topK: 5 });
          const arr = Array.isArray(res) ? res : (res.documents || res.results || []);
          hits = arr.map((h) => ({ content: h.content, score: h.score }));
          if (hits.length) grounding = "Relevant facts from the owner's notes:\n" + hits.map((h, i) => `[${i + 1}] ${h.content}`).join("\n") + "\n\n";
        } catch (e) { push({ type: "chat.warn", message: "retrieval failed: " + e.message }); }
      }
      const sys = (voice ? "You are the owner's second self: reply in their writing voice." : "You are a helpful assistant.")
        + (grounding ? "\nUse these facts to answer; if they don't cover it, say so.\n\n" + grounding : "");
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
});

process.on("SIGINT", async () => { await mm.unloadAll(); trainer.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await mm.unloadAll(); trainer.stop(); process.exit(0); });
