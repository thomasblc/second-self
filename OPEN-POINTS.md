# Open points

Things deliberately left open, with enough context to act on cold. Nothing here blocks shipping the app today.

## 1. Fine-tuning above 1.7B is a QUANT gate, not a size limit

**Status:** Fine-tuning SOLVED for a non-medical base — **BitNet-b1.58 3B (TQ2_0)** probe-passed the
fine-tune gate AND a full real-data run completed correctly (2026-06-14: 2210 steps, train loss
6.95 -> 1.79, 49 MB adapter `adapters/3b-2026-06-14-18-37.gguf`; one mid-run SDK `MODEL_UNLOAD_FAILED`
crash that the supervisor self-healed). The 4B specifically remains standby (see below).

**BUT BitNet-3B inference is impractical in this SDK build (measured 2026-06-14).** Completion fails
with `CONTEXT_OVERFLOW` (52421) at a normal `ctx_size` (4096) on a ~30-token prompt; at ctx 8192/32768
it loads but does not finish a tiny generation within 90s (unusably slow). So BitNet-3B is a
**train-only** base here: the app keeps it as a fine-tunable base, marks it train-only, and EXCLUDES
3B adapters from the runnable Voice picker. **Qwen3-1.7B stays the production voice** (trains AND runs
fast). Ask for the QVAC team: make BitNet TQ2_0 completion usable at a normal context (the overflow at
ctx 4096 for a tiny prompt looks like a context-reservation bug specific to this quant/arch).

**The finetuner has TWO independent gates (both probed live 2026-06-17, `finetune()` on a Mac):**
1. **Quant:** accepts `F32 / F16 / Q4_0 / Q8_0 / TQ1_0 / TQ2_0`; **rejects `Q4_K_M`** with `Finetuning is not supported for this quantization type (file_type=15)`.
2. **Architecture:** Qwen3 + BitNet accepted; **Llama rejected** (`Finetuning is not supported for architecture: llama`).

| Constant | Quant | Arch | `finetune()` live result |
|---|---|---|---|
| `QWEN3_1_7B_INST_Q4` | Q4_0 | Qwen3 | PASS (first train step, loss 8.529) |
| `BITNET_B1_58_3B_INST_TQ2_0` | TQ2_0 | BitNet | trained (adapter on disk; a 3B trains) |
| `LLAMA_3_2_1B_INST_Q4_0` | Q4_0 | Llama | FAIL: architecture llama (quant ok, arch not) |
| `QWEN3_4B_INST_Q4_SHARD` | header=15 | Qwen3 | FAIL: file_type=15 |
| `QWEN3_4B_INST_Q4_K_M` | Q4_K_M | Qwen3 | FAIL: file_type=15 |
| `QWEN3_8B_INST_Q4_K_M` | Q4_K_M | Qwen3 | FAIL: file_type=15 |

**It is NOT a size cap** (a 3B trains). The blocker: **every Qwen3-4B/8B build in the SDK registry is Q4_K_M**, including `QWEN3_4B_INST_Q4_SHARD` whose registryPath is `.../Qwen3-4B-Q4_0-00001-of-00005.gguf` (filename says Q4_0, GGUF header reports Q4_K_M = file_type 15). A Qwen3-4B/8B in a genuine Q4_0 or Q8_0 build should fine-tune (Qwen3 arch is accepted, as 1.7B proves). NOTE on `MEDGEMMA_4B_IT_Q8_0` (Gemma-3-4B, Q8_0): plausibly fine-tunable (Gemma arch + Q8_0 are both accepted) but it's medical so we don't use it, and that specific claim is NOT verified (no adapter on disk). Earlier notes also recorded a divergent MedGemma run (loss 2.5 -> 3.9) but that too is unverified here. **So Qwen3-1.7B is the production voice** (proven PASS, shipped in the Voice picker).

**Largest fine-tunable base today = BitNet-b1.58 3B (TQ2_0), non-medical, wired in.** Asks for the QVAC SDK team (Slack-ready): (1) publish Qwen3-4B/8B in a fine-tunable quant (Q4_0 or Q8_0); (2) fix the mislabeled `QWEN3_4B_INST_Q4_SHARD` (path says Q4_0, header is Q4_K_M); (3) confirm whether `loadModel`/`finetune` accept a self-supplied GGUF via `modelSrc` (local path or arbitrary HF ref) so we could quantize our own Q8_0 Qwen3-4B meanwhile (docs say "any llama.cpp-compatible `*.gguf`" but examples only use named constants); (4) nice-to-have: Llama-architecture fine-tune support. The moment a fine-tunable 4B/8B constant exists, wiring it is a one-liner: add it to `BASES` in `spike/finetune.js` + `app/lib/models.js` and to `CURATED` (group `voice`, `fineTunable:true`) in `app/lib/catalog.js`. The pipeline, supervisor, and Voice toggle already handle any base generically (as BitNet-3B proved). Canonical call pattern: `loadModel({modelSrc, modelType:"llm"})` then `finetune({modelId, options})`, see `node_modules/@qvac/sdk/dist/examples/finetune/llamacpp-finetune.js`.

