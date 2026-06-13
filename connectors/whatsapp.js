// WhatsApp chat export parser (_chat.txt) -> normalized records for the SFT builder.
// Handles both export dialects:
//   iOS:     [12/06/2026, 14:32:11] Thomas: message text
//   Android: 12/06/2026, 14:32 - Thomas: message text
// Lines without a timestamp prefix are continuations of the previous message.
// System/media lines (encryption notice, "image omitted", deletions...) are dropped.
// Everything is read locally; nothing leaves the machine.
//
// CLI:
//   node connectors/whatsapp.js <path/to/_chat.txt>                 -> author stats, pick the owner
//   node connectors/whatsapp.js <path/to/_chat.txt> --owner "Name"  -> writes data/whatsapp.{train,eval}.jsonl
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSftRows, splitTrainEval, seededShuffle, writeJsonl } from "../pipeline/build-sft.js";

// iOS variants: "[12/06/2026, 14:32:11]" (EU) and "[6/12/26 2:32:11 PM]" (US, with a
// narrow no-break space U+202F before AM/PM). Date-time separator: comma or space.
const IOS_RE = /^‎?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),? (\d{1,2}:\d{2}(?::\d{2})?(?:[  ]?[AP]M)?)\]\s([^:]+): ?(.*)$/i;
const ANDROID_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),? (\d{1,2}:\d{2}(?:[  ]?[AP]M)?) - ([^:]+): ?(.*)$/i;
// System lines have the timestamp but no "Author:" part (group created, joined, etc.)
const SYSTEM_RE = /^‎?\[?\d{1,2}\/\d{1,2}\/\d{2,4}/;

const DROP_PATTERNS = [
  /end-to-end encrypted/i, /chiffr[ée]es? de bout en bout/i,
  /<attached:/i, /<piece jointe/i, /<pièce jointe/i,
  /\b(image|video|audio|gif|sticker|document|contact card) omitted\b/i,
  /\b(image|vid[ée]o|audio|gif|sticker|document) (omis|omise|absente?)\b/i,
  /missed (voice|video) call/i, /appel (vocal|vid[ée]o) manqu[ée]/i,
  /this message was deleted/i, /vous avez supprim[ée] ce message/i, /ce message a [ée]t[ée] supprim[ée]/i,
  /^null$/i,
  /location: https:\/\/maps/i, /position: https:\/\/maps/i,
];
const looksDroppable = (text) => DROP_PATTERNS.some((re) => re.test(text));
const clean = (s) => s.replace(/[‎‏‪-‮]/g, "").trim();

export function parseWhatsApp(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const records = [];
  let current = null;
  for (const line of raw.split("\n")) {
    const m = line.match(IOS_RE) || line.match(ANDROID_RE);
    if (m) {
      if (current) records.push(current);
      const [, date, time, author, text] = m;
      current = { ts: `${date} ${time}`, author: clean(author), text: clean(text) };
    } else if (SYSTEM_RE.test(line)) {
      // timestamped line with no author part: a system event, drop it
      if (current) { records.push(current); current = null; }
    } else if (current && line.trim()) {
      current.text += "\n" + clean(line); // continuation of a multi-line message
    }
  }
  if (current) records.push(current);
  const kept = records.filter((r) => r.text && !looksDroppable(r.text));
  return { records: kept, dropped: records.length - kept.length };
}

export function authorStats(records) {
  const by = {};
  for (const r of records) { (by[r.author] ??= { messages: 0, chars: 0 }).messages++; by[r.author].chars += r.text.length; }
  return Object.entries(by).map(([author, s]) => ({ author, ...s })).sort((a, b) => b.messages - a.messages);
}

// CLI entry
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const ownerIdx = process.argv.indexOf("--owner");
  const owner = ownerIdx > -1 ? process.argv[ownerIdx + 1] : null;
  if (!file) { console.log('usage: node connectors/whatsapp.js <_chat.txt> [--owner "Name"]'); process.exit(1); }

  const { records, dropped } = parseWhatsApp(file);
  console.log(`parsed ${records.length} messages (${dropped} system/media lines dropped)`);
  console.log("authors:");
  for (const a of authorStats(records)) console.log(`  ${a.author.padEnd(24)} ${String(a.messages).padStart(6)} messages, ${a.chars} chars`);

  if (!owner) { console.log('\nre-run with --owner "<exact author name>" to build the SFT dataset.'); process.exit(0); }

  const turnsIdx = process.argv.indexOf("--turns");
  const budgetIdx = process.argv.indexOf("--budget");
  const maxContextTurns = turnsIdx > -1 ? Number(process.argv[turnsIdx + 1]) : 6;
  const tokenBudget = budgetIdx > -1 ? Number(process.argv[budgetIdx + 1]) : 440;
  const sys = `Tu es ${owner}. Reponds exactement comme ${owner} ecrit dans ses messages: meme langue, meme longueur, meme ton.`;
  const rows = seededShuffle(buildSftRows([records], { owner, systemPrompt: sys, maxContextTurns, tokenBudget }));
  const { train, evals } = splitTrainEval(rows, 0.08);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  writeJsonl(path.join(dir, "whatsapp.train.jsonl"), train);
  writeJsonl(path.join(dir, "whatsapp.eval.jsonl"), evals);
  console.log(`\nSFT rows: ${rows.length} (${train.length} train, ${evals.length} eval)`);
  console.log("wrote data/whatsapp.train.jsonl and data/whatsapp.eval.jsonl");
  console.log("next: node spike/finetune.js --data whatsapp");
}
