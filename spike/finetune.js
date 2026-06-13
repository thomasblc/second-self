// Phase S0 fine-tune runner. Follows the shipped SDK example verbatim
// (node_modules/@qvac/sdk/dist/examples/finetune/llamacpp-finetune.js), plus:
// a hardware guard (never train blind, recipe hard rule 2), a peak-RAM sampler over
// this process tree (the SDK worker is a child process), wall-clock timing, and the
// exact adapter filename + size from outputParametersDir (hard rule 8).
// Usage: node spike/finetune.js [--data bootstrap|whatsapp] [--epochs 2]
import { finetune, loadModel, unloadModel, QWEN3_600M_INST_Q4, QWEN3_1_7B_INST_Q4, QWEN3_4B_INST_Q4_K_M, QWEN3_8B_INST_Q4_K_M } from "@qvac/sdk";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const dataset = arg("--data", "bootstrap");
const epochs = Number(arg("--epochs", "2"));
// The trainer SKIPS any sample longer than contextLength (default 128!): pass it explicitly
// or a real chat dataset silently shrinks to a handful of rows (1335 -> 13 observed).
const ctxLen = Number(arg("--ctx", "512"));
// batchSize / microBatchSize are in TOKENS (native default 128 = the chunking unit seen in
// total_batches). Passing batchSize 1 means 1-TOKEN steps (a 1h run became 51h). Setting
// them also seems to force padding to contextLength. Leave them to the native defaults
// unless explicitly overridden; measured on Metal: defaults are the fastest configuration.
const batchArg = arg("--batch", null);
const microArg = arg("--micro", null);
// 1e-4 (the SDK example value) made the loss climb then diverge to NaN on real chat data;
// 5e-5 is the safer default for this dataset size
const lr = Number(arg("--lr", "5e-5"));
const baseKey = arg("--base", "600m"); // 600m | 1.7b | 4b | 8b (a LoRA only runs on the base it was trained on)
const BASES = { "600m": QWEN3_600M_INST_Q4, "1.7b": QWEN3_1_7B_INST_Q4, "4b": QWEN3_4B_INST_Q4_K_M, "8b": QWEN3_8B_INST_Q4_K_M };
const BASE = BASES[baseKey];
if (!BASE) { console.error(`ABORT: unknown --base ${baseKey} (600m | 1.7b | 4b | 8b)`); process.exit(1); }
// SFT (chat, loss on assistant turns, JSONL) vs Causal (raw long-form text, .txt). Vault notes = causal.
const mode = arg("--mode", "sft"); // sft | causal
const ext = mode === "causal" ? "txt" : "jsonl";
// --train / --eval allow an absolute dataset path (the app builds vault datasets outside data/).
const trainPath = arg("--train", path.join(ROOT, "data", `${dataset}.train.${ext}`));
const evalPath = arg("--eval", path.join(ROOT, "data", `${dataset}.eval.${ext}`));

// ---- hardware guard: never train blind ----
const ramGB = os.totalmem() / 2 ** 30;
const disk = fs.statfsSync(ROOT);
const diskFreeGB = (disk.bavail * disk.bsize) / 2 ** 30;
console.log(`hw check: ${os.platform()}-${os.arch()}, ram ${ramGB.toFixed(0)} GB, disk free ${diskFreeGB.toFixed(0)} GB`);
if (ramGB < 16) { console.error("ABORT: under 16 GB RAM, below the training profile. Not training."); process.exit(1); }
if (diskFreeGB < 5) { console.error("ABORT: under 5 GB free disk. Not training."); process.exit(1); }
if (!fs.existsSync(trainPath)) { console.error(`ABORT: ${trainPath} not found. Run: node spike/make-bootstrap.js`); process.exit(1); }
const nTrain = fs.readFileSync(trainPath, "utf8").trim().split("\n").length;
const nEval = fs.existsSync(evalPath) ? fs.readFileSync(evalPath, "utf8").trim().split("\n").length : 0;
console.log(`dataset: ${dataset} (${nTrain} train rows, ${nEval} eval rows), base: ${baseKey}, mode: ${mode}, epochs: ${epochs}`);

// ---- peak-RSS sampler over this process tree (the SDK worker is a child) ----
let peakRssMB = 0;
function sampleTreeRss() {
  try {
    const out = execSync("ps -axo pid=,ppid=,rss=", { encoding: "utf8" });
    const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); // ppid -> [pid]
    const rss = new Map();
    for (const [pid, ppid, r] of rows) { rss.set(pid, r); (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid); }
    let total = 0;
    const stack = [process.pid];
    while (stack.length) { const p = stack.pop(); total += rss.get(p) || 0; for (const c of kids.get(p) || []) stack.push(c); }
    const mb = total / 1024;
    if (mb > peakRssMB) peakRssMB = mb;
  } catch { /* sampling is best effort */ }
}
const sampler = setInterval(sampleTreeRss, 2000);

