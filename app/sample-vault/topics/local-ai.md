# Local AI

I keep coming back to one idea: the most personal software should run on the device that holds the personal data. Cloud AI is convenient, but every prompt is a copy of my thinking sent to someone else's computer. On-device models flip that. The model comes to my data, not the other way around.

This is the whole reason I started [[projects/second-self-app]]. A model that knows me has to be trained on things I would never upload: my notes, my chats, my drafts. So the training has to happen locally too, not just the inference.

What changed my mind that this is now practical:
- Small models got good. A 1.7B to 4B model, fine-tuned on a person, is genuinely useful for voice and recall.
- Fine-tuning moved on-device. You can train a LoRA adapter on a laptop GPU in an evening.
- Retrieval covers the facts the small model cannot memorize. The model supplies the voice, the vault supplies the truth.

The honest tradeoff: a small local model is not a frontier brain. It is a stylistic echo with a good memory. Designed around that, it overdelivers. Pretending it is GPT-scale, it disappoints. I would rather ship the honest version.

#topic #ai #privacy
