# Second Self - full product spec (Thomas's build)

**Status:** S0 = GO (voice proven at 1.7B, 2026-06-13). This is the concrete build spec, on top of the recipe template (`docs/content/recipes/23-second-self.md`).

**What Second Self IS (corrected with Thomas, 2026-06-13):** a free, open-source, local **Obsidian alternative** that ALSO trains a model on you. One single app. Not a separate vault, not just a fine-tune tool.

1. **A real note-taking vault** (the Obsidian-like part): create / edit / search markdown notes, `[[wikilinks]]`, backlinks, and a force-directed **knowledge graph** of how everything connects. This works fully on day one with no model trained.
2. **On-device personalization:** the app picks the **relevant** docs from your vault (ideally automatically, by the model/embeddings) and trains a LoRA on them.
3. **Two models:** a **base** (untrained, available from the first launch: powers search, doc-selection, and chat right away) and, after training, a **fine-tuned** model that talks like you and knows your vault.

**One line:** an open-source second brain that you can talk to in your own voice, trained on your own notes, entirely on your machine.

---

## 0. Where we are (recap)

| Layer | State |
|---|---|
| Fine-tune pipeline (connector -> SFT JSONL -> `finetune()` -> adapter -> reload -> chat) | DONE on-device (S0) |
| Trainer ground truth (ctx, lr, batch-in-tokens, NaN divergence, 1.7B checkpoint hang) | MEASURED (memory `qvac-finetune-s0`) |
| 600M real-data run | DONE. In-voice but ~half incoherent = capacity wall. NO-GO. |
| **1.7B real-data run** | **DONE. Coherent + in-voice. GO.** val loss 2.06, adapter 33.5 MB, ~2h, 2.7 GB RAM |
| The vault app (notes, search, graph) | NOT built |
| Auto-selection of relevant docs | NOT built |
| RAG memory + two-model chat | NOT built |

S0's only question ("does a feasible on-device base sound like Thomas?") is answered: yes, at 1.7B. The app is now unblocked. The S0 code (`spike/finetune.js`, `connectors/whatsapp.js`, `pipeline/build-sft.js`, `chat-compare.js`) becomes the training backend of the app.

---

## 1. The product: one app, three panes

A single local web app (`http://localhost:3090`, two-process: Node backend + vanilla browser frontend over WebSocket). Left rail switches panes. A persistent footer shows the LOCAL / NETWORK boundary. **Zero extra runtime deps beyond `@qvac/sdk` + `ws`** (own markdown renderer + own canvas graph, fully offline; recipe hard rule 9).

### Pane 1 - Vault (the open-source Obsidian)
The core app, useful with no model. Points at a vault folder (a directory of `.md` files).

- **Note list / tree** of the vault folder, with folders.
- **Editor + live preview** of markdown (own compact renderer: headings, bold/italic, code, lists, links, `[[wikilinks]]`).
- **Create / edit / rename / delete** notes (writes real `.md` files in the vault).
- **`[[wikilinks]]`** resolved to other notes; **backlinks** panel ("what links here").
- **Full-text search** across the vault, ranked.
- **Vault picker:** choose any folder. Default for dev = this repo's `docs/` (Thomas okayed it for testing). The chosen vault is the single source of truth; everything else derives from it.

### Pane 2 - Graph + Train
The knowledge map and the personalization, together (the map drives what gets trained).

**Graph (the "neural network" view):**
- Force-directed canvas. Nodes = notes (later: projects, entities). Node size = degree; color = folder/type.
- Edges: (1) `[[wikilinks]]` + markdown links (hard), (2) same-folder (structural), (3) shared entities / co-mention, (4) **`embed()` similarity** computed on-device (the QVAC angle: notes that are semantically close link up even without an explicit link). 
- Click a node -> open it in the Vault pane; hover -> highlight neighborhood; focus mode; filter/search.

**Auto-selection of relevant docs (the smart part Thomas asked for):**
- The app proposes which docs to train on, automatically. Method: embed every note, then score relevance/coherence. Two signals combined: (a) embedding density (notes central to clusters = your real recurring themes), (b) an **LLM relevance pass** using the BASE model ("is this the owner's own writing worth learning a voice from, yes/no + why"), filtering out boilerplate, pasted external text, stubs.
- The selection is shown ON the graph (selected nodes highlighted) and is fully **overridable**: the user can add/remove nodes. This is why the graph and training live in the same pane.
- Optional intent: the user types what they want ("train on my research + journal voice") and `ragSearch` over the vault biases the selection.

**Train console:**
- Base picker: **`1.7b` and `4b`** (and `8b`) all wired, with measured/estimated cost shown.
- One button -> `finetune()` on the selected docs (Causal for long-form note prose; SFT when chat exports are added). Live panel: epoch, step, loss curve, ETA, peak RAM (from `progressStream`). Pause / resume.
- Output: a versioned adapter `adapters/<base>-<date>.gguf` the user owns (the SDK writes the FIXED `trained-lora-adapter.gguf`; we copy + version it).

