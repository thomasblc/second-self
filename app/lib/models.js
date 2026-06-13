// SDK model manager for Second Self. One LLM slot (reloaded when the base or the
// LoRA changes, since `lora` is a load-time modelConfig key) and one embedder slot.
// All calls are validated against the installed SDK examples (completion-events.js,
// rag/rag-sqlite.js, embed.d.ts). Do NOT improvise the surface.
import {
  loadModel, unloadModel, completion, embed,
  ragIngest, ragSearch, ragCloseWorkspace, ragDeleteWorkspace,
  QWEN3_1_7B_INST_Q4, QWEN3_4B_INST_Q4_SHARD, QWEN3_8B_INST_Q4_K_M, QWEN3_600M_INST_Q4,
  EMBEDDINGGEMMA_300M_Q4_0,
} from "@qvac/sdk";

// Same keys as spike/finetune.js so a LoRA trained there loads here on the SAME base.
// 4b is the Q4_0 SHARD (the fine-tunable 4B; Q4_K_M cannot be fine-tuned, so a 4B adapter
// must load on the shard). 8b is Q4_K_M = chat-only (no fine-tunable 8B in the SDK).
export const BASES = {
  "600m": QWEN3_600M_INST_Q4,
  "1.7b": QWEN3_1_7B_INST_Q4,
  "4b": QWEN3_4B_INST_Q4_SHARD,
  "8b": QWEN3_8B_INST_Q4_K_M,
};

export class ModelManager {
  constructor({ ctxSize = 4096 } = {}) {
    this.ctxSize = ctxSize;
    this.llm = null;   // { modelId, baseKey, lora }
    this.emb = null;   // { modelId }
    this._llmLock = Promise.resolve();
  }

  status() {
    return {
      llm: this.llm ? { baseKey: this.llm.baseKey, lora: this.llm.lora || null } : null,
      embed: this.emb ? { loaded: true } : null,
    };
  }

  // Run fn(modelId) holding the single-LLM-slot lock for the WHOLE duration, ensuring the
  // requested (base, lora) is loaded first. Holding across the completion (not just the
  // load) is what stops a second chat from reloading/unloading the slot mid-stream.
  async _withLLM({ baseKey = "1.7b", lora = null, reasoningBudget = 0 } = {}, fn = null) {
    const run = this._llmLock.then(async () => {
      if (!(this.llm && this.llm.baseKey === baseKey && (this.llm.lora || null) === (lora || null))) {
        if (this.llm) {
          try { await unloadModel({ modelId: this.llm.modelId, clearStorage: false }); } catch { /* */ }
          this.llm = null;
        }
        const src = BASES[baseKey];
        if (!src) throw new Error(`unknown base ${baseKey}`);
        const modelConfig = { device: "gpu", ctx_size: this.ctxSize, reasoning_budget: reasoningBudget };
        if (lora) modelConfig.lora = lora;
        const modelId = await loadModel({ modelSrc: src, modelType: "llm", modelConfig });
        this.llm = { modelId, baseKey, lora: lora || null };
      }
      return fn ? await fn(this.llm.modelId) : this.llm.modelId;
    });
    this._llmLock = run.then(() => {}, () => {});
    return run;
  }

  async ensureLLM(opts = {}) { return this._withLLM(opts, null); }

  async ensureEmbed() {
    if (this.emb) return this.emb.modelId;
    const modelId = await loadModel({ modelSrc: EMBEDDINGGEMMA_300M_Q4_0, modelType: "llamacpp-embedding" });
    this.emb = { modelId };
    return modelId;
  }

  // Fetch a model's weights into ~/.qvac/models (loadModel downloads, then we unload).
  // onProgress receives the SDK load/download progress ({ percentage }). Loads with a
  // small ctx and no GPU to keep the transient footprint down; it is only being cached.
  async download(modelSrc, modelType, onProgress) {
    const modelConfig = modelType === "llm" ? { ctx_size: 256 } : {};
    const modelId = await loadModel({ modelSrc, modelType, modelConfig, onProgress });
    try { await unloadModel({ modelId, clearStorage: false }); } catch { /* */ }
    return true;
  }

