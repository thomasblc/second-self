// Unit test for the ContextIndex: add a folder source, search (cited), persist+reload, remove.
// Run with an isolated config dir: SECOND_SELF_CONFIG_DIR=$(mktemp -d) node spike/context-index-test.mjs
import { ContextIndex } from "../app/lib/context.js";
import { ModelManager } from "../app/lib/models.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(ROOT, "app", "sample-vault");
const SAMPLE2 = path.join(SAMPLE, "projects"); // a distinct subfolder (own path) with real .md files, for the mid-flight-remove race
const mm = new ModelManager({ ctxSize: 4096 });
const embed = (t, o) => mm.embedMany(t, o);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

(async () => {
  const ix = new ContextIndex();
  ok(ix.records.length === 0, "fresh index is empty");

  const src = await ix.addFolderSource({ rootPath: SAMPLE, label: "sample", type: "vault", exts: ["md"] }, embed);
  ok(src.chunkCount > 0 && src.docCount > 0, `indexed ${src.docCount} docs -> ${src.chunkCount} chunks`);
  ok(ix.dim === 768, `embedding dim = ${ix.dim} (EmbeddingGemma 768)`);
  ok(ix.records.length === ix.vectors.length, "records and vectors stay aligned");

  const qv = (await mm.embedMany(["how do atomic notes work?"]))[0];
  const hits = ix.search(qv, { topK: 3 });
  ok(hits.length > 0 && hits[0].source && typeof hits[0].score === "number", `search returns cited hits (top: ${hits[0]?.source} ${hits[0]?.score?.toFixed(2)})`);
  ok(hits.every((h) => h.sourceType === "vault"), "hits carry their source type");

  // persistence: a brand-new index instance must load what we saved
  const ix2 = new ContextIndex();
  ok(ix2.records.length === ix.records.length && ix2.vectors.length === ix.vectors.length, `reload restores ${ix2.records.length} chunks + vectors`);
  ok(ix2.dim === 768 && ix2.vectors[0].length === 768, "reloaded vectors have the right dim");
  const hits2 = ix2.search(qv, { topK: 3 });
  ok(hits2.length === hits.length && hits2[0].source === hits[0].source, "reloaded index searches identically");

  // reindex is atomic (build-then-swap): data survives, count stays consistent
  const before = ix2.records.length;
  const re = await ix2.reindexSource(src.id, embed);
  ok(ix2.records.length === before && re.chunkCount === before, `reindex rebuilds atomically (${re.chunkCount} chunks)`);
  ok(ix2.records.length === ix2.vectors.length, "records/vectors aligned after reindex");
  // reindex keeps the SAME id (stable identity) so it can never spawn a duplicate source
  ok(re.id === src.id, "reindex preserves the source id (stable, no duplicate)");
  ok(ix2.sources.length === 1, "reindex did not create a second source");

  // no resurrection: a source removed WHILE its reindex is in flight must NOT come back
  const tmp = await ix2.addFolderSource({ rootPath: SAMPLE2, label: "tmp", type: "folder", exts: ["md"] }, embed);
  const racing = ix2.reindexSource(tmp.id, embed); // embed is awaited inside; control returns here first
  ix2.removeSource(tmp.id);                         // user deletes it mid-embed
  const resurrected = await racing;
  ok(resurrected === null, "reindex of a source removed mid-flight returns null (no resurrection)");
  ok(!ix2.getSource(tmp.id) && ix2.sources.length === 1, "the removed source stays removed; no ghost re-added");

  // remove
  ix2.removeSource(re.id);
  ok(ix2.records.length === 0 && ix2.vectors.length === 0 && ix2.sources.length === 0, "removeSource clears records + vectors + source");
  const ix3 = new ContextIndex();
  ok(ix3.records.length === 0, "removal persisted");

  // SQLite-backed source: a synthetic Chromium History DB indexed + searched through _build (real embed)
  const histDb = path.join(os.tmpdir(), `ss-spike-hist-${process.pid}.db`); fs.rmSync(histDb, { force: true });
  { const db = new DatabaseSync(histDb);
    db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INT, typed_count INT, last_visit_time INT, hidden INT)");
    const t = (Math.floor(Date.UTC(2026, 5, 10) / 1000) + 11644473600) * 1000000;
    db.prepare("INSERT INTO urls VALUES(1,?,?,?,0,?,0)").run("https://example.com/quantization-explained", "Model quantization explained", 5, BigInt(t));
    db.close(); }
  const bsrc = await ix3.addFolderSource({ rootPath: histDb, label: "Browser history", type: "browser" }, embed);
  ok(bsrc.chunkCount > 0 && bsrc.type === "browser", `sqlite browser source indexed (${bsrc.chunkCount} chunks)`);
  const bhits = ix3.search((await mm.embedMany(["what did I read about quantization?"]))[0], { topK: 3 });
  ok(bhits.length > 0 && bhits[0].sourceType === "browser" && /quantization/i.test(bhits[0].text), "sqlite source is searchable + cited by type");
  // reindex re-reads the live DB (build-then-swap) and keeps the same id
  const bre = await ix3.reindexSource(bsrc.id, embed);
  ok(bre && bre.id === bsrc.id, "sqlite source reindexes in place (same id)");
  fs.rmSync(histDb, { force: true });

  await mm.unloadAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
