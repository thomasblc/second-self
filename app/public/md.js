// Compact markdown renderer (no dependency, fully offline). Handles the subset a
// notes vault needs: headings, bold/italic, inline + fenced code, links, [[wikilinks]],
// lists, task checkboxes, blockquotes, wiki-style callouts, tables, hr, paragraphs.
// HTML is escaped first (quotes too), so note content cannot break out of attributes.
const CALLOUT_ICONS = {
  note: "🗒️", info: "ℹ️", tip: "💡", important: "❗", warning: "⚠️",
  danger: "🔥", success: "✅", question: "❓", quote: "❝", bug: "🐞", example: "🧪",
};

export function renderMarkdown(src, { onWikilink = "wikilink" } = {}) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const inline = (s) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => `<span class="md-img">[image: ${a || u}]</span>`);
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, a, u) =>
      /^https?:/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${a}</a>`
        : `<a class="md-link" data-link="${u}">${a}</a>`);
    t = t.replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_, name, label) =>
      `<a class="wikilink" data-${onWikilink}="${name.trim()}">${(label || name).trim()}</a>`);
    t = t.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
    return t;
  };

  const lines = String(src || "").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const out = [];
  let i = 0, inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { out.push("</ul>"); inUl = false; } if (inOl) { out.push("</ol>"); inOl = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^```/.test(line)) {
      closeLists(); const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(esc(lines[i++]));
      i++; out.push(`<pre><code>${buf.join("\n")}</code></pre>`); continue;
    }

    // table: a | row | followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }

    // blockquote / callout block
    if (/^\s*>/.test(line)) {
      closeLists();
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) block.push(lines[i++].replace(/^\s*>\s?/, ""));
      const m = block[0] && block[0].match(/^\[!(\w+)\]([+-]?)\s*(.*)$/);
      if (m) {
        const type = m[1].toLowerCase();
        const icon = CALLOUT_ICONS[type] || "🗒️";
        const title = m[3] || type[0].toUpperCase() + type.slice(1);
        const body = block.slice(1).filter((l) => l.trim()).map((l) => `<p>${inline(l)}</p>`).join("");
        out.push(`<div class="callout callout-${type}"><div class="callout-title">${icon} ${inline(title)}</div>${body ? `<div class="callout-body">${body}</div>` : ""}</div>`);
      } else {
        out.push(`<blockquote>${block.map((l) => inline(l)).join("<br>")}</blockquote>`);
      }
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // task checkbox / bullet list
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      if (!inUl) { closeLists(); out.push(`<ul class="tasks">`); inUl = true; }
      const done = task[1].toLowerCase() === "x";
      out.push(`<li class="task"><input type="checkbox" disabled${done ? " checked" : ""}> <span${done ? ' class="done"' : ""}>${inline(task[2])}</span></li>`);
      i++; continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`); i++; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeLists(); out.push("<hr>"); i++; continue; }
    if (/^\s*$/.test(line)) { closeLists(); i++; continue; }
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeLists();
  return out.join("\n");
}
