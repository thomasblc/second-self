// Unit test for the ContextIndex: add a folder source, search (cited), persist+reload, remove.
// Run with an isolated config dir: SECOND_SELF_CONFIG_DIR=$(mktemp -d) node spike/context-index-test.mjs
import { ContextIndex } from "../app/lib/context.js";
import { ModelManager } from "../app/lib/models.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(ROOT, "app", "sample-vault");
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

  // remove
  ix2.removeSource(src.id);
  ok(ix2.records.length === 0 && ix2.vectors.length === 0 && ix2.sources.length === 0, "removeSource clears records + vectors + source");
  const ix3 = new ContextIndex();
  ok(ix3.records.length === 0, "removal persisted");

  await mm.unloadAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
