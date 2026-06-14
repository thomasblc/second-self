import { loadModel, unloadModel, completion, BITNET_B1_58_3B_INST_TQ2_0 } from "@qvac/sdk";
const ctx = Number(process.argv[2] || 4096);
const modelId = await loadModel({ modelSrc: BITNET_B1_58_3B_INST_TQ2_0, modelType: "llm", modelConfig: { device: "gpu", ctx_size: ctx, reasoning_budget: 0 } });
console.log("loaded", modelId, "ctx", ctx);
try {
  const run = completion({ modelId, history: [{ role: "system", content: "Tu es Thomas. Reponds court, en francais, minuscules." }, { role: "user", content: "t'es dispo demain soir?" }], kvCache: false, stream: true, max_tokens: 80 });
  let t = ""; for await (const ev of run.events) if (ev.type === "contentDelta") t += ev.text;
  await run.final;
  console.log("OUTPUT:", JSON.stringify(t));
} catch (e) { console.log("ERR:", e?.code, "|", e?.message); }
await unloadModel({ modelId, clearStorage: false });
process.exit(0);
