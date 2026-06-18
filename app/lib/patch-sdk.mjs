// Unlock all 18 TTS languages the QVAC TTS package actually supports. The SDK ships a zod enum
// (dist/schemas/text-to-speech.js) capped at en/es/de/it, which the SDK team confirmed is a
// schema-validation bug, not a model limit ("patch locally to bypass it; we will fix it in the SDK").
// The validation also runs in the SDK worker (which re-imports from disk), so the patch must live
// ON DISK. Idempotent; re-run after any `npm install` (server boot calls it first, before any SDK import).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const LANGS = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["tr", "Turkish"], ["sv", "Swedish"],
  ["da", "Danish"], ["fi", "Finnish"], ["no", "Norwegian"], ["el", "Greek"], ["ms", "Malay"],
  ["sw", "Swahili"], ["ar", "Arabic"], ["ko", "Korean"],
];

function resolveSchemaFile() {
  const require = createRequire(import.meta.url);
  const main = require.resolve("@qvac/sdk");
  const root = main.slice(0, main.indexOf("@qvac/sdk") + "@qvac/sdk".length);
  return path.join(root, "dist", "schemas", "text-to-speech.js");
}

export function patchSdkTtsLanguages() {
  let file;
  try { file = resolveSchemaFile(); } catch { console.error("[patch-sdk] could not resolve @qvac/sdk"); return false; }
  if (!existsSync(file)) { console.error("[patch-sdk] schema file not found:", file); return false; }
  const src = readFileSync(file, "utf8");
  const arrayLiteral = "export const TTS_LANGUAGES = [\n" +
    LANGS.map(([code, name]) => `    "${code}", // ${name}`).join("\n") + "\n];";
  const current = (src.match(/export const TTS_LANGUAGES = \[([\s\S]*?)\];/) || [])[1] || "";
  const codeCount = (current.match(/"[a-z]{2}"/g) || []).length;
  if (codeCount >= LANGS.length) return true; // already patched
  if (!/export const TTS_LANGUAGES = \[[\s\S]*?\];/.test(src)) { console.error("[patch-sdk] TTS_LANGUAGES block not found; SDK layout changed."); return false; }
  writeFileSync(file, src.replace(/export const TTS_LANGUAGES = \[[\s\S]*?\];/, arrayLiteral));
  console.log(`[patch-sdk] unlocked ${LANGS.length} TTS languages.`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) patchSdkTtsLanguages();
