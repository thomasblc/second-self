// Curated catalog of QVAC-SDK models Second Self can actually use: text LLM bases
// (chat + fine-tuning) and embedding models. Multimodal/vision/OCR and the very large
// (120B) constants are intentionally excluded to keep downloads reliable and the UI focused.
// Size, source, and Hugging Face link are read straight from the SDK constant so they stay accurate.
import * as sdk from "@qvac/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODELS_DIR = path.join(os.homedir(), ".qvac", "models");

// group: "voice" (fine-tunable base), "chat" (completion, not wired for training), "embedding".
const CURATED = [
  { name: "QWEN3_600M_INST_Q4", group: "voice", fineTunable: true, label: "Qwen3 0.6B", note: "Fastest to train. Weak in long-form; great for a first demo." },
  { name: "QWEN3_1_7B_INST_Q4", group: "voice", fineTunable: true, label: "Qwen3 1.7B", note: "Proven sweet spot, and the mobile target. ~2h to train." },
  { name: "QWEN3_8B_INST_Q4_K_M", group: "chat", fineTunable: false, label: "Qwen3 8B", note: "Largest Qwen3. Chat only (Q4_K_M cannot be fine-tuned)." },
  { name: "QWEN3_4B_INST_Q4_K_M", group: "chat", fineTunable: false, label: "Qwen3 4B", note: "Chat only (Q4_K_M cannot be fine-tuned in this SDK)." },
  { name: "LLAMA_3_2_1B_INST_Q4_0", group: "chat", fineTunable: false, label: "Llama 3.2 1B", note: "Meta's compact instruct model. Q4_0, also fine-tunable." },
  { name: "SALAMANDRATA_2B_INST_Q4", group: "chat", fineTunable: false, label: "SalamandraTA 2B", note: "Multilingual / translation focused." },
  { name: "GPT_OSS_20B_INST_Q4_K_M", group: "chat", fineTunable: false, label: "GPT-OSS 20B", note: "Largest text model. Needs ~12 GB free RAM to run." },
  { name: "EMBEDDINGGEMMA_300M_Q4_0", group: "embedding", fineTunable: false, label: "EmbeddingGemma 300M", note: "Default. Powers the knowledge graph + memory retrieval." },
];

function hfUrl(m) {
  if (m.registrySource !== "hf") return null;
  const repo = m.registryPath.split(/\/(?:resolve|blob)\//)[0]; // "org/repo/resolve/sha/file" -> "org/repo"
  return "https://huggingface.co/" + repo;
}

function cachedFiles() {
  try { return fs.readdirSync(MODELS_DIR); } catch { return []; }
}

export function isCached(m) {
  return cachedFiles().some((f) => f.endsWith(m.modelId));
}

export function buildCatalog() {
  const files = cachedFiles();
  return CURATED.map((c) => {
    const m = sdk[c.name];
    if (!m) return null;
    return {
      name: c.name, label: c.label, group: c.group, fineTunable: c.fineTunable, note: c.note,
      params: m.params, quant: m.quantization,
      sizeBytes: m.expectedSize, sizeGB: +(m.expectedSize / 2 ** 30).toFixed(2),
      engine: m.engine, source: m.registrySource, hf: hfUrl(m), modelId: m.modelId,
      cached: files.some((f) => f.endsWith(m.modelId)),
    };
  }).filter(Boolean);
}

export function constantFor(name) {
  const m = sdk[name];
  if (!m || !CURATED.some((c) => c.name === name)) return null; // only allow catalog models
  return m;
}

export function modelTypeFor(m) {
  return m.engine === "llamacpp-embedding" ? "llamacpp-embedding" : "llm";
}

// Remove a cached model's blob from ~/.qvac/models (frees disk). Returns how many files removed.
export function deleteCached(m) {
  let removed = 0;
  for (const f of cachedFiles()) {
    if (f.endsWith(m.modelId)) { try { fs.unlinkSync(path.join(MODELS_DIR, f)); removed++; } catch { /* */ } }
  }
  return removed;
}