### Pane 3 - Chat (two models)
- **Model switch: Base vs Fine-tuned.** The base is available immediately (untrained); the fine-tuned appears once a run completes. This is the felt before/after.
- **Memory** toggle = `ragSearch` over the vault `me` workspace injected as grounding. **Voice** toggle = the LoRA (`modelConfig.lora`).
- Four states: generic / base+facts / base+voice / both. Retrieval hit scores shown next to grounded answers.
- (S0 confirmed the architecture: the LoRA gives the register, retrieval gives on-topic facts; the 1.7B LoRA answers off-topic without retrieval, by design.)

Later (Phase 5): the Turing game + share card from the recipe, then the Expo mobile viewer that runs the adapter on the phone.

---

## 2. What trains on what (the corpus map)

| Source | Feeds | Mode | Role |
|---|---|---|---|
| Vault markdown notes (auto-selected) | Causal SFT (long-form prose voice) **and** RAG | both | **Voice** (how he writes) + **Memory** (facts) |
| Chat exports (WhatsApp etc., optional add-on) | SFT, owner = assistant, `assistantLossOnly: true` | SFT | **Voice** (conversational cadence) |
| Every note, embedded | RAG `me` workspace + graph similarity edges | `embed()` | **Memory** + graph map |

LoRA = voice. RAG `me` workspace = facts. Chat joins them. The graph visualizes the memory and selects the voice corpus.

---

## 3. Model strategy (decided)

- **Fine-tunable bases (SDK 0.12.2, no size gate, `finetune()` generic over any loaded `llamacpp-completion` model):** `QWEN3_600M_INST_Q4`, `QWEN3_1_7B_INST_Q4`, `QWEN3_4B_INST_Q4_K_M`, `QWEN3_8B_INST_Q4_K_M`, + `LLAMA_3_2_1B`, `GEMMA_4B_IT`.
- **Picker ships 1.7b + 4b (+8b)** (Thomas's call: both in the picker). 600M = NO-GO. 1.7B = guaranteed mobile + ~2h/2.7GB measured. 4B = desktop sweet spot (more coherent, ~4-5h/5-7GB estimated, re-measure). 8B = best/overnight.
- **The base model also powers the app before any training:** doc auto-selection (relevance scoring), and the "Base" side of chat. So we load a base on launch regardless.
- **A LoRA is bound to its base** (cannot transfer a 1.7B adapter to a 4B). To get a better model: bigger base + more real data, NOT small->big distillation.

---

## 4. Architecture

```
+-----------------------------------------------------------+
|  FRONTEND (browser, vanilla, WebSocket)                   |
|  Pane 1 Vault   tree + md editor/preview + search + links |
|  Pane 2 Graph+Train  force graph + auto-select + finetune |
|  Pane 3 Chat    Base/Fine-tuned switch + Memory + Voice   |
|  Footer: LOCAL / NETWORK boundary                         |
+----------------------------|------------------------------+
                             | WebSocket (vault ops, graph, progress, tokens, hits)
+----------------------------|------------------------------+
|  BACKEND (Node + @qvac/sdk + ws)                          |
|  app/lib/vault.js   list/read/write/search md, link parse |
|  app/lib/graph.js   nodes + edges (links/folder/embed sim)|
|  app/lib/models.js  load/unload base+embed, completion,   |
|                     embed, ragIngest/ragSearch            |
|  app/lib/select.js  auto-pick relevant docs (embed + LLM) |
|  app/lib/train.js   wraps spike/finetune.js, progress, ver|
|  app/server.js      HTTP static + WS, orchestration       |
+-----------------------------------------------------------+
```

Reuse from S0: `spike/finetune.js` (guards, NaN guard, no-checkpoint hang fix), `connectors/whatsapp.js`, `pipeline/build-sft.js`, `spike/chat-compare.js`.

---

## 5. Build phases (post-GO)

- **Phase 1 - vault core.** `vault.js` (file ops + link parse) + backend WS + frontend Pane 1 (tree, editor, preview, search, backlinks). Works with no model. Verifiable on this repo's `docs/`.
- **Phase 2 - graph.** `graph.js` (link + folder + co-mention edges first; `embed()` similarity edges once the embedder is wired) + the force-directed canvas + interactions.
- **Phase 3 - models + selection.** `models.js` (load base + embedder on launch), `select.js` (auto-pick relevant docs: embedding density + LLM relevance), RAG ingest of the vault.
- **Phase 4 - train.** `train.js` wraps `finetune.js`; base picker (1.7b/4b/8b); live progress; adapter versioning.
- **Phase 5 - chat.** Base vs fine-tuned switch, Memory + Voice toggles, hit scores, token streaming.
- **Phase 6 - polish.** Turing game, share card, Expo mobile viewer (adapter on phone).

Order of execution is the agent's call (Thomas delegated). Sensible path: 1 -> 2 (link edges) -> 3 (embedder unlocks embed edges + selection) -> 4 -> 5, building the embedder once in Phase 3 and back-filling the graph's similarity edges.

---

## 6. Open choices (non-blocking, decide when natural)

1. **Real vault to personalize on:** Thomas picks later; dev/test uses this repo's `docs/`.
2. **Name:** "Second Self" provisional (alts: EchoVault, MindForge).

---

## 7. Privacy contract (absolute)

Vault read/write, embedding, training, inference all on-device. The agent NEVER reads Thomas's private messages; only local code does; the agent sees aggregate counts/shapes + the model's own generations. The only network call in the whole app = the first-run model download. Every data-touching panel tagged LOCAL. (Recipe hard rule 4 + standing privacy rule.)
