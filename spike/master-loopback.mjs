// Loopback test for the Path-2 master tunnel: two server processes with DIFFERENT vaults.
// After the satellite connects to the master, the satellite's vault ops must return the
// MASTER's data (proving the proxy forwards the whole app protocol over hyperdht).
// Uses the public DHT bootstrap, so it needs internet. SDK-free (vault ops only).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

function mkVault(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ss-" + tag + "-"));
  fs.writeFileSync(path.join(d, `${tag.toUpperCase()}-ONLY.md`), `# ${tag} only\n\nThis note exists only in the ${tag} vault.`);
  return d;
}
function startServer(port, vault, token, cfg) {
  const p = spawn("node", ["app/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), SECOND_SELF_VAULT: vault, SECOND_SELF_TOKEN: token, SECOND_SELF_CONFIG_DIR: cfg }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  p._log = () => log;
  return p;
}
function wsClient(port, token) {
  const ws = new WebSocket(`ws://localhost:${port}/?t=${token}`);
  let seq = 0; const pend = new Map();
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.ok !== undefined && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.ok ? res(m.data) : rej(new Error(m.error)); } });
  const req = (type, p = {}) => new Promise((res, rej) => { const id = "r" + (++seq); pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, type, ...p })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + type)); } }, 30000); });
  const open = new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  return { ws, req, open };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const masterVault = mkVault("master"), satVault = mkVault("satellite");
const mCfg = fs.mkdtempSync(path.join(os.tmpdir(), "ss-mc-")), sCfg = fs.mkdtempSync(path.join(os.tmpdir(), "ss-sc-"));
const master = startServer(3091, masterVault, "mtok", mCfg);
const sat = startServer(3092, satVault, "stok", sCfg);

try {
  await wait(2500);
  const M = wsClient(3091, "mtok"); await M.open;
  const S = wsClient(3092, "stok"); await S.open;

  // sanity: each server sees its OWN vault before pairing
  ok((await M.req("vault.list")).files.some((f) => f.path === "MASTER-ONLY.md"), "master serves its own vault pre-pair");
  ok((await S.req("vault.list")).files.some((f) => f.path === "SATELLITE-ONLY.md"), "satellite serves its own vault pre-pair");

  // master goes online, satellite connects
  const { publicKey } = await M.req("master.start");
  ok(/^[0-9a-f]{64}$/.test(publicKey), "master.start returns a 64-hex pairing code");
  console.log("  .. connecting satellite to master over the DHT (needs internet) ..");
  await S.req("master.connect", { publicKey });

  // THE test: the satellite now sees the MASTER's vault, not its own
  const sl = await S.req("vault.list");
  ok(sl.files.some((f) => f.path === "MASTER-ONLY.md"), "after pairing, satellite.vault.list returns the MASTER's note");
  ok(!sl.files.some((f) => f.path === "SATELLITE-ONLY.md"), "satellite no longer shows its own local note (proxying to master)");
  const rd = await S.req("vault.read", { path: "MASTER-ONLY.md" });
  ok(rd.content.includes("master only"), "satellite reads the master's note content through the tunnel");
  const info = await S.req("vault.info");
  ok(path.basename(info.root) === path.basename(masterVault), "satellite vault.info reflects the master's vault root");

  // SECURITY: a non-allow-listed op forwarded to the master must be DENIED
  let denied = false; try { await S.req("model.delete", { name: "QWEN3_600M_INST_Q4" }); } catch (e) { denied = /not allowed over the master link/.test(e.message); }
  ok(denied, "a non-allow-listed op (model.delete) is rejected over the tunnel");

  // disconnect -> satellite back to its own vault
  await S.req("master.disconnect");
  ok((await S.req("vault.list")).files.some((f) => f.path === "SATELLITE-ONLY.md"), "after disconnect, satellite serves its own vault again");

  M.ws.close(); S.ws.close();
} catch (e) {
  console.log("  ERROR", e.message);
  console.log("  master log tail:", master._log().split("\n").slice(-4).join(" | "));
  console.log("  satellite log tail:", sat._log().split("\n").slice(-4).join(" | "));
  fail++;
} finally {
  master.kill("SIGKILL"); sat.kill("SIGKILL");
  for (const d of [masterVault, satVault, mCfg, sCfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
