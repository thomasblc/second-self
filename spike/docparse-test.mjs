// Unit tests for the binary-document extractors (no models needed).
//   node spike/docparse-test.mjs
import zlib from "node:zlib";
import { parseDocx, parsePdf } from "../app/lib/docparse.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

// Build a minimal ZIP with STORED (uncompressed) entries - enough to exercise the central-directory
// reader in docparse without pulling in a zip lib. (parseDocx also handles deflate in the wild.)
function buildZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : 0; // crc not validated by the reader
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); /* stored */ local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const localOff = offset;
    chunks.push(local, nameBuf, data); offset += 30 + nameBuf.length + data.length;
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10); cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(localOff, 42);
    central.push(cen, nameBuf);
  }
  const cdStart = offset;
  const cdBufs = central.slice(); let cdSize = 0; for (const b of cdBufs) cdSize += b.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...cdBufs, eocd]);
}

// ---- docx ----
{
  const docXml = `<?xml version="1.0"?><w:document xmlns:w="ns"><w:body><w:p><w:r><w:t>Quarterly review with Mallory</w:t></w:r></w:p><w:p><w:r><w:t>Budget</w:t><w:tab/><w:t>approved &amp; signed</w:t></w:r></w:p></w:body></w:document>`;
  const docx = buildZip([["[Content_Types].xml", "<Types/>"], ["word/document.xml", docXml]]);
  const text = parseDocx(docx);
  ok(/Quarterly review with Mallory/.test(text), "docx: paragraph text extracted");
  ok(text.includes("Budget\tapproved & signed"), "docx: tab + &amp; entity decoded");
  ok(parseDocx(Buffer.from("not a zip at all")) === "", "docx: non-zip -> '' (no throw)");
  ok(parseDocx(buildZip([["other.xml", "<x/>"]])) === "", "docx: zip without word/document.xml -> ''");

  // decompression bomb: a tiny deflate entry that inflates past the cap must be skipped, not hang/OOM
  const huge = Buffer.alloc(80 * 1024 * 1024, 0x20); // 80 MB > the 64 MB inflate cap
  const comp = zlib.deflateRawSync(huge);
  const nb = Buffer.from("word/document.xml");
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(huge.length, 22); lh.writeUInt16LE(nb.length, 26);
  const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(8, 10); ce.writeUInt32LE(comp.length, 20); ce.writeUInt32LE(huge.length, 24); ce.writeUInt16LE(nb.length, 28); ce.writeUInt32LE(0, 42);
  const bomb = Buffer.concat([lh, nb, comp, ce, nb, (() => { const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(46 + nb.length, 12); e.writeUInt32LE(30 + nb.length + comp.length, 16); return e; })()]);
  ok(parseDocx(bomb) === "", "docx: decompression bomb capped -> '' (not inflated to GBs)");
}

// ---- pdf (a minimal hand-built text PDF; pdf.js recovers from the loose structure) ----
{
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 70>>stream
BT /F1 18 Tf 72 700 Td (Second Self invoice total 4242 dollars) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
  try {
    const text = await parsePdf(Buffer.from(body, "latin1"));
    ok(typeof text === "string", `pdf: parser returns a string (${text.length} chars)`);
    ok(/Second Self invoice total 4242/.test(text), "pdf: text-layer content extracted");
  } catch (e) { ok(false, "pdf: parser threw: " + e.message); }
  // a non-PDF buffer must reject/throw, caught by the caller (never crash the build)
  let threw = false; try { await parsePdf(Buffer.from("not a pdf")); } catch { threw = true; }
  ok(threw, "pdf: invalid input throws (caller skips the file)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
