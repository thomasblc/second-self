// OS data-store connectors for the personal context engine. Each reads a native macOS store
// READ-ONLY and on-device, and returns plain { source, text } lines the embedder can index.
// Browser history, Contacts and Messages are SQLite; Apple Mail is a folder of .emlx files
// (handled by the folder walker via normalizeEmlx, not here). Nothing ever leaves the machine.
//
// Reads are done from a COPY of the DB (the caller copies it to tmp first): this dodges the live
// app's write lock and, for TCC-protected stores (Messages, Contacts), surfaces the permission
// denial as an EPERM on copy which the caller turns into a Full Disk Access prompt. Apple stores
// time as huge epoch integers (WebKit microseconds-since-1601, Mac nanoseconds-since-2001); we
// convert them INSIDE the SQL so the raw value never overflows a JS Number.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_TYPES = new Set(["browser", "contacts", "messages"]);
const HOME = os.homedir();
const MAX_ROWS = 5000; // cap per store so a huge history/chat archive stays bounded

// ---- candidate store paths. First existing wins; if none exist we still return the primary so
// the caller can attempt it and produce a clean "not found" (or FDA) error rather than null. ----
const BROWSER_CANDIDATES = [
  "Library/Application Support/Google/Chrome/Default/History",
  "Library/Application Support/BraveSoftware/Brave-Browser/Default/History",
  "Library/Application Support/Microsoft Edge/Default/History",
  "Library/Application Support/Arc/User Data/Default/History",
  "Library/Application Support/Vivaldi/Default/History",
  "Library/Application Support/Chromium/Default/History",
].map((p) => path.join(HOME, p));

function contactsCandidates() {
  const base = path.join(HOME, "Library", "Application Support", "AddressBook", "Sources");
  try {
    return fs.readdirSync(base)
      .map((d) => path.join(base, d, "AddressBook-v22.abcddb"))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  } catch { return []; }
}

const existsSafe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// Resolve the on-disk store for a connector type. Returns an absolute path or null if none plausible.
export function resolveStorePath(type) {
  if (type === "mail") { const p = path.join(HOME, "Library", "Mail"); return existsSafe(p) ? p : null; }
  let cands = [];
  if (type === "browser") cands = BROWSER_CANDIDATES;
  else if (type === "messages") cands = [path.join(HOME, "Library", "Messages", "chat.db")];
  else if (type === "contacts") cands = contactsCandidates();
  return cands.find(existsSafe) || cands[0] || null;
}

// ---- helpers ----
const ymd = (unix) => { try { return new Date(unix * 1000).toISOString().slice(0, 10); } catch { return ""; } };
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return (url || "").slice(0, 40); } };
// A readable URL for context: drop the query string (tracking noise) and cap length, so a single
// 1000-char tracking link can't dominate a chunk or overflow the embedder.
const tidyUrl = (url) => { try { const u = new URL(url); return (u.origin + u.pathname).slice(0, 120); } catch { return String(url || "").split("?")[0].slice(0, 120); } };
function groupBy(rows, keyField, valField) {
  const out = {};
  for (const r of rows) { const k = r[keyField]; if (k == null) continue; (out[k] ??= []).push(r[valField]); }
  return out;
}

// Read a copied SQLite store (read-only) and return [{ source, text }]. Throws on a corrupt/locked DB.
export function readStore(type, dbPath, max = MAX_ROWS) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (type === "browser") return readBrowser(db, max);
    if (type === "contacts") return readContacts(db, max);
    if (type === "messages") return readMessages(db, max);
    throw new Error("unknown sqlite store: " + type);
  } finally { db.close(); }
}

// Chromium-family History: urls(url, title, visit_count, last_visit_time microseconds-since-1601).
function readBrowser(db, max) {
  const rows = db.prepare(
    "SELECT url, title, visit_count, (last_visit_time/1000000 - 11644473600) AS visit_unix " +
    "FROM urls WHERE title IS NOT NULL AND title <> '' ORDER BY last_visit_time DESC LIMIT ?"
  ).all(max);
  return rows.map((r) => ({
    source: (r.title || hostOf(r.url)).slice(0, 80),
    text: `Visited "${(r.title || "").slice(0, 160)}" (${hostOf(r.url)}) on ${ymd(r.visit_unix)}${r.visit_count > 1 ? `, ${r.visit_count} times` : ""} - ${tidyUrl(r.url)}`,
  }));
}

// AddressBook abcddb: ZABCDRECORD (people) + ZABCDEMAILADDRESS / ZABCDPHONENUMBER joined by ZOWNER.
function readContacts(db, max) {
  const recs = db.prepare(
    "SELECT Z_PK pk, ZFIRSTNAME f, ZLASTNAME l, ZORGANIZATION org, ZNICKNAME nick FROM ZABCDRECORD " +
    "WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL LIMIT ?"
  ).all(max);
  const emails = groupBy(db.prepare("SELECT ZOWNER o, ZADDRESS a FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all(), "o", "a");
  const phones = groupBy(db.prepare("SELECT ZOWNER o, ZFULLNUMBER a FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all(), "o", "a");
  return recs.map((r) => {
    const name = [r.f, r.l].filter(Boolean).join(" ") || r.nick || r.org || "";
    if (!name) return null;
    const parts = [`Contact: ${name}`];
    if (r.org && r.org !== name) parts.push(r.org);
    const em = emails[r.pk]; if (em && em.length) parts.push(em.join(", "));
    const ph = phones[r.pk]; if (ph && ph.length) parts.push(ph.join(", "));
    return { source: name, text: parts.join(" | ") };
  }).filter(Boolean);
}

// Messages chat.db: message(text, attributedBody, date, is_from_me, handle_id) + handle(id).
// `date` is ns-since-2001 on modern macOS (seconds on very old ones); content lives in `text`,
// or in the attributedBody typedstream blob when the message carried rich content.
function readMessages(db, max) {
  const rows = db.prepare(
    "SELECT m.text AS text, m.attributedBody AS body, m.is_from_me AS me, h.id AS handle, " +
    "CASE WHEN m.date > 1000000000000 THEN m.date/1000000000 + 978307200 ELSE m.date + 978307200 END AS unix " +
    "FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID ORDER BY m.date DESC LIMIT ?"
  ).all(max);
  const out = [];
  for (const r of rows) {
    const content = (r.text && r.text.trim()) ? r.text.trim() : decodeAttributedBody(r.body);
    if (!content) continue;
    const who = r.me ? "Me" : (r.handle || "Them");
    out.push({ source: r.handle || "Messages", text: `${ymd(r.unix)} ${who}: ${content}` });
  }
  return out;
}

// Extract the plain text from an NSAttributedString typedstream blob (what Messages stores in
// attributedBody when `text` is null). The string follows the "NSString" class marker and a 0x2b
// ('+') tag, then a variable-length count (1 byte; or 0x81/0x82 prefix for 2/3-byte little-endian).
export function decodeAttributedBody(blob) {
  if (!blob || !blob.length) return "";
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const s = buf.toString("latin1");
  let i = s.indexOf("NSString");
  if (i < 0) return "";
  i = s.indexOf("+", i);
  if (i < 0) return "";
  let p = i + 1;
  let len = buf[p];
  if (len === 0x81) { len = buf[p + 1] | (buf[p + 2] << 8); p += 3; }
  else if (len === 0x82) { len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16); p += 4; }
  else { p += 1; }
  if (!(len > 0) || p + len > buf.length) return "";
  return buf.subarray(p, p + len).toString("utf8").replace(/￼/g, "").trim(); // drop object-replacement chars
}
