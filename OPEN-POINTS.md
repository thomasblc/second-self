# Open points

Things deliberately left open, with enough context to act on cold. Nothing here blocks shipping the app today.

## 1. Fine-tuning a base bigger than 1.7B

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

**What we found (exhaustively probed, see `spike/probe-finetune.mjs` + memory):** the SDK finetuner gates on BOTH architecture and quantization:
- Accepted quant: `F32 / F16 / Q4_0 / Q8_0 / TQ1_0 / TQ2_0`. **`Q4_K_M` (file_type 15) and `Q4_1` (file_type 3) are rejected.**
- Accepted architectures observed: **Qwen3, Gemma**. **Llama is rejected** (`Finetuning is not supported for architecture: llama`).
- Filenames lie: `QWEN3_4B_INST_Q4_SHARD` ("Q4_0") is actually Q4_K_M; `SALAMANDRATA_2B_INST_Q4` ("q4") is actually Q4_1. Always probe, don't trust the label.

**Consequence:** the only **relevant, general-purpose, fine-tunable** bases in the current SDK are **Qwen3 0.6B and 1.7B** (genuine Q4_0). Every Qwen3 4B/8B build is Q4_K_M (not fine-tunable). The only fine-tunable ~4B is `MEDGEMMA_4B_IT_Q8_0` — a **medical** Gemma-3-4B, which we do not use as a personal-voice base (and its run also destabilized: train loss 2.5 -> 3.9 over one epoch). So **Qwen3-1.7B is the production voice** (proven GO, coherent in-register, shipped in the Voice picker).

**Largest fine-tunable base today = BitNet-b1.58 3B (TQ2_0), non-medical, wired in.** For a fine-tunable **4B/8B Qwen3** specifically, the ask for the QVAC team: publish Qwen3-4B/8B in a fine-tunable quant (Q4_0 or Q8_0), and/or add Llama-architecture fine-tune support. The moment such a constant exists, wiring it is a one-liner: add it to `BASES` in `spike/finetune.js` + `app/lib/models.js` and to `CURATED` (group `voice`, `fineTunable:true`) in `app/lib/catalog.js`. The training pipeline, supervisor, and Voice toggle already handle any base generically (as BitNet-3B just proved).

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