let modelId;
let exitCode = 0;
const t0 = Date.now();
let lastLoss = null, lastValLoss = null, totalSteps = 0;
try {
  console.log(`loading base ${BASE.name || baseKey} (first run downloads it to ~/.qvac/models)...`);
  modelId = await loadModel({
    modelSrc: BASE,
    modelType: "llm",
    modelConfig: { device: "gpu", ctx_size: ctxLen },
  });
  const tLoaded = Date.now();
  console.log(`model loaded in ${((tLoaded - t0) / 1000).toFixed(1)}s, id ${modelId}`);

  // per base+dataset output dir: the SDK writes a FIXED filename (trained-lora-adapter.gguf),
  // successive runs would silently overwrite each other otherwise
  const outputDir = path.join(ROOT, "train", `results-${dataset}-${baseKey}`);
  const handle = finetune({
    modelId,
    options: {
      trainDatasetDir: trainPath,
      validation: nEval ? { type: "dataset", path: evalPath } : { type: "split", fraction: 0.1 },
      numberOfEpochs: epochs,
      contextLength: ctxLen,
      ...(batchArg ? { batchSize: Number(batchArg) } : {}),
      ...(microArg ? { microBatchSize: Number(microArg) } : {}),
      learningRate: lr,
      lrMin: 1e-8,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      assistantLossOnly: mode === "sft", // SFT: loss only on the owner's turns. Causal: whole text.
      // On the 1.7B base the run HANGS right after an intermediate checkpoint save (~step 300,
      // a worker locks up). For a single-epoch run we only need the final adapter, so default to
      // saving rarely (effectively only the final). Override with --ckpt for resumable runs.
      checkpointSaveSteps: Number(arg("--ckpt", "100000")),
      checkpointSaveDir: path.join(ROOT, "train", `checkpoints-${dataset}-${baseKey}`),
      outputParametersDir: outputDir,
    },
  });

  // NaN guard: when training diverges the ticks stop carrying a numeric loss entirely
  // (observed: loss climbs, then every tick has loss undefined, final stats are NaN and
  // the run dies at the end after burning the full wall-clock). Fail fast instead.
  let noLossStreak = 0, aborted = false;
  for await (const t of handle.progressStream) {
    const phase = t.is_train ? "train" : "val";
    if (t.is_train) {
      totalSteps = t.global_steps ?? totalSteps;
      if (Number.isFinite(t.loss)) { lastLoss = t.loss; noLossStreak = 0; }
      else if (++noLossStreak === 120 && !aborted) {
        aborted = true;
        console.error("ABORT: 120 consecutive ticks without a numeric loss (diverged to NaN). Pausing the run.");
        finetune({ modelId, operation: "pause" }).catch(() => {});
      }
    } else if (Number.isFinite(t.loss)) lastValLoss = t.loss;
    console.log(`epoch ${t.current_epoch + 1} step ${t.global_steps} batch ${t.current_batch}/${t.total_batches} ${phase} loss ${t.loss?.toFixed(4)} eta ${Math.round((t.eta_ms || 0) / 1000)}s`);
  }
  const result = await handle.result.catch((e) => ({ status: "FAILED", error: String(e?.message || e).slice(0, 200) }));
  if (aborted) result.status = "DIVERGED_NAN";
  const tTrained = Date.now();
  sampleTreeRss();

  console.log("\n==== S0 RESULT ====");
  console.log(`status: ${result.status}`);
  console.log(`train wall-clock: ${((tTrained - tLoaded) / 1000).toFixed(1)}s (total incl. load: ${((tTrained - t0) / 1000).toFixed(1)}s)`);
  console.log(`steps: ${totalSteps}, final train loss: ${lastLoss?.toFixed(4)}, final val loss: ${lastValLoss?.toFixed(4)}`);
  console.log(`peak RSS over process tree: ${peakRssMB.toFixed(0)} MB`);

  // exact adapter filename in outputParametersDir (hard rule 8: confirm, never assume)
  const files = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir, { recursive: true }).map(String).filter((f) => !fs.statSync(path.join(outputDir, f)).isDirectory())
    : [];
  if (!files.length) console.log(`adapter: NONE FOUND in ${outputDir} (inspect train/ manually)`);
  for (const f of files) {
    const st = fs.statSync(path.join(outputDir, f));
    console.log(`adapter file: ${f} (${(st.size / 2 ** 20).toFixed(1)} MB) -> ${path.relative(ROOT, path.join(outputDir, f))}`);
  }
} catch (e) {
  console.error("FAILED:", e);
  exitCode = 1;
} finally {
  clearInterval(sampler);
  if (modelId) await unloadModel({ modelId, clearStorage: false });
}
process.exit(exitCode);
