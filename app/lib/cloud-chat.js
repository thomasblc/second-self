// Import cloud LLM conversation exports (ChatGPT / Claude.ai) into the vault as markdown
// notes, so the graph + training corpus capture what the user has been working on with
// those assistants. Tolerant of both common export shapes. All local: reads a file the
// user exported and points at; writes notes into the vault. Nothing is uploaded.
import fs from "node:fs";
import path from "node:path";

function safeName(s) {
  return String(s || "untitled").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
}
function isoDate(t) {
  // ChatGPT uses seconds, Claude uses ISO strings
  try { const d = typeof t === "number" ? new Date(t * 1000) : new Date(t); return d.toISOString().slice(0, 10); } catch { return ""; }
}

// ChatGPT conversations.json: [{ title, create_time, mapping: { id: { message: {author:{role}, content:{parts|text}, create_time} } } }]
function fromChatGPT(conv) {
  const msgs = [];
  const mapping = conv.mapping || {};
  for (const k of Object.keys(mapping)) {
    const m = mapping[k]?.message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    const c = m.content;
    if (c?.parts) text = c.parts.filter((p) => typeof p === "string").join("\n");
    else if (typeof c?.text === "string") text = c.text;
    if (text.trim()) msgs.push({ role, text: text.trim(), t: m.create_time });
  }
  msgs.sort((a, b) => (a.t || 0) - (b.t || 0));
  return { title: conv.title, date: isoDate(conv.create_time), msgs };
}

// Claude export: [{ name|title, created_at, chat_messages:[{sender|role, text|content, created_at}] }]
function fromClaude(conv) {
  const raw = conv.chat_messages || conv.messages || [];
  const msgs = raw.map((m) => {
    const role = (m.sender || m.role || "").toLowerCase() === "assistant" ? "assistant" : (m.sender || m.role || "").toLowerCase() === "human" || (m.sender || m.role) === "user" ? "user" : "user";
    let text = m.text;
    if (!text && Array.isArray(m.content)) text = m.content.map((p) => p.text || "").join("\n");
    if (!text && typeof m.content === "string") text = m.content;
    return { role, text: (text || "").trim(), t: m.created_at };
  }).filter((m) => m.text);
  return { title: conv.name || conv.title, date: isoDate(conv.created_at), msgs };
}

function toMarkdown(c, source) {
  const lines = [`# ${c.title || "Conversation"}`, "", `> Imported from ${source}${c.date ? " · " + c.date : ""}`, ""];
  for (const m of c.msgs) {
    lines.push(`**${m.role === "assistant" ? "Assistant" : "Me"}:** ${m.text}`, "");
  }
  lines.push(`#imported #${source}`);
  return lines.join("\n");
}

// Parse an export file into [{ title, date, msgs }]. Detects ChatGPT vs Claude by shape.
export function parseExport(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch { throw new Error("not valid JSON (export the conversations.json from your account)"); }
  const arr = Array.isArray(data) ? data : (data.conversations || []);
  if (!Array.isArray(arr) || !arr.length) throw new Error("no conversations found in the file");
  const out = [];
  let source = "cloud";
  for (const conv of arr) {
    if (conv.mapping) { source = "chatgpt"; out.push(fromChatGPT(conv)); }
    else if (conv.chat_messages || conv.messages) { source = "claude"; out.push(fromClaude(conv)); }
  }
  return { source, conversations: out.filter((c) => c.msgs.length) };
}

// Import an export file into the vault under <vaultRoot>/<destFolder>/. Returns counts.
export function importCloudExport(filePath, vault, destFolder = "imported") {
  const text = fs.readFileSync(filePath, "utf8");
  const { source, conversations } = parseExport(text);
  let written = 0;
  const used = new Set();
  for (const c of conversations) {
    let base = safeName(c.title);
    let rel = path.join(destFolder, source, `${base}.md`);
    let n = 1;
    while (used.has(rel)) { rel = path.join(destFolder, source, `${base}-${++n}.md`); }
    used.add(rel);
    try { vault.write(rel, toMarkdown(c, source)); written++; } catch { /* skip bad */ }
  }
  return { source, conversations: conversations.length, written, folder: path.join(destFolder, source) };
}
