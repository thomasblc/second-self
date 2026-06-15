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
import os from "node:os";
import path from "node:path";
import { cosine, chunkText } from "./models.js";
import { CONFIG_DIR } from "./config.js";
import { SQLITE_TYPES, readStore } from "./os-stores.js";

const DIR = path.join(CONFIG_DIR, "context");
const META = path.join(DIR, "index.json");
const VECS = path.join(DIR, "vectors.bin");

// Text formats we can read with zero dependencies. PDF/docx need a parser (next connector).
export const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".org", ".tex",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".sh", ".sql", ".lua", ".r",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".html", ".css", ".xml",
  ".ics", ".vcf", // calendar events + contacts (normalized to readable lines below)
  ".emlx",        // Apple Mail messages (normalized to From/To/Subject/body lines below)
]);

// Some macOS data lives in TCC-protected stores (Calendar, Mail, Messages...). Reading them from
// a plain process needs Full Disk Access; without it readdir throws EPERM. We surface that as a
// distinct error so the UI can guide the user to grant it (instead of "no files found").
export const NEEDS_FDA = "FULL_DISK_ACCESS_REQUIRED";

// ---- .ics calendar normalizer: turn raw VEVENT blocks into one readable line per event ----
function fmtIcsDate(s) {
  const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(s || "");
  if (!m) return s || "";
  return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
export function normalizeIcs(text) {
  const unfolded = String(text || "").replace(/\r?\n[ \t]/g, ""); // RFC5545 line unfolding
  const events = []; const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g; let m;
  const field = (blk, k) => { const r = new RegExp("\\n" + k + "[^:\\n]*:([^\\n]*)").exec("\n" + blk); return r ? r[1].trim() : ""; };
  while ((m = re.exec(unfolded))) {
    const blk = m[1];
    const summary = field(blk, "SUMMARY"), loc = field(blk, "LOCATION");
    const start = fmtIcsDate(field(blk, "DTSTART"));
    const desc = field(blk, "DESCRIPTION").replace(/\\n/g, " ").replace(/\\,/g, ",").trim().slice(0, 300);
    const att = (blk.match(/\nATTENDEE[^:\n]*:(?:mailto:)?([^\n]+)/gi) || []).map((a) => a.split(":").pop().trim()).slice(0, 10).join(", ");
    if (!summary && !start) continue;
    let line = `Event: ${summary || "(untitled)"}`;
    if (start) line += ` | when: ${start}`;
    if (loc) line += ` | where: ${loc}`;
    if (att) line += ` | with: ${att}`;
    if (desc) line += ` | ${desc}`;
    events.push(line);
  }
  return events.join("\n");
}
// .vcf contacts -> "Contact: Name | email | phone | org" lines
export function normalizeVcf(text) {
  const cards = []; const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/g; let m;
  const field = (blk, k) => { const r = new RegExp("\\n" + k + "[^:\\n]*:([^\\n]*)").exec("\n" + blk); return r ? r[1].trim() : ""; };
  while ((m = re.exec(String(text || "")))) {
    const blk = m[1];
    const fn = field(blk, "FN"), email = field(blk, "EMAIL"), tel = field(blk, "TEL"), org = field(blk, "ORG").replace(/;/g, " ");
    if (!fn) continue;
    let line = `Contact: ${fn}`;
    if (org) line += ` | ${org}`;
    if (email) line += ` | ${email}`;
    if (tel) line += ` | ${tel}`;
    cards.push(line);
  }
  return cards.join("\n");
}
// .emlx (Apple Mail) -> one "Email: subject | from | to | date | body-snippet" line.
// Format: a byte-count line, then the RFC822 message, then an XML plist trailer.
export function normalizeEmlx(text) {
  const s = String(text || "");
  const firstNl = s.indexOf("\n");
  const msg = firstNl > -1 && /^\s*\d+\s*$/.test(s.slice(0, firstNl)) ? s.slice(firstNl + 1) : s; // drop the leading byte-count
  const sep = msg.search(/\r?\n\r?\n/); // headers end at the first blank line
  const headers = sep > -1 ? msg.slice(0, sep) : msg;
  const field = (name) => { const m = new RegExp("^" + name + ":\\s*(.*(?:\\r?\\n[ \\t].*)*)", "im").exec(headers); return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : ""; };
  const from = field("From"), to = field("To"), subj = field("Subject"), date = field("Date");
  if (!from && !subj) return "";
  let bodyText = sep > -1 ? msg.slice(sep) : "";
  const plistAt = bodyText.indexOf("<?xml"); if (plistAt > -1) bodyText = bodyText.slice(0, plistAt); // strip the .emlx plist trailer
  bodyText = bodyText.replace(/<[^>]+>/g, " ").replace(/[\s ]+/g, " ").trim().slice(0, 400);
  let line = `Email: ${subj || "(no subject)"}`;
  if (from) line += ` | from: ${from}`;
  if (to) line += ` | to: ${to}`;
  if (date) line += ` | ${date}`;
  if (bodyText) line += ` | ${bodyText}`;
  return line;
}
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
      if (this.dim && this.records.length) {
        const buf = fs.readFileSync(VECS); // throws if missing -> caught -> reset (safe)
        // a torn/partial write leaves meta and vectors out of sync. Validate the EXACT byte size
        // (count alone is not enough: a short buffer yields empty subarrays that pass a count check).
        if (buf.byteLength !== this.records.length * this.dim * 4) throw new Error("vector file size mismatch");
        const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        this.vectors = [];
        for (let i = 0; i < this.records.length; i++) this.vectors.push(Array.from(f.subarray(i * this.dim, (i + 1) * this.dim)));
      } else if (this.records.length) { throw new Error("records without a dim"); }
      if (this.vectors.length !== this.records.length) throw new Error("record/vector misalignment");
    } catch {
      // fail closed: drop chunks/vectors but KEEP source configs (zeroed) so the user can re-index.
      this.records = []; this.vectors = []; this.dim = 0;
      this.sources = (this.sources || []).map((s) => ({ ...s, docCount: 0, chunkCount: 0 }));
    }
  }

  // Atomic-ish save: write each file to a temp then rename. The two files aren't atomic together,
  // but _load's exact-byte-size check rejects any torn pair and resets, so we never load garbage.
  _save() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      if (this.dim && this.vectors.length) {
        const f = new Float32Array(this.vectors.length * this.dim);
        for (let i = 0; i < this.vectors.length; i++) f.set(this.vectors[i], i * this.dim);
        fs.writeFileSync(VECS + ".tmp", Buffer.from(f.buffer, f.byteOffset, f.byteLength));
        fs.renameSync(VECS + ".tmp", VECS);
      } else { try { fs.unlinkSync(VECS); } catch { /* */ } }
      fs.writeFileSync(META + ".tmp", JSON.stringify({ dim: this.dim, sources: this.sources, records: this.records }));
      fs.renameSync(META + ".tmp", META);
    } catch (e) { console.error("[context] save failed (index kept in memory this session):", e?.message || e); }
  }

  stats() {
    return {
      sources: this.sources.map((s) => ({ id: s.id, type: s.type, path: s.path, label: s.label, docCount: s.docCount || 0, chunkCount: s.chunkCount || 0, lastIndexedAt: s.lastIndexedAt || null })),
      totalChunks: this.records.length,
    };
  }

  getSource(id) { return this.sources.find((s) => s.id === id) || null; }
  findByPath(p) { const r = path.resolve(p); return this.sources.find((s) => path.resolve(s.path) === r) || null; }

  // Walk a folder and collect readable text files (bounded). Returns { files:[{rel,abs,mtime}], blocked }.
  // `blocked` is true if any readdir hit a permission error (TCC) - lets the caller ask for Full Disk Access.
  _walk(rootAbs, exts) {
    const out = []; let blocked = false;
    const allow = exts && exts.size ? exts : TEXT_EXTS;
    const stack = [rootAbs];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop();
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { if (e && (e.code === "EPERM" || e.code === "EACCES")) blocked = true; continue; }
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
    return { files: out, blocked };
  }

  // Build a source's records + vectors WITHOUT mutating the index (so a failed embed never
  // corrupts existing data). embed(texts,{onProgress}) -> number[][].
  async _buildFolder({ rootPath, type = "folder", exts = null }, embed, onProgress) {
    const rootAbs = path.resolve(rootPath);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) throw new Error("not a folder: " + rootPath);
    const extSet = exts && exts.length ? new Set(exts.map((x) => (x.startsWith(".") ? x : "." + x).toLowerCase())) : null;
    let { files, blocked } = this._walk(rootAbs, extSet); // blocked may also flip true on a per-file EPERM below
    const records = [];
    for (const f of files) {
      let content; try { content = fs.readFileSync(f.abs, "utf8"); } catch (e) { if (e && (e.code === "EPERM" || e.code === "EACCES")) blocked = true; continue; }
      const ext = path.extname(f.abs).toLowerCase();
      if (ext === ".ics") content = normalizeIcs(content);        // VEVENT -> "Event: ... | when: ..."
      else if (ext === ".vcf") content = normalizeVcf(content);   // VCARD  -> "Contact: ... | email ..."
      else if (ext === ".emlx") content = normalizeEmlx(content); // Apple Mail -> "Email: subject | from: ..."
      for (const c of chunkText(content, 120, 20)) records.push({ sourceId: null, source: f.rel, sourceType: type, text: c });
    }
    // distinguish "macOS blocked the read" (-> ask for Full Disk Access) from "genuinely empty"
    if (!records.length) throw new Error(blocked ? NEEDS_FDA : "no readable text files found in that folder");
    const vectors = await embed(records.map((r) => r.text), { onProgress });
    if (vectors.length !== records.length) throw new Error("embedding returned the wrong count");
    return { rootAbs, fileCount: files.length, records, vectors, dim: vectors[0].length };
  }

  // Build a SQLite-backed source (browser history / contacts / messages). The live DB is opened
  // from a COPY in tmp so we never fight the app's write lock; copying a TCC-protected store throws
  // EPERM, which we surface as NEEDS_FDA. WAL sidecars are copied too (best-effort) so the read
  // reflects recent, not-yet-checkpointed writes. The temp copies are always cleaned up.
  async _buildSqlite({ rootPath, type }, embed, onProgress) {
    const rootAbs = path.resolve(rootPath);
    const tmpDb = path.join(os.tmpdir(), `ss-${type}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const tmpFiles = [];
    const cleanup = () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* */ } } };
    let rows;
    try {
      // COPYFILE_EXCL: fail rather than follow/clobber a pre-existing temp path (symlink hardening).
      try { fs.copyFileSync(rootAbs, tmpDb, fs.constants.COPYFILE_EXCL); tmpFiles.push(tmpDb); }
      catch (e) {
        if (e && (e.code === "EPERM" || e.code === "EACCES")) throw new Error(NEEDS_FDA); // TCC-protected -> ask for Full Disk Access
        if (e && e.code === "ENOENT") throw new Error("store not found: " + rootPath);
        throw e;
      }
      for (const suffix of ["-wal", "-shm"]) { try { fs.copyFileSync(rootAbs + suffix, tmpDb + suffix, fs.constants.COPYFILE_EXCL); tmpFiles.push(tmpDb + suffix); } catch { /* sidecar optional */ } }
      rows = readStore(type, tmpDb); // [{ source, text }]
    } finally { cleanup(); }
    const records = [];
    for (const r of rows) for (const c of chunkText(r.text, 120, 20)) records.push({ sourceId: null, source: r.source, sourceType: type, text: c });
    if (!records.length) throw new Error("no readable entries in that store");
    const vectors = await embed(records.map((r) => r.text), { onProgress });
    if (vectors.length !== records.length) throw new Error("embedding returned the wrong count");
    return { rootAbs, fileCount: rows.length, records, vectors, dim: vectors[0].length };
  }

  // Build a source, dispatching on type: SQLite stores read rows, everything else walks files.
  _build(opts, embed, onProgress) {
    return SQLITE_TYPES.has(opts.type) ? this._buildSqlite(opts, embed, onProgress) : this._buildFolder(opts, embed, onProgress);
  }

  // Commit a built source into the index. Pushes in a LOOP (spread `push(...arr)` throws a
  // RangeError past ~125k args - real for big folders). Returns the source meta.
  _commit(built, { type, label, exts }) {
    if (this.dim && built.dim !== this.dim) throw new Error(`embedding dim mismatch (${built.dim} vs ${this.dim})`);
    if (!this.dim) this.dim = built.dim;
    const id = rid();
    for (const r of built.records) { r.sourceId = id; this.records.push(r); }
    for (const v of built.vectors) this.vectors.push(v);
    const src = { id, type, path: built.rootAbs, label: label || path.basename(built.rootAbs), exts: exts || null, addedAt: Date.now(), lastIndexedAt: Date.now(), docCount: built.fileCount, chunkCount: built.records.length };
    this.sources.push(src);
    this._save();
    return src;
  }

  // Index a new source (build first, then commit). A folder of files or a SQLite store, by type.
  // Name kept as addFolderSource for back-compat with existing callers. Returns the source meta.
  async addFolderSource({ rootPath, label, type = "folder", exts = null }, embed, onProgress) {
    if (this.findByPath(path.resolve(rootPath))) throw new Error("that source is already indexed");
    const built = await this._build({ rootPath, type, exts }, embed, onProgress);
    return this._commit(built, { type, label, exts });
  }

  // Remove a source and ALL its records/vectors (kept perfectly aligned).
  removeSource(id) {
    if (!id) return false; // a falsy id would otherwise match nothing and pointlessly re-save
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].sourceId !== id) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    this.records = keepRec; this.vectors = keepVec;
    this.sources = this.sources.filter((s) => s.id !== id);
    if (!this.records.length) this.dim = 0;
    this._save();
    return true;
  }

  // Swap a source's records/vectors in place, keeping the SAME id (atomic, synchronous, no await).
  // Reindex uses this instead of remove+commit so a source's identity is STABLE across re-indexing:
  // two concurrent reindexes of one id collapse to one source (no duplicate), and a source that was
  // deleted mid-embed is never resurrected (the caller bails before calling this).
  _replaceSource(id, built, { label }) {
    if (this.dim && built.dim !== this.dim) throw new Error(`embedding dim mismatch (${built.dim} vs ${this.dim})`);
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].sourceId !== id) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    for (const r of built.records) { r.sourceId = id; keepRec.push(r); }
    for (const v of built.vectors) keepVec.push(v);
    this.records = keepRec; this.vectors = keepVec;
    if (!this.dim) this.dim = built.dim;
    const src = this.sources.find((s) => s.id === id);
    if (src) { src.path = built.rootAbs; if (label) src.label = label; src.lastIndexedAt = Date.now(); src.docCount = built.fileCount; src.chunkCount = built.records.length; }
    this._save();
    return src;
  }

  // Re-index a source: BUILD the fresh data first; only swap the records in once it succeeds.
  // (Removing first would lose the source on an empty/deleted folder or an embed failure.)
  async reindexSource(id, embed, onProgress) {
    const src = this.getSource(id);
    if (!src) throw new Error("unknown source");
    const prevDim = this.dim;
    const built = await this._build({ rootPath: src.path, type: src.type, exts: src.exts }, embed, onProgress);
    if (prevDim && built.dim !== prevDim) throw new Error(`embedding dim changed (${built.dim} vs ${prevDim}); clear + re-index all sources`);
    // the source may have been removed while we were embedding (user delete, or a concurrent sync);
    // do NOT resurrect it. Re-fetch by id rather than trusting the stale `src` reference.
    if (!this.getSource(id)) return null;
    return this._replaceSource(id, built, { label: src.label });
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
