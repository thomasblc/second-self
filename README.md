# Second Self

**An open-source second brain that learns to talk like you, and knows what you know. Your notes, your model, your machine. Nothing is ever uploaded.**

Second Self is a local, Obsidian-style notes vault that can also train a small AI model on you. Write and link your notes, watch the app draw a semantic graph of how they connect, let it pick the notes worth learning from, and fine-tune a LoRA adapter that writes in your voice. Then chat with it: a **Voice** toggle loads your adapter, a **Memory** toggle retrieves from your notes. Ingestion, training, and inference all run on your hardware through the [QVAC SDK](https://github.com/tetherto/qvac). The only network call in the whole app is the first-run model download.

> Think of it as an open, self-hosted Apple Intelligence: your context, your model, your hardware.

## What it does

- **A real notes vault.** Create, edit, rename, search and link markdown notes with `[[wikilinks]]`. Live preview with callouts, tables, task lists and tags. Backlinks. Collapsible folder tree. Autosave.
- **A knowledge graph.** Every note is a node. Edges come from your links, shared tags, and on-device **embedding similarity**, so related notes connect even when you never linked them. Hover to explore, drag to rearrange.
- **Natural-language highlight.** Type "highlight notes about travel" and the model lights up the matching notes on the graph.
- **Auto-selection.** The app embeds your vault and proposes which notes are worth training a voice from (you can adjust by shift-clicking nodes).
- **On-device LoRA training.** One click fine-tunes a small base model (Qwen3 0.6B or 1.7B, Q4_0) on your selected notes, with a live loss/ETA panel. The output is one small adapter file you own.
- **A model picker.** Browse QVAC-SDK-compatible models (fine-tunable voice bases, chat models, and embedders) with their Hugging Face links and sizes, download any of them in one click with a progress bar, and delete to reclaim disk. Everything caches in `~/.qvac/models`, shared across the app.
- **Chat with your second self.** Switch between the base model and your fine-tuned one, and toggle **Voice** (your LoRA) and **Memory** (retrieval over your vault) to feel the difference.
- **An agent that knows your vault.** Turn on **Agent** mode and the model can search, read (and, with read+edit permission, write) your notes when you ask. Permission levels (read-only / read+edit) keep you in control; vault tools run locally, only completions use the model.
- **Remote inference over P2P.** "Share this machine's GPU" turns a spare machine (e.g. a Mac mini) into a QVAC provider; "Connect to a remote machine" delegates your chat + agent completions to it over the P2P DHT, while your vault stays on your laptop. Headless host: `npm run provide`.
- **Hardware-aware model picks.** The Models pane detects your RAM/GPU and recommends which model you can comfortably run and train, with per-model fit badges.
- **Vault that stays current.** External edits or a folder synced via iCloud/Dropbox/git refresh the tree + graph live. Import your ChatGPT / Claude conversation exports as notes to enrich the graph.
- **Three themes** (dark, light, and a QVAC-brand "original"), a **command palette** (Cmd/Ctrl+K), a quick switcher (Cmd/Ctrl+O), and a first-run tour.

> Fine-tuning needs a Q4_0 / Q8_0 / F16 base. In the current SDK the Qwen3 4B/8B builds are Q4_K_M (not fine-tunable), so the trainable bases are Qwen3 0.6B and 1.7B (Q4_0); 1.7B is the recommended, proven one. Larger Q4_K_M models are great to chat with but can't be fine-tuned yet.

## Quickstart

Requirements: Node.js 22+ and a GPU-capable machine (Apple Silicon / Metal, or a Vulkan GPU on Linux/Windows). CPU works for inference but training is slow. About 5 to 10 GB of free disk for the models, checkpoints and adapters.

```bash
npm install
npm start
# open http://localhost:3090
```

The app opens on a small demo vault so you can try everything immediately. Point it at your own folder from Settings (gear icon) whenever you like, or set one up front:

```bash
SECOND_SELF_VAULT="/path/to/your/notes" npm start
```

First training run or first chat downloads the base model into `~/.qvac/models` (cached after that). Check your hardware first; on macOS an out-of-memory load can hard-crash the OS, so start with a small base.

## How it works

```
Frontend (browser, vanilla JS)            Backend (Node + @qvac/sdk + ws)
  Vault: editor + preview + search          vault: markdown file ops (sandboxed)
  Graph + Train: force graph, auto-select   graph: link / tag / embed-similarity edges
  Chat: Base vs Fine-tuned, Voice, Memory   models: loadModel / embed / completion / RAG
        |  WebSocket (ops, progress, tokens) train: finetune() -> versioned LoRA adapter
```

- **The vault** is just a folder of markdown files. The app never moves your data; reads and writes are sandboxed to the vault root (symlinks that escape it are refused).
- **The graph** is built from your links and tags, then enriched with cosine similarity over on-device embeddings (`EmbeddingGemma 300M`).
- **Training** runs the QVAC SDK `finetune()` in a child process and produces a `.gguf` LoRA adapter, copied to `adapters/<base>-<date>.gguf`.
- **Chat** loads the base model (optionally with your adapter via `modelConfig.lora`) and, when Memory is on, injects the top retrieval hits as grounding before generating.

The wedge is the combination: a LoRA carries your *voice*, retrieval supplies your *facts*. A small local model in your voice with your facts retrieved is genuinely useful. That is the thing a retrieval-only second brain cannot do, and a cloud "AI clone" cannot honestly promise.

## Keyboard

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Command palette |
| `Cmd/Ctrl + O` | Quick switch to a note |
| `Cmd/Ctrl + 1/2/3` | Vault / Graph / Chat |
| `Cmd/Ctrl + S` | Save note |
| `Esc` | Close overlays |

## Privacy

Vault read/write, embeddings, training and inference all run on this machine. No telemetry, no analytics, no account. The single allowed network call is the first-run model download from the QVAC registry. The UI marks the LOCAL / NETWORK boundary so it stays honest.

## Tests

```bash
node app/test-e2e.mjs           # core flows (fast, no model download)
node app/test-e2e.mjs --models  # + embeddings, highlight, select, RAG, chat
node app/test-e2e.mjs --train   # + a tiny on-device LoRA run (slow)
```

The suite spawns the server against a throwaway vault on a test port and drives every flow over the WebSocket protocol.

## Built with QVAC

Second Self runs on the [QVAC SDK](https://github.com/tetherto/qvac) (`@qvac/sdk`, Apache 2.0): `loadModel` (with tool-calling + LoRA + `delegate`), `finetune`, `completion`, `embed`, `ragIngest`/`ragSearch`, `downloadAsset`, and `startQVACProvider` for P2P delegated inference. On-device LLMs, embeddings, fine-tuning, and peer-to-peer model serving in one `npm install`.

### Remote inference (run the model on another machine)

On the machine with the GPU (e.g. a home server):

```bash
npm run provide   # prints a pairing code (its public key). Keep it running.
```

In Second Self on your laptop: Settings -> "Connect to a remote machine" -> paste the code. Your chat and agent completions now run on that machine; your vault, retrieval, and tools stay local. Set `QVAC_HYPERSWARM_SEED` on the host for a stable pairing code across restarts.

## License

Apache 2.0. See [LICENSE](LICENSE). You are responsible for what you ingest and build, and for having the right to use it.
