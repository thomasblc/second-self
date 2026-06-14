// Personal context engine: a SOURCE-TRACKED, on-device index of the user's data.
// Each chunk keeps its source (file path + source type), so retrieval can return real,
// citable origins (the spike proved the model must NOT be trusted to cite - we cite from
// the retrieval layer). Vectors come from the SDK embedder; everything is local + persisted.
//
// Storage (under ~/.second-self/context/, overridable via the config dir):
//   index.json   - { dim, sources:[...], records:[{sourceId,source,sourceType,text}] }
//   vectors.bin  - Float32 matrix (records.length x dim), aligned to records order
//
// Design notes:
// - The vault is just the first source (type "vault"); folders the user adds are more sources.
// - Retrieval is cosine top-k today (the spike showed it's a strong baseline); source/recency
//   weighting + hybrid search are the documented next lever for scale.
import fs from "node:fs";
import path from "node:path";
import { cosine, chunkText } from "./models.js";
import { CONFIG_DIR } from "./config.js";

const DIR = path.join(CONFIG_DIR, "context");
const META = path.join(DIR, "index.json");
const VECS = path.join(DIR, "vectors.bin");

// Text formats we can read with zero dependencies. PDF/docx need a parser (next connector).
export const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".org", ".tex",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".sh", ".sql", ".lua", ".r",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".html", ".css", ".xml",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv"]);
const MAX_FILE = 2 * 1024 * 1024; // skip files larger than 2 MB (logs/minified blobs)
const MAX_FILES = 20000;          // cap a runaway folder scan

const rid = () => "src-" + Math.random().toString(36).slice(2, 10);

export class ContextIndex {
  constructor() {
    this.sources = []; // [{ id, type, path, label, exts, addedAt, lastIndexedAt, docCount, chunkCount }]
    this.records = []; // [{ sourceId, source, sourceType, text }] aligned to this.vectors
    this.vectors = []; // number[][]
    this.dim = 0;
    this._load();
  }

  _load() {
    try {
      const meta = JSON.parse(fs.readFileSync(META, "utf8"));
      this.sources = Array.isArray(meta.sources) ? meta.sources : [];
      this.records = Array.isArray(meta.records) ? meta.records : [];
      this.dim = Number(meta.dim) || 0;
      if (this.dim && this.records.length && fs.existsSync(VECS)) {
        const buf = fs.readFileSync(VECS);
        const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        this.vectors = [];
        for (let i = 0; i < this.records.length; i++) this.vectors.push(Array.from(f.subarray(i * this.dim, (i + 1) * this.dim)));
      }
      // corruption guard: records and vectors must stay aligned
      if (this.vectors.length !== this.records.length) { this.records = []; this.vectors = []; this.sources = this.sources.map((s) => ({ ...s, docCount: 0, chunkCount: 0 })); }
    } catch { this.sources = []; this.records = []; this.vectors = []; this.dim = 0; }
  }

  _save() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(META, JSON.stringify({ dim: this.dim, sources: this.sources, records: this.records }));
      if (this.dim && this.vectors.length) {
        const f = new Float32Array(this.vectors.length * this.dim);
        for (let i = 0; i < this.vectors.length; i++) f.set(this.vectors[i], i * this.dim);
        fs.writeFileSync(VECS, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      } else { try { fs.unlinkSync(VECS); } catch { /* */ } }
    } catch { /* non-fatal: index still works in memory this session */ }
  }

  stats() {
    return {
      sources: this.sources.map((s) => ({ id: s.id, type: s.type, path: s.path, label: s.label, docCount: s.docCount || 0, chunkCount: s.chunkCount || 0, lastIndexedAt: s.lastIndexedAt || null })),
      totalChunks: this.records.length,
    };
  }

  getSource(id) { return this.sources.find((s) => s.id === id) || null; }
  findByPath(p) { const r = path.resolve(p); return this.sources.find((s) => path.resolve(s.path) === r) || null; }

  // Walk a folder and collect readable text files (bounded). Returns [{ rel, abs, mtime }].
  _walk(rootAbs, exts) {
    const out = [];
    const allow = exts && exts.size ? exts : TEXT_EXTS;
    const stack = [rootAbs];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop();
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
        if (!e.isFile()) continue; // skip symlinks/sockets
        if (!allow.has(path.extname(e.name).toLowerCase())) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > MAX_FILE || st.size === 0) continue;
        out.push({ rel: path.relative(rootAbs, abs), abs, mtime: st.mtimeMs });
        if (out.length >= MAX_FILES) break;
      }
    }
    return out;
  }

  // Index a folder as a source. embed(texts,{onProgress}) -> number[][]. Returns the source meta.
  async addFolderSource({ rootPath, label, type = "folder", exts = null }, embed, onProgress) {
    const rootAbs = path.resolve(rootPath);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) throw new Error("not a folder: " + rootPath);
    if (this.findByPath(rootAbs)) throw new Error("that folder is already a source");
    const extSet = exts && exts.length ? new Set(exts.map((x) => (x.startsWith(".") ? x : "." + x).toLowerCase())) : null;
    const files = this._walk(rootAbs, extSet);

    const newRecords = [];
    for (const f of files) {
      let content; try { content = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
      for (const c of chunkText(content, 120, 20)) newRecords.push({ sourceId: null, source: f.rel, sourceType: type, text: c });
    }
    if (!newRecords.length) throw new Error("no readable text files found in that folder");

    const vectors = await embed(newRecords.map((r) => r.text), { onProgress });
    if (!vectors.length) throw new Error("embedding produced no vectors");
    if (!this.dim) this.dim = vectors[0].length;

    const id = rid();
    for (const r of newRecords) r.sourceId = id;
    this.records.push(...newRecords);
    this.vectors.push(...vectors);
    const src = { id, type, path: rootAbs, label: label || path.basename(rootAbs), exts: exts || null, addedAt: Date.now(), lastIndexedAt: Date.now(), docCount: files.length, chunkCount: newRecords.length };
    this.sources.push(src);
    this._save();
    return src;
  }

  // Remove a source and ALL its records/vectors (kept perfectly aligned).
  removeSource(id) {
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].sourceId !== id) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    this.records = keepRec; this.vectors = keepVec;
    this.sources = this.sources.filter((s) => s.id !== id);
    if (!this.records.length) this.dim = 0;
    this._save();
    return true;
  }

  async reindexSource(id, embed, onProgress) {
    const src = this.getSource(id);
    if (!src) throw new Error("unknown source");
    const cfg = { rootPath: src.path, label: src.label, type: src.type, exts: src.exts };
    this.removeSource(id);
    return this.addFolderSource(cfg, embed, onProgress);
  }

  // Cosine top-k over all (or a filtered set of) sources. Returns citable records + scores.
  search(queryVec, { topK = 8, sourceIds = null, minScore = 0.3 } = {}) {
    if (!this.records.length) return [];
    const allow = sourceIds && sourceIds.length ? new Set(sourceIds) : null;
    const scored = [];
    for (let i = 0; i < this.records.length; i++) {
      if (allow && !allow.has(this.records[i].sourceId)) continue;
      const score = cosine(queryVec, this.vectors[i]);
      if (score >= minScore) scored.push({ ...this.records[i], score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
