# Open points

Things deliberately left open, with enough context to act on cold. Nothing here blocks shipping the app today.

## 1. Fine-tuning a base bigger than 1.7B (STANDBY — needs QVAC SDK)

**Status:** standby. To raise with the QVAC SDK team.

**What we found (exhaustively probed, see `spike/probe-finetune.mjs` + memory):** the SDK finetuner gates on BOTH architecture and quantization:
- Accepted quant: `F32 / F16 / Q4_0 / Q8_0 / TQ1_0 / TQ2_0`. **`Q4_K_M` (file_type 15) and `Q4_1` (file_type 3) are rejected.**
- Accepted architectures observed: **Qwen3, Gemma**. **Llama is rejected** (`Finetuning is not supported for architecture: llama`).
- Filenames lie: `QWEN3_4B_INST_Q4_SHARD` ("Q4_0") is actually Q4_K_M; `SALAMANDRATA_2B_INST_Q4` ("q4") is actually Q4_1. Always probe, don't trust the label.

**Consequence:** the only **relevant, general-purpose, fine-tunable** bases in the current SDK are **Qwen3 0.6B and 1.7B** (genuine Q4_0). Every Qwen3 4B/8B build is Q4_K_M (not fine-tunable). The only fine-tunable ~4B is `MEDGEMMA_4B_IT_Q8_0` — a **medical** Gemma-3-4B, which we do not use as a personal-voice base (and its run also destabilized: train loss 2.5 -> 3.9 over one epoch). So **Qwen3-1.7B is the production voice** (proven GO, coherent in-register, shipped in the Voice picker).

**The ask for the QVAC team:** publish **Qwen3-4B and/or Qwen3-8B in a fine-tunable quant (Q4_0 or Q8_0)** (and/or add Llama-architecture fine-tune support). The moment such a model constant exists, wiring it in is a one-liner: add it to `BASES` in `spike/finetune.js` and `app/lib/models.js`, and to `CURATED` (group `voice`, `fineTunable: true`) in `app/lib/catalog.js`. The training pipeline, supervisor, and chat Voice toggle already handle any base generically.

## 2. Phase 6 product polish (nice-to-have)
- Turing game ("guess who wrote it: you vs your model") + shareable result card.
- Expo mobile viewer that runs the trained adapter on a phone (offline).
- Replace `prompt()` / `confirm()` (new note, delete, change vault, import) with in-app modals.
- Per-node keyboard selection on the graph (today selection is mouse / shift-click; the command palette covers build / embed / auto-select / train / highlight).

## 3. Remote inference (verified host-side; full link needs a 2nd machine)
`startQVACProvider` (host) + `loadModel({delegate})` (consumer) are implemented and the host + the honest reachability probe are verified on one machine. A full two-machine delegated run (laptop borrowing a Mac mini's GPU) just needs a second device to confirm end to end.
