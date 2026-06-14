setTimeout(()=>{console.log("[watchdog]");process.exit(2);},600000);
import { loadModel, finetune, unloadModel, BITNET_B1_58_3B_INST_TQ2_0, BITNET_1B_INST_TQ2_0 } from "@qvac/sdk";
import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRAIN = path.join(ROOT,"data","whatsapp.train.jsonl"), EVAL = path.join(ROOT,"data","whatsapp.eval.jsonl");
for (const [name,src] of [["BitNet-3B (TQ2_0)",BITNET_B1_58_3B_INST_TQ2_0],["BitNet-1B (TQ2_0)",BITNET_1B_INST_TQ2_0]]) {
  let id;
  try {
    console.log(`\n=== probing ${name} ===`);
    id = await loadModel({ modelSrc: src, modelType:"llm", modelConfig:{ device:"gpu", ctx_size:256 }});
    const h = finetune({ modelId:id, options:{ trainDatasetDir:TRAIN, validation:{type:"dataset",path:EVAL}, numberOfEpochs:1, contextLength:256, learningRate:5e-5, lrMin:1e-8, loraModules:"attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down", assistantLossOnly:true, checkpointSaveSteps:100000, checkpointSaveDir:path.join(ROOT,"train","probe-ckpt"), outputParametersDir:path.join(ROOT,"train","probe-out") }});
    const verdict = await Promise.race([
      (async()=>{ for await (const t of h.progressStream){ if(t.is_train && Number.isFinite(t.loss)) return `PASS (fine-tunable; step ${t.global_steps} loss ${t.loss.toFixed(3)})`; } return "PASS (no error)"; })(),
      h.result.then(r=>`END ${r.status}`).catch(e=>`FAIL: ${String(e?.message||e).slice(0,120)}`),
    ]);
    console.log(`  ${name}: ${verdict}`);
    try{ finetune({modelId:id,operation:"pause"}).catch(()=>{}); }catch{}
  } catch(e){ console.log(`  ${name}: FAIL ${String(e?.message||e).slice(0,140)}`); }
  finally { if(id){ try{await unloadModel({modelId:id,clearStorage:false});}catch{} } }
}
console.log("\nbitnet probe done"); process.exit(0);
