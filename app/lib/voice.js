// Voice I/O for Second Self: speak to your agent (Whisper STT) and hear it reply (Chatterbox TTS).
// 100% on-device. Multilingual output (incl. French) requires the TTS language schema patch
// (lib/patch-sdk.mjs, run in _boot.js before the SDK loads). The agent (Qwen3) is multilingual, so
// no translation step is needed: you speak French, it transcribes French, the LLM answers in French,
// and TTS speaks French. Models load lazily into the shared ~/.qvac worker and are cached.
import {
  loadModel, unloadModel, transcribe, textToSpeech,
  WHISPER_BASE_Q8_0, WHISPER_FRENCH_BASE_Q8_0, WHISPER_ITALIAN_BASE_Q8_0, WHISPER_SPANISH_TINY_Q8_0,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0, TTS_S3GEN_MULTILINGUAL_CHATTERBOX,
} from "@qvac/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";

// STT source languages with a cached/available Whisper model.
const STT = { en: WHISPER_BASE_Q8_0, fr: WHISPER_FRENCH_BASE_Q8_0, it: WHISPER_ITALIAN_BASE_Q8_0, es: WHISPER_SPANISH_TINY_Q8_0 };
export const STT_LANGS = Object.keys(STT);
// TTS output languages (unlocked by the schema patch; the multilingual Chatterbox supports these).
export const TTS_LANGS = ["en", "es", "fr", "de", "it", "pt", "nl", "pl", "tr", "sv", "da", "fi", "no", "el", "ms", "ar", "ko"];

const SR = 24000; // Chatterbox sample rate
const VOICE_DIR = path.join(CONFIG_DIR, "voice");
const DEFAULT_REF = path.join(VOICE_DIR, "default-ref-v2.wav"); // v2: long enough for Chatterbox (>5s)

const whisperCache = new Map(); // lang -> modelId
let tts = { key: null, id: null }; // one resident TTS (reference+language are load-time)

function ff(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = ""; p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg failed: " + err.slice(-200)))));
    p.on("error", (e) => reject(new Error("ffmpeg not found: " + e.message)));
  });
}

async function ensureWhisper(lang) {
  if (!STT[lang]) throw new Error(`no speech-recognition model for "${lang}" (have: ${STT_LANGS.join(", ")})`);
  if (whisperCache.has(lang)) return whisperCache.get(lang);
  const id = await loadModel({
    modelSrc: STT[lang], modelType: "whisper",
    modelConfig: { audio_format: "f32le", strategy: "greedy", n_threads: 4, language: lang, temperature: 0.0 },
  });
  whisperCache.set(lang, id);
  return id;
}

// Transcribe an audio file (any ffmpeg-readable format) into text in the given source language.
export async function transcribeFile(inPath, lang = "en") {
  const wav = inPath + ".16k.wav";
  try {
    await ff(["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const id = await ensureWhisper(lang);
    const raw = await transcribe({ modelId: id, audioChunk: wav });
    return String(raw).replace(/\[[A-Z_ ]+\]/g, "").replace(/\s+/g, " ").trim(); // drop [BLANK_AUDIO] etc.
  } finally { try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } catch { /* */ } }
}

// A default reference voice so TTS works out of the box, generated once via macOS `say`. The user
// can later enroll their own voice (pass refPath) to hear replies in their own timbre.
async function ensureDefaultRef() {
  if (fs.existsSync(DEFAULT_REF)) return DEFAULT_REF;
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const aiff = path.join(VOICE_DIR, "_ref.aiff");
  await new Promise((resolve, reject) => {
    // Chatterbox needs > 5s of clean mono speech for the reference, so this line is deliberately long.
    const p = spawn("say", ["-o", aiff, "Hello, this is your second self, and I run entirely on your own machine. Nothing you say or hear ever leaves this device, it all stays private and local. Bonjour, je suis votre second cerveau, je parle votre langue et je reste sur votre ordinateur."]);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("macOS `say` failed (needed once to seed a default voice)"))));
    p.on("error", (e) => reject(new Error("macOS `say` not available: " + e.message)));
  });
  await ff(["-y", "-i", aiff, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", DEFAULT_REF]);
  try { fs.unlinkSync(aiff); } catch { /* */ }
  return DEFAULT_REF;
}

async function dropTts() { if (tts.id) { try { await unloadModel({ modelId: tts.id, clearStorage: false }); } catch { /* */ } } tts = { key: null, id: null }; }

async function ensureTts(lang, refPath) {
  if (!TTS_LANGS.includes(lang)) throw new Error(`TTS does not support language "${lang}"`);
  const ref = refPath && fs.existsSync(refPath) ? refPath : await ensureDefaultRef();
  const key = `${ref}|${lang}`;
  if (tts.key === key && tts.id) return tts.id;
  await dropTts(); // reference + language are load-time, so changing either reloads
  const id = await loadModel({
    modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0.src, modelType: "tts",
    modelConfig: { ttsEngine: "chatterbox", language: lang, s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX.src, referenceAudioSrc: ref, useGPU: true },
  });
  tts = { key, id };
  return id;
}

function pcmToWav(samples, sr) {
  const arr = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  const pcm = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Chatterbox appends low-energy trailing noise; trim leading/trailing silence without cutting speech.
function trimSpeech(samples, sr) {
  const arr = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  const win = Math.max(1, Math.floor(sr * 0.02));
  const frames = Math.floor(arr.length / win);
  if (frames < 10) return arr;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s = 0; const base = f * win; for (let i = 0; i < win; i++) { const v = arr[base + i] / 32768; s += v * v; } rms[f] = Math.sqrt(s / win); }
  const sorted = Float32Array.from(rms).sort();
  const p90 = sorted[Math.floor(frames * 0.9)] || sorted[frames - 1];
  if (p90 <= 0) return arr;
  const thr = Math.max(0.012, p90 * 0.08);
  let first = 0; while (first < frames && rms[first] < thr) first++;
  let last = frames - 1; while (last > first && rms[last] < thr) last--;
  if (last <= first) return arr;
  const s0 = Math.max(0, first - 6) * win;
  const s1 = Math.min(frames, last + 1 + 15) * win;
  const out = arr.subarray(s0, s1);
  return out.length < sr * 0.4 ? arr : out;
}

// Synthesize speech for `text` in `lang`; returns a WAV Buffer. refPath optional (defaults to the seeded voice).
export async function speak(text, lang = "en", refPath = null) {
  const id = await ensureTts(lang, refPath);
  const out = textToSpeech({ modelId: id, text, inputType: "text", stream: false });
  const audio = await out.buffer;
  return pcmToWav(trimSpeech(audio, SR), SR);
}

export async function unloadVoice() { await dropTts(); for (const id of whisperCache.values()) { try { await unloadModel({ modelId: id, clearStorage: false }); } catch { /* */ } } whisperCache.clear(); }
