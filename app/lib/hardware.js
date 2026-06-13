// Detect the machine and recommend which models it can comfortably RUN (chat) and TRAIN.
// Local LLMs are bound by memory: on Apple Silicon the GPU shares system RAM (unified), so
// RAM is the right proxy. On Linux/Windows discrete VRAM matters but is not auto-detectable
// here, so we estimate from RAM and say so. Heuristics are deliberately conservative.
import os from "node:os";

export function hardwareInfo() {
  const ramGB = os.totalmem() / 2 ** 30;
  const platform = os.platform();
  const arch = os.arch();
  const apple = platform === "darwin" && arch === "arm64";
  const cpus = os.cpus()?.length || 0;
  const gpu = apple ? "Apple Silicon (Metal, unified memory)"
    : platform === "darwin" ? "Intel Mac (CPU / weak GPU)"
    : "discrete GPU via Vulkan if present (not auto-detected)";
  return { ramGB: Math.round(ramGB * 10) / 10, platform, arch, apple, cpus, gpu };
}

// Per-model fit. "ok" = comfortable, "tight" = will work but close, "too-big" = don't.
export function fit(model, hw) {
  const r = hw.ramGB;
  const needRun = model.sizeGB * 1.4 + 1.5;     // weights + KV cache + app headroom
  const needTrain = model.sizeGB * 2.6 + 3;     // base + optimizer/grads + activations
  const run = r >= needRun ? "ok" : (r >= model.sizeGB * 1.1 + 0.5 ? "tight" : "too-big");
  const train = !model.fineTunable ? "n/a"
    : (r >= needTrain ? "ok" : (r >= model.sizeGB * 1.8 + 1.5 ? "tight" : "too-big"));
  return { run, train };
}

// Largest model the machine can run / train comfortably (prefer "ok", fall back to "tight").
export function recommend(models, hw) {
  const bySize = [...models].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const pickRun = bySize.find((m) => fit(m, hw).run === "ok") || bySize.find((m) => fit(m, hw).run === "tight");
  const trainables = bySize.filter((m) => m.fineTunable);
  const pickTrain = trainables.find((m) => fit(m, hw).train === "ok") || trainables.find((m) => fit(m, hw).train === "tight");
  return { chat: pickRun ? pickRun.label : "a smaller model", train: pickTrain ? pickTrain.label : "the 0.6B model" };
}
