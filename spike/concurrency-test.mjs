// Verifies the unified worker mutex: fire several model-bound ops CONCURRENTLY and confirm
// they all succeed (the old code would collide on the single ~/.qvac worker -> "Another worker
// is still running"). Run: node spike/concurrency-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { WebSocket } from "ws"; import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3095, TOK = "conc-tok";
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "ss-conc-"));
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "ss-conc-cfg-"));
fs.writeFileSync(path.join(vault, "a.md"), "# Cooking\n\n" + "Pasta with garlic and olive oil is quick. ".repeat(15));
fs.writeFileSync(path.join(vault, "b.md"), "# Travel\n\n" + "Mountains in the Alps are great for hiking trips. ".repeat(15));
fs.writeFileSync(path.join(vault, "c.md"), "# Code\n\n" + "Async functions return promises in JavaScript. ".repeat(15));

const sv = spawn("node", ["app/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), SECOND_SELF_VAULT: vault, SECOND_SELF_TOKEN: TOK, SECOND_SELF_CONFIG_DIR: cfg }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; sv.stdout.on("data", (d) => (log += d)); sv.stderr.on("data", (d) => (log += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

(async () => {
  await wait(2500);
  const ws = new WebSocket(`ws://localhost:${PORT}/?t=${TOK}`); let seq = 0; const pend = new Map();
  ws.on("message", (r) => { const m = JSON.parse(r); if (m.ok !== undefined && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.ok ? res(m.data) : rej(new Error(m.error)); } });
  const req = (t, p = {}) => new Promise((res, rej) => { const id = "r" + (++seq); pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, type: t, ...p })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + t)); } }, 120000); });
  await new Promise((r) => ws.on("open", r));

  await req("rag.ingest"); // give the context index some data first

  // fire 5 model-bound ops AT ONCE - the mutex must serialize them on the one worker
  const results = await Promise.allSettled([
    req("chat.send", { message: "say hi in one word", baseKey: "1.7b", memory: true }),
    req("context.search", { query: "cooking pasta" }),
    req("graph.embed"),
    req("context.search", { query: "hiking mountains" }),
    req("chat.send", { message: "say bye in one word", baseKey: "1.7b", memory: false }),
  ]);
  const rejected = results.filter((r) => r.status === "rejected");
  ok(rejected.length === 0, `5 concurrent model ops all succeeded (${results.filter((r) => r.status === "fulfilled").length}/5)`);
  rejected.forEach((r) => console.log("    rejected:", r.reason.message));
  ok(!/Another worker is still running|worker is busy/i.test(log), "no 'Another worker is still running' in the server log");

  ws.close(); sv.kill("SIGKILL");
  for (const d of [vault, cfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERR", e.message); console.log(log.split("\n").slice(-5).join("\n")); sv.kill("SIGKILL"); process.exit(1); });
