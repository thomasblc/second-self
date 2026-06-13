// S0 voice check: the SAME prompts against the plain base model and the base with the
// fine-tuned LoRA attached (a LoRA only runs on the base it was trained on). Prints the
// answers side by side so the voice difference can be judged honestly.
// Usage: node spike/chat-compare.js [--lora train/results/<file>.gguf]
import { loadModel, unloadModel, completion, QWEN3_600M_INST_Q4, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT } from "./make-bootstrap.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };

const dataset = arg("--data", "bootstrap");
const baseKey = arg("--base", "600m"); // must match the base the adapter was trained on
const BASES = { "600m": QWEN3_600M_INST_Q4, "1.7b": QWEN3_1_7B_INST_Q4 };
const BASE = BASES[baseKey];
if (!BASE) { console.error(`unknown --base ${baseKey} (600m | 1.7b)`); process.exit(1); }
// the inference system prompt must MATCH the one used at training time:
// whatsapp datasets train with the owner prompt (connectors/whatsapp.js), bootstrap with its own
const owner = arg("--owner", null);
const SYS = owner
  ? `Tu es ${owner}. Reponds exactement comme ${owner} ecrit dans ses messages: meme langue, meme longueur, meme ton.`
  : SYSTEM_PROMPT;

// default: newest .gguf in the matching results dir (legacy train/results is the fallback)
function findAdapter() {
  for (const dir of [path.join(ROOT, "train", `results-${dataset}-${baseKey}`), path.join(ROOT, "train", "results")]) {
    if (!fs.existsSync(dir)) continue;
    const ggufs = fs.readdirSync(dir, { recursive: true }).map(String)
      .filter((f) => f.endsWith(".gguf"))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (ggufs[0]) return ggufs[0].f;
  }
  return null;
}
const loraPath = arg("--lora", findAdapter());
if (!loraPath || !fs.existsSync(loraPath)) { console.error("no adapter found. run spike/finetune.js first, or pass --lora <path>."); process.exit(1); }
console.log(`adapter: ${loraPath} (${(fs.statSync(loraPath).size / 2 ** 20).toFixed(1)} MB)\n`);

// held-out style prompts: casual chat, NOT verbatim from the train set
const PROMPTS = [
  "t'es dispo demain soir?",
  "on mange quoi ce midi?",
  "t'as vu le match de hier soir?",
  "tu penses quoi des modeles d'ia en local?",
  "le client veut tout changer encore",
  "tu pars ou cet ete?",
  "explique moi vite fait ton projet la",
  "bon week end mec",
];

async function askAll(label, modelConfig) {
  const modelId = await loadModel({ modelSrc: BASE, modelType: "llm", modelConfig });
  const out = [];
  for (const p of PROMPTS) {
    const run = completion({
      modelId,
      history: [
        { role: "system", content: SYS },
        { role: "user", content: p },
      ],
      kvCache: false,
      stream: true,
    });
    let text = "";
    try {
      for await (const ev of run.events) if (ev.type === "contentDelta") text += ev.text;
      await run.final;
      out.push(text.trim().replace(/\s+/g, " ").slice(0, 220) || "(empty)");
    } catch (e) {
      out.push(`(generation failed: ${String(e?.code || e?.message || e).slice(0, 60)})`);
    }
    process.stdout.write(".");
  }
  console.log(` ${label} done`);
  await unloadModel({ modelId, clearStorage: false });
  return out;
}

// sequential loads: one model resident at a time
const base = await askAll("base", { device: "gpu", ctx_size: 1024, reasoning_budget: 0 });
const tuned = await askAll("lora", { device: "gpu", ctx_size: 1024, reasoning_budget: 0, lora: loraPath });

console.log("\n==== BASE vs LORA (same base, same prompts, same system prompt) ====");
PROMPTS.forEach((p, i) => {
  console.log(`\nQ: ${p}`);
  console.log(`  BASE: ${base[i]}`);
  console.log(`  LORA: ${tuned[i]}`);
});
console.log("\njudge: does LORA consistently sound like the dataset voice (lowercase, short, dry, french) where BASE does not?");
process.exit(0);
