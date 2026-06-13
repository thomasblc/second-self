// End-to-end test for Second Self. Spawns the real server against a fresh temp vault
// on a test port, drives every flow over the WebSocket protocol, and asserts.
//
//   node app/test-e2e.mjs            # core flows (no model download, fast)
//   node app/test-e2e.mjs --models   # + embeddings, highlight, select, RAG, chat (downloads models once)
//   node app/test-e2e.mjs --train    # + a tiny 600M LoRA run (slow, minutes)
//
// Exit code 0 = all passed. Self-contained: creates and removes its own vault.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const RECIPE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3099;
const WITH_MODELS = process.argv.includes("--models") || process.argv.includes("--train");
const WITH_TRAIN = process.argv.includes("--train");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + msg); } else { fail++; console.log("  \x1b[31mFAIL\x1b[0m " + msg); } };
const section = (s) => console.log("\n\x1b[1m" + s + "\x1b[0m");

// ---- build a temp vault ----
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "ss-e2e-"));
fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
const longProse = (topic) => `# ${topic}\n\n` + `This note is about ${topic}. `.repeat(40);
fs.writeFileSync(path.join(vault, "index.md"), "# Index\n\nSee [[alpha]] and [[beta]] for the details.");
fs.writeFileSync(path.join(vault, "alpha.md"), longProse("alpha cooking recipes and food"));
fs.writeFileSync(path.join(vault, "beta.md"), longProse("beta machine learning and neural networks"));
fs.writeFileSync(path.join(vault, "sub", "gamma.md"), longProse("gamma travel and mountains"));

// ---- spawn server ----
const server = spawn("node", ["app/server.js"], {
  cwd: RECIPE_ROOT,
  env: { ...process.env, PORT: String(PORT), SECOND_SELF_VAULT: vault },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function waitHttp(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const req = http.get(`http://localhost:${PORT}/`, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => { if (Date.now() - t0 > timeoutMs) reject(new Error("server never came up\n" + serverLog)); else setTimeout(tick, 200); });
    };
    tick();
  });
}

// ---- WS client ----
let ws, seq = 0; const pendingMap = new Map(); const frames = [];
const req = (type, p = {}) => new Promise((res, rej) => {
  const id = "r" + (++seq); pendingMap.set(id, { res, rej });
  ws.send(JSON.stringify({ id, type, ...p }));
  setTimeout(() => { if (pendingMap.has(id)) { pendingMap.delete(id); rej(new Error("timeout " + type)); } }, WITH_TRAIN ? 900000 : 120000);
});
function connect() {
  return new Promise((resolve) => {
    ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.ok !== undefined && pendingMap.has(m.id)) { const { res, rej } = pendingMap.get(m.id); pendingMap.delete(m.id); m.ok ? res(m.data) : rej(new Error(m.error)); }
      else if (m.type) frames.push(m);
    });
    ws.addEventListener("open", () => resolve());
  });
}

