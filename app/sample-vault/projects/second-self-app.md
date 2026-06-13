# Second Self (the app)

An open-source second brain that learns to sound like me and remembers what I know, running entirely on my machine. Part note vault, part model trainer, part chat.

The bet, in one line: retrieval is the memory, a small fine-tuned model is the voice, and together they feel like me. See [[topics/local-ai]] for why I think this is finally practical.

## How it fits together
1. I write notes here, linked with [[wikilinks]]. The app builds a graph and draws semantic links between related notes on its own.
2. It auto-selects the notes worth learning my writing from, then trains a LoRA adapter on them.
3. I chat with the result. A Voice toggle loads my adapter, a Memory toggle retrieves from my notes.

## Open questions
- How big a base model is worth the longer training time? Leaning 4B for the desktop, 1.7B for mobile.
- How to make doc selection feel magic and not like a settings panel. [[ideas/atomic-notes]] might be the right unit.

## Near-term tasks
- [x] Vault editor with live preview
- [x] Force-directed graph with hover
- [x] Natural-language highlight
- [ ] Turing game ("guess who wrote it")
- [ ] Mobile viewer that runs the adapter offline

Working closely with [[people/marco]] on the model side.

#project #ai