  // Embed many texts; batches to keep each RPC small. Returns number[][] aligned to input.
  async embedMany(texts, { batch = 16, onProgress } = {}) {
    const modelId = await this.ensureEmbed();
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const res = await embed({ modelId, text: slice });
      const vecs = Array.isArray(res.embedding[0]) ? res.embedding : [res.embedding];
      out.push(...vecs);
      if (onProgress) onProgress(Math.min(i + batch, texts.length), texts.length);
    }
    return out;
  }

  // Pre-chunk locally and ingest with chunk:false. The SDK's built-in chunker
  // (chunk:true) routes through an LLM chunk pass that errors with only the embedder
  // loaded ("Document content is required"); the shipped example ingests plain strings
  // with chunk:false, so we match that and own the chunking.
  async ragIngestDocs(documents, workspace = "me", { wordsPerChunk = 120, overlap = 20 } = {}) {
    const modelId = await this.ensureEmbed();
    const chunks = [];
    for (const doc of documents) for (const c of chunkText(doc, wordsPerChunk, overlap)) chunks.push(c);
    const clean = chunks.map((c) => c.trim()).filter((c) => c.length > 0);
    if (!clean.length) return { docs: documents.length, chunks: 0 };
    await ragIngest({ modelId, workspace, documents: clean, chunk: false });
    return { docs: documents.length, chunks: clean.length };
  }

  async ragSearchQuery(query, { workspace = "me", topK = 5 } = {}) {
    const modelId = await this.ensureEmbed();
    return ragSearch({ modelId, workspace, query, topK }); // -> { documents: [{content, score}] } or array
  }

  async ragForget(workspace = "me") {
    try { await ragDeleteWorkspace({ workspace }); } catch { /* */ }
    try { await ragCloseWorkspace({ workspace, deleteOnClose: true }); } catch { /* */ }
  }

  // Stream a completion. onToken(text) for content, onThink(text) for thinking deltas.
  // Returns { contentText, thinkingText, stats }.
  async chat(history, { baseKey = "1.7b", lora = null, onToken, onThink, captureThinking = false, reasoningBudget = 0 } = {}) {
    return this._withLLM({ baseKey, lora, reasoningBudget }, async (modelId) => {
      const run = completion({ modelId, history, stream: true, captureThinking });
      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && onToken) onToken(ev.text);
        else if (ev.type === "thinkingDelta" && onThink) onThink(ev.text);
      }
      const final = await run.final;
      return { contentText: final.contentText, thinkingText: final.thinkingText, stats: final.stats };
    });
  }

  async unloadAll() {
    if (this.llm) { try { await unloadModel({ modelId: this.llm.modelId, clearStorage: false }); } catch { /* */ } this.llm = null; }
    if (this.emb) { try { await unloadModel({ modelId: this.emb.modelId, clearStorage: false }); } catch { /* */ } this.emb = null; }
  }
}

// Split a document into overlapping word-windowed chunks for retrieval.
// Strips YAML front-matter, packs by paragraph up to wordsPerChunk, with a small
// word overlap so a fact split across a boundary is still retrievable.
export function chunkText(doc, wordsPerChunk = 120, overlap = 20) {
  const body = String(doc || "").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!body) return [];
  const words = body.split(/\s+/);
  if (words.length <= wordsPerChunk) return [body];
  const chunks = [];
  const step = Math.max(1, wordsPerChunk - overlap);
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
    if (i + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

// Cosine similarity for the graph's semantic edges.
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Top-K nearest neighbors per item -> dedup pairs for "embed" edges.
export function topKPairs(ids, vectors, k = 4, minScore = 0.55) {
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const sims = [];
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      sims.push([j, cosine(vectors[i], vectors[j])]);
    }
    sims.sort((x, y) => y[1] - x[1]);
    for (const [j, score] of sims.slice(0, k)) {
      if (score < minScore) break;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: ids[i], b: ids[j], score });
    }
  }
  return pairs;
}
