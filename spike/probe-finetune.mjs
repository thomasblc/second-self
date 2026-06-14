// Probe which RELEVANT (general-purpose, non-medical, non-vision) bases actually fine-tune.
// The finetuner rejects Q4_K_M (file_type=15), and some "Q4_0"-named builds are mislabeled
// (the Qwen3-4B "Q4_0 shard" was really Q4_K_M). So we don't trust the label: we load each
// candidate and start a real finetune, then report PASS (first training step emitted) or
// FAIL (quant/other error). Kills each after the verdict. No full training here.
import { loadModel, finetune, unloadModel, LLAMA_3_2_1B_INST_Q4_0, SALAMANDRATA_2B_INST_Q4 } from "@qvac/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRAIN = path.join(ROOT, "data", "whatsapp.train.jsonl");
const EVAL = path.join(ROOT, "data", "whatsapp.eval.jsonl");
const candidates = [
  ["Llama-3.2-1B (q4_0)", LLAMA_3_2_1B_INST_Q4_0],
  ["SalamandraTA-2B (q4)", SALAMANDRATA_2B_INST_Q4],
];

for (const [name, src] of candidates) {
  let modelId;
  try {
    console.log(`\n=== probing ${name} ===`);
    modelId = await loadModel({ modelSrc: src, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 256 } });
    const handle = finetune({
      modelId,
      options: {
        trainDatasetDir: TRAIN,
        validation: { type: "dataset", path: EVAL },
        numberOfEpochs: 1, contextLength: 256, learningRate: 2e-5, lrMin: 1e-8,
        loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
        assistantLossOnly: true, checkpointSaveSteps: 100000,
        checkpointSaveDir: path.join(ROOT, "train", "probe-ckpt"),
        outputParametersDir: path.join(ROOT, "train", "probe-out"),
      },
    });
    // resolve on the FIRST real training step; reject if finetune fails (quant gate) first.
    const verdict = await Promise.race([
      (async () => { for await (const t of handle.progressStream) { if (t.is_train && Number.isFinite(t.loss)) return `PASS (fine-tunable; step ${t.global_steps} loss ${t.loss.toFixed(3)})`; } return "PASS (stream ended, no error)"; })(),
      handle.result.then((r) => `END status=${r.status}`).catch((e) => `FAIL: ${String(e?.message || e).slice(0, 120)}`),
    ]);
    console.log(`  ${name}: ${verdict}`);
    try { finetune({ modelId, operation: "pause" }).catch(() => {}); } catch { /* */ }
  } catch (e) {
    console.log(`  ${name}: FAIL (load/finetune threw): ${String(e?.message || e).slice(0, 140)}`);
  } finally {
    if (modelId) { try { await unloadModel({ modelId, clearStorage: false }); } catch { /* */ } }
  }
}
console.log("\nprobe done");
process.exit(0);
