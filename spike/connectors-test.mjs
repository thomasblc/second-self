// Unit tests for the OS-store connectors (no models needed; pure parsing + SQLite reads).
// Covers: browser/contacts/messages SQLite readers, the attributedBody typedstream decoder,
// and the .emlx / .ics / .vcf normalizers. Real browser history is read if a browser exists;
// contacts + messages are exercised with synthetic DBs that match the macOS schema.
//   node spike/connectors-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveStorePath, readStore, decodeAttributedBody } from "../app/lib/os-stores.js";
import { normalizeEmlx, normalizeIcs, normalizeVcf } from "../app/lib/context.js";
import { chunkText } from "../app/lib/models.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };
const tmp = (n) => path.join(os.tmpdir(), `ss-conn-${process.pid}-${n}`);

// ---- 1) Browser: real store if present, else a synthetic Chromium-schema DB ----
{
  let dbPath = resolveStorePath("browser");
  let synthetic = false;
  if (!dbPath || !fs.existsSync(dbPath)) {
    synthetic = true; dbPath = tmp("hist.db"); fs.rmSync(dbPath, { force: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INT, typed_count INT, last_visit_time INT, hidden INT)");
    // last_visit_time = microseconds since 1601; pick a value that maps to 2026-06-10
    const t = (Math.floor(Date.UTC(2026, 5, 10) / 1000) + 11644473600) * 1000000;
    db.prepare("INSERT INTO urls VALUES(1,?,?,?,0,?,0)").run("https://docs.qvac.io/sdk", "QVAC SDK docs", 4, BigInt(t));
    db.close();
  }
  let copy = tmp("hist-copy.db"); fs.copyFileSync(dbPath, copy);
  const rows = readStore("browser", copy, 50); fs.rmSync(copy, { force: true });
  if (synthetic) fs.rmSync(dbPath, { force: true });
  ok(rows.length > 0, `browser read ${rows.length} rows (${synthetic ? "synthetic" : "real store"})`);
  ok(/Visited ".*" \(.*\) on \d{4}-\d{2}-\d{2}/.test(rows[0].text), "browser line: title + host + date");
}

// ---- 2) Contacts: synthetic AddressBook abcddb ----
{
  const db = tmp("contacts.abcddb"); fs.rmSync(db, { force: true });
  const c = new DatabaseSync(db);
  c.exec("CREATE TABLE ZABCDRECORD(Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT)");
  c.exec("CREATE TABLE ZABCDEMAILADDRESS(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT)");
  c.exec("CREATE TABLE ZABCDPHONENUMBER(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT)");
  c.exec("INSERT INTO ZABCDRECORD VALUES(1,'Marco','Rossi','Acme Eng',NULL),(2,NULL,NULL,'Solo Org',NULL),(3,NULL,NULL,NULL,NULL)");
  c.exec("INSERT INTO ZABCDEMAILADDRESS VALUES(1,1,'marco@acme.io'),(2,1,'m.rossi@gmail.com')");
  c.exec("INSERT INTO ZABCDPHONENUMBER VALUES(1,1,'+39 333 1234')");
  c.close();
  const copy = tmp("contacts-copy.abcddb"); fs.copyFileSync(db, copy);
  const rows = readStore("contacts", copy, 100); fs.rmSync(copy, { force: true }); fs.rmSync(db, { force: true });
  ok(rows.length === 2, `contacts: 2 named records (the all-null row dropped), got ${rows.length}`);
  const marco = rows.find((r) => r.text.includes("Marco Rossi"));
  ok(marco && /Contact: Marco Rossi \| Acme Eng \| marco@acme\.io, m\.rossi@gmail\.com \| \+39 333 1234/.test(marco.text), "contact: name|org|emails|phone");
}

// ---- 3) Messages: synthetic chat.db with a plain-text row + an attributedBody-only row ----
{
  const db = tmp("chat.db"); fs.rmSync(db, { force: true });
  const body = "rich-text only message body";
  const pre = Buffer.from("streamtyped...NSString\x01\x94\x84\x01\x2b", "latin1");
  const blob = Buffer.concat([pre, Buffer.from([body.length]), Buffer.from(body, "utf8"), Buffer.from("\x86\x84", "latin1")]);
  const m = new DatabaseSync(db);
  m.exec("CREATE TABLE handle(ROWID INTEGER PRIMARY KEY, id TEXT)");
  m.exec("CREATE TABLE message(ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER)");
  m.prepare("INSERT INTO handle VALUES(1,?)").run("+15551234567");
  m.prepare("INSERT INTO message VALUES(1,?,NULL,?,0,1)").run("lunch at 1?", 700000000n * 1000000000n);
  m.prepare("INSERT INTO message VALUES(2,NULL,?,?,1,1)").run(blob, 700000001n * 1000000000n);
  m.prepare("INSERT INTO message VALUES(3,NULL,NULL,?,0,1)").run(700000002n * 1000000000n); // empty -> dropped
  m.close();
  const copy = tmp("chat-copy.db"); fs.copyFileSync(db, copy);
  const rows = readStore("messages", copy, 100); fs.rmSync(copy, { force: true }); fs.rmSync(db, { force: true });
  ok(rows.length === 2, `messages: 2 non-empty rows (empty dropped), got ${rows.length}`);
  ok(rows.some((r) => /Me: rich-text only message body/.test(r.text)), "attributedBody blob decoded");
  ok(rows.some((r) => /\+15551234567: lunch at 1\?/.test(r.text)), "plain text + real handle as sender");
  ok(rows.every((r) => /^\d{4}-\d{2}-\d{2} /.test(r.text)), "ns-since-2001 date converted to a real date");
}

// ---- 4) decodeAttributedBody edge cases ----
ok(decodeAttributedBody(null) === "" && decodeAttributedBody(undefined) === "", "decode: null/undefined -> ''");
ok(decodeAttributedBody(Buffer.from("no marker here")) === "", "decode: missing NSString marker -> ''");
{
  const long = "x".repeat(200);
  const pre = Buffer.from("NSString\x01\x94\x84\x01\x2b", "latin1");
  const blob = Buffer.concat([pre, Buffer.from([0x81, long.length & 0xff, (long.length >> 8) & 0xff]), Buffer.from(long, "utf8")]);
  ok(decodeAttributedBody(blob) === long, "decode: 0x81 two-byte length prefix");
}

// ---- 5) normalizeEmlx ----
{
  const emlx = `1234
From: Alice <alice@example.com>
To: bob@example.com
Subject: Q3 planning notes
Date: Mon, 10 Jun 2026 09:00:00 +0000
Content-Type: text/plain

Let's lock the roadmap before the offsite. Budget is approved.
<?xml version="1.0"?><plist></plist>`;
  const line = normalizeEmlx(emlx);
  ok(/^Email: Q3 planning notes/.test(line), "emlx: subject first");
  ok(/from: Alice <alice@example\.com>/.test(line) && /to: bob@example\.com/.test(line), "emlx: from + to");
  ok(/lock the roadmap/.test(line) && !/<plist>/.test(line) && !/<\?xml/.test(line), "emlx: body snippet, plist trailer stripped");
  ok(normalizeEmlx("garbage with no headers") === "", "emlx: no headers -> ''");
}

// ---- 6) normalizeIcs / normalizeVcf still correct (regression) ----
ok(/Event: Standup \| when: 2026-06-10 09:30/.test(normalizeIcs("BEGIN:VEVENT\nSUMMARY:Standup\nDTSTART:20260610T093000Z\nEND:VEVENT")), "ics still normalizes");
ok(/Contact: Jane Doe \| jane@x\.io/.test(normalizeVcf("BEGIN:VCARD\nFN:Jane Doe\nEMAIL:jane@x.io\nEND:VCARD")), "vcf still normalizes");

// ---- 7) chunkText hard-caps a single giant token (long URL / blob) so it can't overflow the embedder ----
{
  const giant = "https://x.com/?" + "a".repeat(8000); // one 8000-char "word"
  const chunks = chunkText(giant, 120, 20);
  ok(chunks.length > 1 && chunks.every((c) => c.length <= 1200), `giant single token split into ${chunks.length} capped chunks`);
  ok(chunkText("just a few normal words here", 120, 20).length === 1, "short text stays one chunk");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