async function main() {
  const status = await waitHttp();
  ok(status === 200, `HTTP / returns 200 (got ${status})`);
  // static asset + DoS guard
  await new Promise((r) => http.get(`http://localhost:${PORT}/app.js`, (res) => { ok(res.statusCode === 200, "static /app.js 200"); res.resume(); r(); }));
  await new Promise((r) => http.get(`http://localhost:${PORT}/%E0%A4%A`, (res) => { ok(res.statusCode === 400, "malformed URL -> 400 (no crash)"); res.resume(); r(); }));

  await connect();

  section("VAULT CRUD + search");
  const list = await req("vault.list");
  ok(list.files.length === 4, `lists 4 notes (got ${list.files.length})`);
  ok(list.files.some((f) => f.path === "sub/gamma.md"), "finds nested note");
  const rd = await req("vault.read", { path: "index.md" });
  ok(rd.content.includes("[[alpha]]"), "reads note content");
  await req("vault.create", { path: "new/created.md", content: "# Created\n\nhello there friend" });
  ok((await req("vault.list")).files.some((f) => f.path === "new/created.md"), "creates a note in a new folder");
  await req("vault.write", { path: "new/created.md", content: "# Created\n\nedited content now" });
  ok((await req("vault.read", { path: "new/created.md" })).content.includes("edited"), "writes/updates a note");
  const search = await req("vault.search", { query: "neural networks" });
  ok(search.results[0] && search.results[0].path === "beta.md", "search ranks the right note first");
  await req("vault.rename", { from: "new/created.md", to: "new/renamed.md" });
  ok((await req("vault.list")).files.some((f) => f.path === "new/renamed.md"), "renames a note");
  await req("vault.delete", { path: "new/renamed.md" });
  ok(!(await req("vault.list")).files.some((f) => f.path === "new/renamed.md"), "deletes a note");

  section("SECURITY");
  let threw = false; try { await req("vault.read", { path: "../../../etc/passwd" }); } catch { threw = true; }
  ok(threw, "path traversal is rejected");
  threw = false; try { await req("chat.send", { message: "x", baseKey: "99b" }); } catch { threw = true; }
  ok(threw, "unknown base is rejected");

  section("GRAPH");
  const g = await req("graph.build");
  ok(g.nodes.length === 4, `graph has 4 nodes (got ${g.nodes.length})`);
  ok(g.edges.some((e) => e.kind === "link" && [e.source, e.target].includes("index.md")), "wikilink edge index->alpha/beta built");

  section("CLOUD IMPORT");
  const expFile = path.join(vault, "chatgpt-export.json");
  fs.writeFileSync(expFile, JSON.stringify([{ title: "E2E chat", create_time: 1750000000, mapping: { a: { message: { author: { role: "user" }, content: { parts: ["hi"] }, create_time: 1 } }, b: { message: { author: { role: "assistant" }, content: { parts: ["hello there"] }, create_time: 2 } } } }]));
  const imp = await req("import.cloud", { path: expFile });
  ok(imp.written >= 1 && imp.source === "chatgpt", `cloud import wrote ${imp.written} chatgpt note(s)`);
  ok((await req("vault.list")).files.some((f) => f.path.includes("imported/chatgpt")), "imported conversation appears in the vault");

  if (WITH_MODELS) {
    section("MODELS: embed / highlight / select / rag / chat");
    const ge = await req("graph.embed");
    ok((ge.stats.embedEdges || 0) > 0, `semantic edges added (${ge.stats.embedEdges})`);
    const hl = await req("graph.highlight", { query: "cooking food recipes" });
    ok(hl.matches.some((m) => m.path === "alpha.md"), "NL highlight surfaces the cooking note");
    const sel = await req("select.auto");
    ok(sel.selection.length >= 3 && sel.selected >= 1, `auto-select returns ranked docs (${sel.selected}/${sel.selection.length})`);
    const ing = await req("rag.ingest", { paths: ["alpha.md", "beta.md", "sub/gamma.md"] });
    ok(ing.ingested === 3 && ing.chunks >= 3, `rag ingest ${ing.ingested} docs / ${ing.chunks} chunks`);
    const cbase = await req("chat.send", { message: "Reply with the single word: ping.", baseKey: "1.7b", voice: false, memory: false });
    ok(cbase.contentText && cbase.contentText.length > 0, "chat (base) returns a non-empty answer");
    const cmem = await req("chat.send", { message: "What is beta about?", baseKey: "1.7b", voice: false, memory: true });
    ok(cmem.hits && cmem.hits.length > 0, `chat (memory) retrieves hits (${cmem.hits?.length})`);

    const cat = await req("model.catalog");
    ok(cat.models.length >= 8, `model catalog returns the curated set (${cat.models.length})`);
    ok(cat.models.some((m) => m.name === "QWEN3_4B_INST_Q4_K_M" && m.fineTunable), "catalog marks Qwen3 4B fine-tunable");
    ok(cat.models.some((m) => m.hf && m.hf.startsWith("https://huggingface.co/")), "catalog exposes Hugging Face links");
    ok(cat.models.some((m) => m.group === "embedding"), "catalog includes an embedding model");
    // download an already-cached model -> exercises the op without a big fetch
    const dl = await req("model.download", { name: "EMBEDDINGGEMMA_300M_Q4_0" });
    ok(dl.cached, "model.download completes (embedder, cached)");
  }

  if (WITH_TRAIN) {
    section("TRAIN (600M tiny)");
    frames.length = 0;
    await req("select.auto").catch(() => {});
    const started = await req("train.start", { baseKey: "600m", paths: ["alpha.md", "beta.md", "sub/gamma.md"], epochs: 1, ctx: 256 });
    ok(started.started, "training started");
    const done = await new Promise((resolve) => { const iv = setInterval(() => { const d = frames.find((f) => f.type === "train.done"); if (d) { clearInterval(iv); resolve(d); } }, 1000); });
    ok(done.ok && done.adapter, `training produced a versioned adapter (${done.adapter})`);
    const ad = await req("train.adapters");
    ok(ad.adapters.length >= 1, "adapter listed for the chat Voice toggle");
  }

  section("CREATE VAULT (runs last; switches the root)");
  const newVault = path.join(os.tmpdir(), "ss-e2e-newvault-" + Math.random().toString(36).slice(2, 8));
  const cv = await req("vault.createVault", { path: newVault });
  ok(cv.root === newVault, "createVault switched to the new folder");
  ok((await req("vault.list")).files.some((f) => f.path === "Welcome.md"), "new vault has a starter Welcome note");
  try { fs.rmSync(newVault, { recursive: true, force: true }); } catch { /* */ }

  ws.close();
}

main()
  .catch((e) => { console.error("\n\x1b[31mERROR\x1b[0m", e.message); fail++; })
  .finally(() => {
    server.kill("SIGKILL");
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch { /* */ }
    console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m` + (WITH_MODELS ? " (with models)" : " (core only)"));
    process.exit(fail ? 1 : 0);
  });