## 2. Phase 6 product polish (nice-to-have)
- Turing game ("guess who wrote it: you vs your model") + shareable result card.
- Expo mobile viewer that runs the trained adapter on a phone (offline).
- Replace `prompt()` / `confirm()` (new note, delete, change vault, import) with in-app modals.
- Per-node keyboard selection on the graph (today selection is mouse / shift-click; the command palette covers build / embed / auto-select / train / highlight).

## 3. Remote inference (verified host-side; full link needs a 2nd machine)
`startQVACProvider` (host) + `loadModel({delegate})` (consumer) are implemented and the host + the honest reachability probe are verified on one machine. A full two-machine delegated run (laptop borrowing a Mac mini's GPU) just needs a second device to confirm end to end.

## 4. Devices / "master machine" model (the one open fork)

**Decision needed from Thomas before building further.** There are two fundamentally different network topologies, and they are opposites in where the data lives:

- **Path 1 - Delegated inference (what qcode does, ALREADY BUILT + off-LAN):** each device keeps its OWN vault locally and borrows another machine's GPU for model calls. Uses the SDK's `delegate` over Hyperswarm, which NAT-traverses automatically (works off-LAN, internet to internet, per qcode's PEER-SETUP). This is the current Devices tab ("Share this machine's GPU" / "Connect to a remote machine"). Files stay on the client; only model compute is shared.
- **Path 2 - Master holds the vault (what Thomas described):** one "master" machine holds the single vault AND runs the model; "satellite" devices are thin clients that browse the master's vault and run inference on it. qcode does NOT do this. It needs a NET-NEW Hyperswarm RPC tunnel that forwards the whole `{id,type,...}` app protocol (vault ops included) to the master, reusing the existing `handle()` dispatch. `hyperswarm`/`hyperdht`/`b4a` are directly resolvable from the SDK `node_modules`, so it is buildable; it just needs a two-machine off-LAN test that only Thomas can run.

**qcode finding (researched 2026-06-14):** every Hyperswarm reference in `/Users/thomasblanc/1_app/qcode` is a comment; qcode relies entirely on the SDK `delegate` (= Path 1). So "learn from qcode" => Path 1 is the proven, off-LAN-capable approach and it is already in the app. Path 2 matches Thomas's "master machine" description but is a new build.

**BUILT (2026-06-14): Path 2 is implemented + loopback-verified.** `app/lib/master-link.js` (`MasterServer` + `MasterClient` over `hyperdht`, NDJSON framing, 8 MB frame cap). The master exposes its app protocol over an encrypted P2P socket paired by its 64-hex public key (`master.start` -> pairing code). A satellite (`master.connect`) proxies every browser frame to the master and relays replies/pushes back, tagged `cid:origId` (12-byte cid) so multiple tabs route correctly. UI: Settings -> Devices ("Become master" / "Connect to a master machine"), footer indicator, click-to-disconnect.

Verified `spike/master-loopback.mjs` (9/9, two processes over the real DHT): after pairing the satellite's `vault.list`/`read`/`info` return the MASTER's data; reverts on disconnect.

**Security model (reviewed):** the pairing code is a bearer capability (anyone holding it gets the master's vault, like the SDK delegate). A MASTER-SIDE allow-list (`TUNNEL_ALLOW` in `server.js`) restricts the tunnel to thin-client ops (vault list/read/info/search + note CRUD, graph, select, rag, model status/catalog/warm, chat, agent, train); it DENIES `vault.setRoot`/`createVault`/`switchVault`, `fs.browse`/`fs.mkdir`, `import.cloud` (unsandboxed read), `master.*`/`provider.*`/`remote.*` (no chaining), `config.set`, `model.download/delete`. Note CRUD stays confined to the master's vault root by `vault.js`. Satellite-side vault management is `LOCAL_ONLY` and leaves the master first.

**Still needs:** a real two-machine off-LAN run (laptop as satellite of a Mac mini master) to confirm end to end. Set `QVAC_HYPERSWARM_SEED` on the master for a stable pairing code across restarts.

## 5. Personal context engine (Phase A) - shipped + deferred optimizations

**Shipped (2026-06-15):** `app/lib/context.js` - an on-device, source-tracked index. The vault is
source #1; users add folders (Settings -> Memory & Sources). Chat Memory retrieves across all
sources and the UI shows clickable citation chips built from the RETRIEVAL layer (the spike proved
the model can't be trusted to cite). Crash-safe persistence (atomic-ish save + exact-byte-size load
check), build-then-swap (re)index (a failed/empty re-index never wipes memory), one unified worker
mutex (every load/completion/embed/unload serializes on the single ~/.qvac worker). Verified: context
unit 13/13, concurrency 2/2, E2E 49/49 with models. Spike proof (retrieval quality on a real 103-doc
corpus): the right source in top-k 5-6/6, 1187 chunks embedded in 9s; 1.7B answers correctly, 8B is
cleaner. The make-or-break (retrieval + cited answers, 100% local) is validated.

**Deferred optimizations (fine at personal scale; do before 50k+ chunks), from the full-app review:**
- **Flat `Float32Array` vector store + pre-normalized dot-product** in `context.js`. Today vectors are
  boxed `number[][]` in RAM (~8-12x a packed Float32) and `index.json` (all chunk text) + `vectors.bin`
  are fully rewritten on every mutation; cosine is an O(n) scan on the event loop. Breaks ~50k chunks
  (RAM > 1GB, query 60ms+ blocking, multi-hundred-ms saves). Cheapest fix: store one flat `Float32Array`
  (vectors.bin is already flat), normalize at write, dot-product at query. Highest-impact perf item.
- **Reuse embeddings across features.** `select.auto` re-embeds the vault prose a 3rd time (after the
  graph's `ensureDocEmb` and the context index). Note-granularity passes (`select.auto` <-> `docEmb`)
  can share a cache; key `docEmb` by note path + content hash for incremental rebuilds on `vault.changed`.
- **Graph idle RAF:** `graph.js` keeps repainting at 60fps when settled (battery). Stop the RAF loop
  once `alpha` is low and nothing is hovered/dragged; restart on interaction. Also a node cap / Barnes-Hut
  only if 1000+ note vaults are a target.
- **File-tree partial updates:** `renderTree()` rebuilds the whole tree on every note open / folder
  toggle; toggle the `.active`/`collapsed` class instead. Bites at 2-3k+ notes.
- **`reindex` is a full re-embed** (no mtime diffing, though `_walk` already captures mtime). Fine as a
  deliberate user action; add incremental diffing later for "keep fresh".

**Vault-switch <-> context coordination (P1, non-crashing):** after `switchVault`, the context index still
holds the old vault's chunks until the user re-indexes; vault citation chips for the old vault open to a
"note not found" toast. `rag.ingest` already re-points + reindexes on path change. Make `switchVault`
mark the vault source stale (or auto-reindex) so Memory + citations track the active vault automatically.

**SPEC.md is the pre-reframe build plan** (describes the old `me` RAG workspace + "RAG memory NOT built"
+ a 4B trainable base). README is current; SPEC should get a "superseded - see README" banner + the
Memory/`me`-workspace and base-picker lines corrected.

## 6. macOS connectors (Phase B) - SHIPPED + deferred coverage notes

Shipped: Calendar (.ics folder), Mail (.emlx folder), Contacts (AddressBook abcddb), Browser history
(Chromium-family SQLite; Safari path-ready), Messages (chat.db + attributedBody decode). All read-only,
on-device, copy-to-tmp for SQLite (dodges the live lock; EPERM on copy -> Full Disk Access prompt), epoch
math done in SQL (no BigInt overflow), build-then-swap + stable-id reindex + opt-in auto-sync. "Connect
your Mac" button row in Settings > Memory & Sync. Triple-reviewed: security clean, no P0/P1.

**Deferred coverage notes (quality, not correctness; from the connector review):**
- Messages with an ATTACHMENT whose `text` is null: the attributedBody's first `NSString` marker is often
  the U+FFFC object-replacement placeholder, so the decoder returns "" and that message is skipped. Read
  the next marker (the real caption) to cover attachment messages. (`os-stores.js decodeAttributedBody`)
- Multipart-MIME `.emlx` bodies leak boundary markers (`--BOUND Content-Type: ...`) into the snippet
  instead of extracting the `text/plain` part. (`context.js normalizeEmlx`)
- `decodeAttributedBody` handles 1-byte / 0x81 / 0x82 length prefixes; the 0x83 (4-byte, strings >= 64KB)
  prefix is unhandled - not realistic for a single message, left as-is.
- Privacy copy: `context.search` IS tunnel-allowed, so a paired satellite device can query the master's
  indexed Messages/Mail (by design, gated by the pairing-key bearer capability). Worth a one-line note in
  the Devices/privacy UI: "a device you pair can query your indexed sources."

**Next connectors (Phase C+):** PDF/docx (needs a parser dep, breaks the zero-dep rule - decide), Photos
(captions/EXIF + on-device OCR), Notes.app (NoteStore SQLite + gzipped protobuf bodies).
