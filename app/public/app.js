import { renderMarkdown } from "./md.js";
import { Graph } from "./graph.js";

// ============================================================ WebSocket layer
let ws, seq = 0;
const pending = new Map();
const listeners = new Map();
const statusLine = document.getElementById("status-line");
const $ = (id) => document.getElementById(id);

function on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }
function request(type, payload = {}) {
  const id = "r" + (++seq);
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("Reconnecting to the local server, try again in a moment."));
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, ...payload }));
  });
}
let reconnectTries = 0;
// If the socket keeps failing to reopen (the server restarted under an old tab whose token is now
// stale, or the server is down), tell the user plainly with a one-click reload instead of leaving
// every action to fail with a cryptic "not connected". A reload re-fetches a fresh, valid token.
function showReconnectBanner() {
  if (document.getElementById("reconnect-banner")) return;
  const b = document.createElement("div");
  b.id = "reconnect-banner";
  b.innerHTML = `<span>Lost connection to the local server. It may have restarted.</span><button id="reconnect-reload">Reload</button>`;
  document.body.appendChild(b);
  document.getElementById("reconnect-reload").onclick = () => location.reload();
}
function connect() {
  const tok = window.__SS_TOKEN ? "?t=" + encodeURIComponent(window.__SS_TOKEN) : "";
  ws = new WebSocket(`ws://${location.host}/${tok}`);
  ws.onopen = () => { reconnectTries = 0; document.getElementById("reconnect-banner")?.remove(); statusLine.innerHTML = 'connected <span class="kbd">Cmd K</span>'; };
  ws.onclose = () => {
    // reject every in-flight request so spinners never hang on a dropped connection (review P0-3)
    for (const [, p] of pending) { try { p.reject(new Error("connection closed")); } catch { /* */ } }
    pending.clear();
    reconnectTries++;
    if (reconnectTries >= 3) showReconnectBanner(); // ~4.5s of failed retries -> surface a Reload
    statusLine.textContent = "disconnected, retrying..."; setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.ok !== undefined && m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.ok ? resolve(m.data) : reject(new Error(m.error || "error"));
      return;
    }
    if (m.type && listeners.has(m.type)) for (const fn of [...listeners.get(m.type)]) fn(m);
  };
}
connect();

// ============================================================ toasts
function toast(msg, kind = "") {
  const el = document.createElement("div"); el.className = "toast " + kind; el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 3500);
}

// ============================================================ themes
const THEMES = ["dark", "light", "original"];
function applyTheme(name) {
  if (!THEMES.includes(name)) name = "dark";
  document.documentElement.dataset.theme = name;
  localStorage.setItem("ss-theme", name);
  document.querySelectorAll(".theme-dot").forEach((d) => d.classList.toggle("on", d.dataset.t === name));
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (window._graph) window._graph.setAccent(accent);
}
function cycleTheme() { const cur = localStorage.getItem("ss-theme") || "dark"; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); toast("Theme: " + document.documentElement.dataset.theme); }
applyTheme(localStorage.getItem("ss-theme") || "dark");
document.querySelectorAll(".theme-dot").forEach((d) => d.onclick = () => applyTheme(d.dataset.t));

// ============================================================ pane switching
const panes = { vault: "vault-pane", memory: "memory-pane", graph: "graph-pane", chat: "chat-pane", models: "models-pane" };
function switchPane(name) {
  document.querySelectorAll(".rail-btn[data-pane]").forEach((x) => { const on = x.dataset.pane === name; x.classList.toggle("active", on); if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
  Object.entries(panes).forEach(([k, id]) => $(id).classList.toggle("active", k === name));
  if (name === "graph") { ensureGraph(); sizeGraph(); }
  if (name === "memory") renderSources();
  if (name === "models") ensureModels();
  if (name === "vault" && isNarrow()) vaultPaneEl.classList.toggle("tree-open", !current); // mobile: show files if none open
}
document.querySelectorAll(".rail-btn[data-pane]").forEach((b) => b.onclick = () => switchPane(b.dataset.pane));

// ============================================================ vault state
let files = [];
let byBase = new Map(), byTitle = new Map(), byPath = new Map();
let current = null, dirty = false;
let graphData = null;
const collapsed = new Set(JSON.parse(localStorage.getItem("ss-collapsed") || "[]"));
const readCache = new Map();

function indexFiles() {
  byBase = new Map(); byTitle = new Map(); byPath = new Map();
  for (const f of files) {
    byPath.set(f.path, f);
    byBase.set(f.name.replace(/\.(md|markdown|txt)$/i, "").toLowerCase(), f);
    byTitle.set(f.title.toLowerCase(), f);
  }
}
function resolveLink(target) {
  const t = target.replace(/\\/g, "/").trim();
  if (byPath.has(t)) return byPath.get(t);
  const noExt = t.replace(/\.(md|markdown|txt)$/i, "");
  return byBase.get(noExt.split("/").pop().toLowerCase()) || byTitle.get(noExt.toLowerCase()) || null;
}
async function loadFiles() {
  const d = await request("vault.list");
  files = d.files; indexFiles(); readCache.clear();
  renderTree();
  statusLine.innerHTML = `${files.length} notes <span class="kbd">Cmd K</span>`;
}

// folder tree
function buildTree() {
  const root = { dirs: new Map(), files: [], path: "" };
  for (const f of files) {
    const parts = f.path.split("/"); let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [], path: parts.slice(0, i + 1).join("/"), name: d });
      node = node.dirs.get(d);
    }
    node.files.push(f);
  }
  return root;
}
function renderTree() {
  const el = $("file-list"); el.innerHTML = "";
  const root = buildTree();
  el.appendChild(renderNode(root, true));
}
function renderNode(node, isRoot) {
  const frag = document.createDocumentFragment();
  for (const [name, dir] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrap = document.createElement("div");
    wrap.className = "folder" + (collapsed.has(dir.path) ? " collapsed" : "");
    const row = document.createElement("div"); row.className = "folder-row";
    row.innerHTML = `<span class="caret">&#9662;</span> ${escapeHtml(name)} <span style="color:var(--mut);font-size:10px">${countFiles(dir)}</span>`;
    row.onclick = () => { collapsed.has(dir.path) ? collapsed.delete(dir.path) : collapsed.add(dir.path); localStorage.setItem("ss-collapsed", JSON.stringify([...collapsed])); renderTree(); };
    wrap.appendChild(row);
    const children = document.createElement("div"); children.className = "folder-children";
    children.appendChild(renderNode(dir, false));
    wrap.appendChild(children);
    frag.appendChild(wrap);
  }
  for (const f of node.files.sort((a, b) => a.title.localeCompare(b.title))) frag.appendChild(fileItem(f));
  return frag;
}
function countFiles(dir) { let n = dir.files.length; for (const [, d] of dir.dirs) n += countFiles(d); return n; }
function fileItem(f, search) {
  const div = document.createElement("div");
  div.className = "file-item" + (current === f.path ? " active" : "") + (search ? " search-hit" : "");
  div.innerHTML = `<div>${escapeHtml(f.title)}</div>` + (search && f.snippet ? `<div class="snippet">${escapeHtml(f.snippet)}</div>` : "");
  div.onclick = () => openNote(f.path);
  return div;
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ============================================================ editor
const editor = $("editor"), preview = $("preview"), noteTitle = $("note-title"), saveState = $("save-state");
async function openNote(path) {
  if (!await confirmDiscard()) return;
  clearTimeout(autosaveTimer); // don't let the old note's pending autosave fire after we switch
  const d = await request("vault.read", { path });
  current = path; dirty = false; readCache.set(path, d.content);
  noteTitle.textContent = path; editor.value = d.content;
  renderPreview(); renderBacklinks(path); saveState.textContent = "";
  setEditMode(false); // open in read mode; the Edit button reveals the editor
  renderTree();
  if (!$("vault-pane").classList.contains("active")) switchPane("vault");
  if (isNarrow()) $("vault-pane").classList.remove("tree-open"); // mobile: reveal the editor
}
// Custom in-app confirm (replaces the browser confirm() chrome). Returns a Promise<boolean>.
let _confirmResolve = null;
function confirmModal(message, { title = "Confirm", okLabel = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = message;
    const ok = $("confirm-ok"); ok.textContent = okLabel; ok.classList.toggle("danger", !!danger);
    $("confirm").classList.add("show");
    ok.focus();
  });
}
function closeConfirm(val) { $("confirm").classList.remove("show"); const r = _confirmResolve; _confirmResolve = null; if (r) r(val); }
$("confirm-ok").onclick = () => closeConfirm(true);
$("confirm-cancel").onclick = () => closeConfirm(false);
$("confirm").addEventListener("click", (e) => { if (e.target === $("confirm")) closeConfirm(false); });

async function confirmDiscard() {
  if (!dirty) return true;
  if (await confirmModal("You have unsaved changes in this note. Discard them?", { title: "Discard changes?", okLabel: "Discard", danger: true })) { dirty = false; return true; } // clear dirty so a pending autosave can't fire post-switch
  return false;
}
function renderPreview() {
  preview.innerHTML = renderMarkdown(editor.value);
  preview.querySelectorAll("[data-wikilink]").forEach((a) => {
    a.onclick = () => { const f = resolveLink(a.dataset.wikilink); f ? openNote(f.path) : toast("Note not found: " + a.dataset.wikilink, "warn"); };
    wireHover(a, a.dataset.wikilink);
  });
  preview.querySelectorAll("[data-link]").forEach((a) => {
    a.onclick = () => { const f = resolveLink(a.dataset.link); if (f) openNote(f.path); };
    wireHover(a, a.dataset.link);
  });
}
let previewTimer, autosaveTimer;
editor.addEventListener("input", () => {
  dirty = true; saveState.textContent = "unsaved";
  clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 150);
  clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => { if (dirty && current) saveNote(true); }, 1500);
});
editor.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveNote(); } });
$("btn-save").onclick = () => saveNote();

// read vs edit: notes open in read (preview) mode; the Edit button reveals the textarea.
const editorWrap = $("editor-wrap");
function setEditMode(on) {
  editorWrap.classList.toggle("mode-edit", on);
  editorWrap.classList.toggle("mode-read", !on);
  $("btn-edit-toggle").innerHTML = on ? "&#128065; Read" : "&#9998; Edit";
  if (on) setTimeout(() => editor.focus(), 0);
}
$("btn-edit-toggle").onclick = () => setEditMode(!editorWrap.classList.contains("mode-edit"));

// mobile: the file tree is a slide-over; a hamburger opens it, opening a note closes it
const vaultPaneEl = $("vault-pane");
$("btn-tree").onclick = () => vaultPaneEl.classList.toggle("tree-open");
$("tree-scrim").onclick = () => vaultPaneEl.classList.remove("tree-open");
const isNarrow = () => window.matchMedia && matchMedia("(max-width: 760px)").matches;

async function saveNote(auto) {
  if (!current || !dirty) return;
  await request("vault.write", { path: current, content: editor.value });
  dirty = false; saveState.textContent = auto ? "autosaved" : "saved";
  readCache.set(current, editor.value); graphData = null;
}
$("btn-new").onclick = newNote;
async function newNote() {
  if (!await confirmDiscard()) return;
  const name = prompt("New note path (e.g. ideas/my-note.md):"); if (!name) return;
  const path = name.endsWith(".md") ? name : name + ".md";
  try { await request("vault.create", { path }); dirty = false; await loadFiles(); openNote(path); toast("Created " + path); }
  catch (e) { toast(e.message, "bad"); }
}
$("btn-del").onclick = async () => {
  if (!current) return;
  if (!await confirmModal(`Delete "${current}"? This removes the file from your vault.`, { title: "Delete note?", okLabel: "Delete", danger: true })) return;
  await request("vault.delete", { path: current });
  const gone = current; current = null; dirty = false; editor.value = ""; preview.innerHTML = ""; noteTitle.textContent = "No note open";
  graphData = null; await loadFiles(); toast("Deleted " + gone);
};
function renderBacklinks(path) {
  const el = $("backlinks");
  if (!graphData) { el.innerHTML = ""; return; }
  const back = graphData.edges.filter((e) => e.kind === "link" && (e.source === path || e.target === path)).map((e) => (e.source === path ? e.target : e.source));
  const uniq = [...new Set(back)];
  el.innerHTML = `<h4>Linked notes (${uniq.length})</h4>` + (uniq.length ? uniq.map((p) => `<a data-p="${escapeHtml(p)}">${escapeHtml((byPath.get(p) || {}).title || p)}</a>`).join("") : `<span style="color:var(--mut);font-size:12px">none</span>`);
  el.querySelectorAll("[data-p]").forEach((a) => a.onclick = () => openNote(a.dataset.p));
}

// hover preview of links
const hoverCard = $("hover-card"); let hoverTimer;
function wireHover(el, target) {
  el.addEventListener("mouseenter", (e) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const f = resolveLink(target); if (!f) return;
      let content = readCache.get(f.path);
      if (content == null) { try { content = (await request("vault.read", { path: f.path })).content; readCache.set(f.path, content); } catch { return; } }
      hoverCard.innerHTML = `<h5>${escapeHtml(f.title)}</h5>${escapeHtml(content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 280))}...`;
      hoverCard.style.display = "block";
      const r = el.getBoundingClientRect();
      hoverCard.style.left = Math.min(r.left, window.innerWidth - 340) + "px";
      hoverCard.style.top = (r.bottom + 6) + "px";
    }, 350);
  });
  el.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hoverCard.style.display = "none"; });
}

// search
let searchTimer;
$("search").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) { renderTree(); return; }
  searchTimer = setTimeout(async () => {
    const d = await request("vault.search", { query: q });
    const el = $("file-list"); el.innerHTML = "";
    if (!d.results.length) { el.innerHTML = `<div class="empty" style="padding:20px">no matches</div>`; return; }
    d.results.forEach((f) => el.appendChild(fileItem(f, true)));
  }, 200);
});

// ============================================================ graph
const canvas = $("graph-canvas");
const graph = new Graph(canvas); window._graph = graph;
applyTheme(localStorage.getItem("ss-theme") || "dark"); // set accent now that graph exists
// Plain click previews the note in a side panel (stay on the graph); shift-click selects for training.
graph.onClick = (n, e) => { if (e && e.shiftKey) toggleSelect(n.id); else showGraphNode(n.path); };
const graphSide = $("graph-side");
let graphSidePath = null;
async function showGraphNode(path) {
  if (!path) return; // tag/cluster nodes have no note to preview
  graphSidePath = path;
  $("graph-side-title").textContent = path.split("/").pop().replace(/\.md$/i, "");
  $("graph-side-title").title = path;
  graphSide.classList.add("show");
  requestAnimationFrame(sizeGraph); // the panel narrowed #graph-left; reflow the canvas so the graph isn't squished
  const body = $("graph-side-body");
  body.innerHTML = `<span style="color:var(--mut)">Loading...</span>`;
  try { const r = await request("vault.read", { path }); body.innerHTML = renderMarkdown(r.content || "*(empty note)*"); }
  catch { body.innerHTML = `<span style="color:var(--mut)">Could not read this note.</span>`; }
}
function closeGraphSide() { graphSide.classList.remove("show"); graphSidePath = null; requestAnimationFrame(sizeGraph); }
$("graph-side-close").onclick = closeGraphSide;
$("graph-side-open").onclick = () => { if (graphSidePath) openNote(graphSidePath); };
function sizeGraph() { const r = $("graph-left").getBoundingClientRect(); graph.resize(r.width, r.height); graph.reheat(); }
window.addEventListener("resize", () => { if ($("graph-pane").classList.contains("active")) sizeGraph(); });
async function ensureGraph() {
  if (graphData) { graph.setData(graphData); showGraphStats(); return; }
  $("graph-stats").textContent = "building...";
  graphData = await request("graph.build"); graph.setData(graphData); showGraphStats();
}
function showGraphStats() {
  const s = graphData.stats;
  $("graph-stats").textContent = `${s.notes} notes · ${s.links} links · ${s.embedEdges || 0} semantic · ${s.orphans} orphan`;
}
$("btn-graph-build").onclick = async () => { $("graph-stats").textContent = "building..."; graphData = await request("graph.build"); graph.setData(graphData); showGraphStats(); if (current) renderBacklinks(current); };
on("embed.progress", (m) => { $("graph-stats").textContent = `embedding ${m.done}/${m.total}...`; });
$("btn-graph-embed").onclick = async () => {
  $("graph-stats").textContent = "embedding (first time downloads the embedder)...";
  try { graphData = await request("graph.embed"); graph.setData(graphData); showGraphStats(); toast("Semantic links added"); }
  catch (e) { $("graph-stats").textContent = "embed failed"; toast(e.message, "bad"); }
};

// NL highlight
async function runHighlight(q) {
  q = (q || "").trim(); if (!q) return;
  if (!graphData) await ensureGraph();
  $("graph-stats").textContent = "thinking...";
  try {
    const d = await request("graph.highlight", { query: q });
    graph.setHighlight(d.matches.map((m) => m.path));
    $("btn-hl-clear").style.display = d.matches.length ? "" : "none";
    showGraphStats();
    toast(d.matches.length ? `Highlighted ${d.matches.length} notes for "${q}"` : `No matches for "${q}"`, d.matches.length ? "" : "warn");
  } catch (e) { $("graph-stats").textContent = "highlight failed"; toast(e.message, "bad"); }
}
// type = instant client-side name/path match; Enter = semantic (model) highlight
$("hl-input").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!graphData) return;
  if (!q) { graph.clearHighlight(); $("btn-hl-clear").style.display = "none"; return; }
  const ids = graphData.nodes.filter((n) => (n.label || "").toLowerCase().includes(q) || (n.path || "").toLowerCase().includes(q)).map((n) => n.id);
  graph.setHighlight(ids); $("btn-hl-clear").style.display = "";
});
$("hl-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runHighlight(e.target.value); });
$("btn-hl-clear").onclick = () => { graph.clearHighlight(); $("hl-input").value = ""; $("btn-hl-clear").style.display = "none"; };

// vault auto-refresh: a file changed on disk (external edit, or a synced folder)
on("vault.changed", async () => {
  graphData = null; // rebuild graph lazily on next view
  const typing = document.activeElement === editor || ($("search").value || "").trim();
  if (!typing) { try { await loadFiles(); } catch { /* */ } if ($("graph-pane").classList.contains("active")) ensureGraph(); }
  if (current && !dirty && document.activeElement !== editor) {
    try { const d = await request("vault.read", { path: current }); if (d.content !== editor.value) { editor.value = d.content; readCache.set(current, d.content); renderPreview(); } } catch { /* */ }
  }
});

// selection (training corpus)
let selection = new Set();
function toggleSelect(id) { selection.has(id) ? selection.delete(id) : selection.add(id); syncSelection(); }
function syncSelection() {
  graph.setSelected(selection); $("sel-count").textContent = selection.size;
  const pill = $("graph-sel-pill");
  if (pill) { if (selection.size) { pill.style.display = ""; pill.textContent = `${selection.size} selected to train`; } else pill.style.display = "none"; }
}
$("btn-sel-clear").onclick = () => { selection = new Set(); syncSelection(); };
$("btn-autoselect").onclick = autoSelect;
async function autoSelect() {
  const info = $("select-info"); info.innerHTML = `<span class="spin"></span> embedding notes + scoring relevance...`;
  try {
    const d = await request("select.auto");
    selection = new Set(d.selection.filter((s) => s.selected).map((s) => s.path));
    if (!graphData) graphData = await request("graph.build");
    graph.setData(graphData); syncSelection();
    info.textContent = `auto-selected ${d.selected} of ${d.selection.length} notes (most central to your themes). Shift-click nodes to adjust.`;
    toast(`Auto-selected ${d.selected} docs`);
  } catch (e) { info.textContent = "auto-select failed: " + e.message; toast(e.message, "bad"); }
}
on("select.progress", (m) => { $("select-info").innerHTML = `<span class="spin"></span> embedding ${m.done}/${m.total}...`; });

// ============================================================ training
const trainBtn = $("btn-train"), stopBtn = $("btn-train-stop"), trainBar = $("train-bar"), trainMetrics = $("train-metrics"), trainLog = $("train-log");
function logLine(s) { trainLog.textContent += s + "\n"; trainLog.scrollTop = trainLog.scrollHeight; }
on("train.dataset", (m) => logLine(`dataset: ${m.docs} docs -> ${m.trainDocs} train / ${m.evalDocs} eval (${m.trainChars} chars)`));
on("train.progress", (m) => {
  const pct = m.totalBatches ? Math.round((m.step / m.totalBatches) * 100) : 0;
  trainBar.style.width = Math.min(100, pct) + "%";
  trainMetrics.textContent = `e${m.epoch} step ${m.step}/${m.totalBatches} · loss ${m.trainLoss?.toFixed(3) ?? "?"} · val ${m.valLoss?.toFixed(3) ?? "-"} · eta ${m.etaSec}s · ${m.elapsedSec}s`;
});
on("train.log", (m) => { if (/loss|status|adapter|ABORT|FAILED|peak/i.test(m.line)) logLine(m.line); });
on("train.done", (m) => {
  trainBtn.disabled = false; stopBtn.disabled = true;
  if (m.ok) trainBar.style.width = "100%";
  trainMetrics.textContent = m.ok ? `DONE in ${m.elapsedSec}s · val ${m.valLoss?.toFixed(3) ?? "?"} · ${m.adapterMB ?? "?"} MB` : `ended: ${m.status || "no adapter"} (exit ${m.exitCode})`;
  logLine(m.ok ? `✓ adapter: ${m.adapter}` : `✗ ${m.status || "failed"}`);
  toast(m.ok ? "Training done. Your voice is ready in Chat." : "Training ended without an adapter", m.ok ? "" : "bad");
  if (m.ok) confetti();
  refreshAdapters();
});
on("train.error", (m) => { trainBtn.disabled = false; stopBtn.disabled = true; logLine("error: " + m.message); toast(m.message, "bad"); });
trainBtn.onclick = async () => {
  if (!selection.size) { toast("Auto-select or shift-click notes first.", "warn"); return; }
  trainBtn.disabled = true; stopBtn.disabled = false; trainBar.style.width = "0%"; trainLog.textContent = "";
  trainMetrics.textContent = "loading base (first run downloads it)...";
  try { await request("train.start", { baseKey: $("base-pick").value, paths: [...selection], epochs: Number($("epochs").value), ctx: Number($("ctx").value) }); }
  catch (e) { trainBtn.disabled = false; stopBtn.disabled = true; trainMetrics.textContent = "could not start: " + e.message; toast(e.message, "bad"); }
};
stopBtn.onclick = async () => { await request("train.stop"); stopBtn.disabled = true; trainBtn.disabled = false; logLine("stopped."); };
async function refreshAdapters() {
  const d = await request("train.adapters");
  const el = $("adapter-list"), sel = $("chat-adapter");
  if (!d.adapters.length) { el.textContent = "none yet - train one in step 2 above"; sel.innerHTML = `<option value="" disabled>no adapter - train one first</option>`; return; }
  const runnable = (a) => a.baseKey !== "3b"; // BitNet 3B trains, but inference is impractical in this SDK
  el.innerHTML = d.adapters.map((a) => `<div>&#9679; ${escapeHtml(a.file.replace("adapters/", ""))} <span style="color:var(--mut)">(${escapeHtml(a.baseKey)}, ${a.sizeMB} MB${runnable(a) ? "" : " - train-only in this SDK"})</span></div>`).join("");
  const voice = d.adapters.filter(runnable);
  sel.innerHTML = voice.length
    ? voice.map((a) => `<option value="${escapeHtml(a.file)}" data-base="${escapeHtml(a.baseKey)}">${escapeHtml(a.file.replace("adapters/", ""))}</option>`).join("")
    : `<option value="" disabled>no runnable adapter yet - train on Qwen3 1.7B</option>`;
}

// ---- training drawer (inside the Chat tab) ----
const chatPaneEl = $("chat-pane");
function openTrainDrawer() { switchPane("chat"); chatPaneEl.classList.add("train-open"); }
function closeTrainDrawer() { chatPaneEl.classList.remove("train-open"); }
$("btn-train-open").onclick = () => chatPaneEl.classList.contains("train-open") ? closeTrainDrawer() : openTrainDrawer();
$("btn-train-close").onclick = closeTrainDrawer;
$("train-scrim").onclick = closeTrainDrawer;

// ---- weekly auto-retrain (opt-in, persisted server-side) ----
const tgAuto = $("tg-autoretrain"), autoInterval = $("autoretrain-interval");
const tgSync = $("tg-autosync"), syncInterval = $("autosync-interval");
async function loadRetrainCfg() {
  try {
    const c = await request("config.get");
    if (c.agentName) { agentName = c.agentName; if (agentNameInput) agentNameInput.value = c.agentName; }
    tgAuto.checked = !!c.autoRetrain.enabled; autoInterval.value = String(c.autoRetrain.intervalDays || 7); $("autoretrain-row").style.display = tgAuto.checked ? "flex" : "none";
    if (tgSync) { tgSync.checked = !!c.autoSync.enabled; syncInterval.value = String(c.autoSync.intervalHours || 24); syncInterval.style.display = tgSync.checked ? "" : "none"; }
  } catch { /* */ }
}
function saveRetrainCfg() {
  $("autoretrain-row").style.display = tgAuto.checked ? "flex" : "none";
  request("config.set", { autoRetrain: { enabled: tgAuto.checked, intervalDays: Number(autoInterval.value), baseKey: $("base-pick").value } }).catch(() => {});
}
tgAuto.onchange = () => { saveRetrainCfg(); toast(tgAuto.checked ? "Auto-retrain on: it re-selects your notes and retrains in the background." : "Auto-retrain off."); };
autoInterval.onchange = saveRetrainCfg;
function saveSyncCfg() {
  syncInterval.style.display = tgSync.checked ? "" : "none";
  request("config.set", { autoSync: { enabled: tgSync.checked, intervalHours: Number(syncInterval.value) } }).catch(() => {});
}
if (tgSync) { tgSync.onchange = () => { saveSyncCfg(); toast(tgSync.checked ? "Auto-sync on: sources re-index in the background to stay fresh." : "Auto-sync off."); }; syncInterval.onchange = saveSyncCfg; }
on("autoRetrain.start", () => toast("Auto-retrain started in the background.", "warn"));
on("autoRetrain.skip", (m) => toast("Auto-retrain skipped: " + (m.reason || ""), "warn"));
on("autoRetrain.done", (m) => { toast(m.ok ? "Auto-retrain finished. Your refreshed voice is ready in Chat." : "Auto-retrain ended without an adapter.", m.ok ? "" : "warn"); refreshAdapters(); });
on("autoRetrain.error", (m) => toast("Auto-retrain error: " + (m.message || ""), "bad"));

// ============================================================ chat
const messages = $("messages"), chatText = $("chat-text"), tgVoice = $("tg-voice"), tgMemory = $("tg-memory"), chatAdapter = $("chat-adapter"), chatBase = $("chat-base");
let history = [], curAssistantEl = null, chatBusy = false;
let agentName = "Second Self"; // the assistant's display name (config.agentName); used for the chat label
// rename the assistant: persist server-side (flows into the system prompt) + relabel existing messages
const agentNameInput = $("agent-name");
async function saveAgentName() {
  const n = (agentNameInput.value || "").trim().slice(0, 40);
  try { const c = await request("config.set", { agentName: n }); agentName = c.agentName; agentNameInput.value = c.agentName;
    messages.querySelectorAll(".msg.assistant .who").forEach((w) => w.textContent = agentName);
    toast(`Assistant renamed to "${agentName}"`);
  } catch (e) { toast(e.message, "bad"); }
}
$("btn-rename").onclick = saveAgentName;
agentNameInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); saveAgentName(); agentNameInput.blur(); } };
tgVoice.onchange = () => {
  const hasAdapter = [...chatAdapter.options].some((o) => o.value);
  if (tgVoice.checked && !hasAdapter) { tgVoice.checked = false; chatAdapter.style.display = "none"; toast("Train your voice first (click 'Train your voice'), then turn on Voice.", "warn"); openTrainDrawer(); return; }
  chatAdapter.style.display = tgVoice.checked ? "" : "none";
};
chatAdapter.onchange = () => { const o = chatAdapter.selectedOptions[0]; if (o) chatBase.value = o.dataset.base; };
const tgAgent = $("tg-agent"), agentPerm = $("agent-perm");
tgAgent.onchange = () => { agentPerm.style.display = tgAgent.checked ? "" : "none"; if (tgAgent.checked) { tgMemory.checked = false; } };
on("agent.tool", (m) => {
  if (!curAssistantEl) return;
  let act = curAssistantEl.querySelector(".agent-acts");
  if (!act) { act = document.createElement("div"); act.className = "agent-acts"; curAssistantEl.insertBefore(act, curAssistantEl.querySelector(".body")); }
  const ico = m.name === "write_note" ? "✏️" : m.name === "read_note" ? "📄" : m.name === "list_notes" ? "🗂️" : "🔎";
  const arg = (m.args && (m.args.query || m.args.path)) || "";
  const line = document.createElement("div"); line.className = "agent-act"; line.textContent = `${ico} ${m.name.replace("_", " ")} ${arg}`.trim();
  act.appendChild(line); messages.scrollTop = messages.scrollHeight;
});
on("agent.edited", (m) => { toast("Agent edited " + m.path, "warn"); loadFiles().catch(() => {}); });
async function ingest() {
  toast("Indexing your documents for memory...");
  try { const d = await request("rag.ingest"); toast(`Indexed ${d.ingested} notes (${d.chunks} chunks) for memory`); }
  catch (e) { toast(e.message, "bad"); }
  finally { if ($("memory-pane").classList.contains("active")) renderSources(); }
}
// one throttle for both: show the first, the finish, and a milestone every ~1000 chunks (no spam)
const indexProgress = (m) => { if (m.total && (m.done === m.total || m.done <= 16 || m.done % 1000 === 0)) toast(`indexing ${m.done}/${m.total}...`); };
on("rag.progress", indexProgress);
on("context.progress", indexProgress);

// ---- personal context sources (Settings -> Memory & Sources) ----
const MEM_ICON = { vault: "&#128214;", folder: "&#128193;", calendar: "&#128197;", mail: "&#9993;&#65039;", contacts: "&#128100;", browser: "&#127760;", messages: "&#128172;" };
const MEM_UNIT = { vault: "notes", folder: "files", calendar: "events", mail: "emails", contacts: "contacts", browser: "pages", messages: "messages" };
const CONNECTORS = [
  { key: "calendar", label: "Calendar" }, { key: "mail", label: "Mail" }, { key: "contacts", label: "Contacts" },
  { key: "browser", label: "Browser history" }, { key: "messages", label: "Messages" },
];
const LOW_CHUNKS = 3; // fewer than this = the source has almost no content worth recalling
async function renderSources() {
  const body = $("mem-body"); if (!body) return;
  let d; try { d = await request("context.sources"); } catch { return; }
  const stats = $("mem-stats"); if (stats) stats.textContent = d.sources.length ? `${d.sources.length} source${d.sources.length === 1 ? "" : "s"} · ${d.totalChunks} chunks indexed` : "nothing indexed yet";
  const byType = {}; for (const s of d.sources) (byType[s.type] = byType[s.type] || []).push(s);
  const vault = (byType.vault || [])[0];
  const lowTag = (s) => s.chunkCount < LOW_CHUNKS ? `<span class="mc-status low" title="Very little content indexed - re-index or add more">low content</span>` : "";

  // 1) Your documents (the vault)
  let html = `<div class="mem-sec-label">Your documents</div>`;
  if (vault) {
    html += `<div class="mem-doc">
      <span class="md-ico">&#128214;</span>
      <div class="md-main"><div class="md-name">${escapeHtml(vault.label)} ${lowTag(vault)}</div>
        <div class="md-sub">${escapeHtml(vault.path)} &middot; ${vault.chunkCount} chunks from ${vault.docCount} notes</div></div>
      <div class="mc-acts"><button class="btn" data-openeditor title="Edit these notes">Open editor</button>
        <button class="btn" data-indexvault title="Re-embed the vault for memory">&#8635; Re-index</button></div>
    </div>`;
  } else {
    html += `<div class="mem-doc"><span class="md-ico">&#128214;</span>
      <div class="md-main"><div class="md-name">Your vault isn't indexed yet</div>
        <div class="md-sub">Index it so the AI can recall your notes with citations.</div></div>
      <button class="btn primary" data-indexvault>Index my documents</button></div>`;
  }

  // 2) Connectors (always shown; status reflects whether they're added)
  html += `<div class="mem-sec-label">Connect your Mac <span style="text-transform:none;color:var(--mut)">- read-only, on-device. macOS may ask for Full Disk Access the first time.</span></div><div class="mem-grid">`;
  for (const c of CONNECTORS) {
    const src = (byType[c.key] || [])[0];
    const status = src
      ? `<span class="mc-status on">${src.docCount} ${MEM_UNIT[c.key]}</span>${lowTag(src)}`
      : `<span class="mc-status off">Not connected</span>`;
    const acts = src
      ? `<button class="btn" data-reindex="${escapeHtml(src.id)}" title="Re-index">&#8635;</button><button class="btn" data-rm="${escapeHtml(src.id)}" title="Disconnect (keeps your data)">&times;</button>`
      : `<button class="btn" data-connect="${c.key}">Connect</button>`;
    html += `<div class="mem-card"><div class="mc-top"><span class="mc-ico">${MEM_ICON[c.key]}</span><span class="mc-name">${c.label}</span></div>
      <div class="mc-bot">${status}<span class="mc-acts">${acts}</span></div></div>`;
  }
  html += `<div class="mem-card dashed" data-addfolder><span>&#10133;</span><span>Add a folder</span></div></div>`;

  // 3) Added folders (user-picked, not connectors)
  const folders = byType.folder || [];
  if (folders.length) {
    html += `<div class="mem-sec-label">Added folders</div><div class="mem-grid">`;
    for (const s of folders) {
      html += `<div class="mem-card"><div class="mc-top"><span class="mc-ico">&#128193;</span><span class="mc-name">${escapeHtml(s.label)}</span></div>
        <div class="mc-bot"><span class="mc-status on">${s.chunkCount} chunks</span>${lowTag(s)}<span class="mc-acts">
          <button class="btn" data-reindex="${escapeHtml(s.id)}" title="Re-index">&#8635;</button><button class="btn" data-rm="${escapeHtml(s.id)}" title="Remove (keeps your files)">&times;</button></span></div></div>`;
    }
    html += `</div>`;
  }
  body.innerHTML = html;

  // wiring
  body.querySelector("[data-openeditor]")?.addEventListener("click", () => switchPane("vault"));
  body.querySelectorAll("[data-indexvault]").forEach((b) => b.onclick = () => ingest());
  body.querySelectorAll("[data-connect]").forEach((b) => b.onclick = () => addPresetFlow(b.dataset.connect));
  body.querySelector("[data-addfolder]")?.addEventListener("click", () => addSourceFlow());
  body.querySelectorAll("[data-reindex]").forEach((b) => b.onclick = async () => { toast("Re-indexing..."); try { await request("context.reindex", { sourceId: b.dataset.reindex }); toast("Re-indexed"); renderSources(); } catch (e) { toast(e.message, "bad"); } });
  body.querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => { try { await request("context.removeSource", { sourceId: b.dataset.rm }); renderSources(); toast("Removed from memory"); } catch (e) { toast(e.message, "bad"); } });
}
// add a context source; on a macOS permission block, open the Full Disk Access flow with a retry.
async function indexSource(payload, label) {
  toast(`Indexing ${label} (first run loads the embedder)...`);
  try { const r = await request("context.addSource", payload); const unit = (r.source.type && r.source.type !== "folder" && r.source.type !== "vault") ? "entries" : "files"; toast(`Added ${label}: ${r.source.docCount} ${unit}, ${r.source.chunkCount} chunks`); renderSources(); }
  catch (e) { if (/FULL_DISK_ACCESS_REQUIRED/.test(e.message)) openFda(() => indexSource(payload, label)); else toast(`Could not add ${label}: ${e.message}`, "bad"); }
}
async function addSourceFlow() {
  const dir = await pickPath({ title: "Add a folder as a source", mode: "folder" });
  if (!dir) return;
  indexSource({ path: dir }, "folder");
}
// macOS store connectors: all flow through indexSource, which opens the Full Disk Access modal on a TCC block.
const PRESET_LABELS = { calendar: "Apple Calendar", mail: "Apple Mail", contacts: "Contacts", browser: "Browser history", messages: "Messages" };
function addPresetFlow(preset) { indexSource({ preset }, PRESET_LABELS[preset] || preset); }

// ---- Full Disk Access modal (macOS) ----
let fdaRetry = null;
function openFda(retry) { fdaRetry = retry || null; $("fda").classList.add("show"); }
function closeFda() { $("fda").classList.remove("show"); }
$("fda-close").onclick = closeFda;
$("fda").addEventListener("click", (e) => { if (e.target === $("fda")) closeFda(); });
$("fda-open").onclick = () => { request("system.openSettings").catch(() => {}); toast("Enable Second Self (or Terminal) under Full Disk Access, then click Re-index."); };
$("fda-retry").onclick = () => { closeFda(); const r = fdaRetry; fdaRetry = null; if (r) r(); };
on("context.changed", () => { if ($("memory-pane").classList.contains("active")) renderSources(); });
on("context.synced", (m) => { if (m.sources > 0) { toast(`Memory refreshed: ${m.sources} source${m.sources === 1 ? "" : "s"} re-indexed.`); renderSources(); } });
on("context.syncSkip", (m) => toast(/FULL_DISK_ACCESS_REQUIRED/.test(m.reason)
  ? `Sync skipped "${m.source}": needs Full Disk Access. Re-connect it from the Memory tab to grant it.`
  : `Sync skipped "${m.source}": ${m.reason}`, "warn"));
on("chat.token", (m) => { if (curAssistantEl) { curAssistantEl._raw += m.text; curAssistantEl.querySelector(".body").innerHTML = renderMarkdown(curAssistantEl._raw); messages.scrollTop = messages.scrollHeight; } });
on("chat.warn", (m) => toast(m.message, "warn"));
function addMsg(role, text) {
  if (messages.querySelector(".empty")) messages.innerHTML = "";
  const el = document.createElement("div"); el.className = "msg " + role; el._raw = text || "";
  el.innerHTML = (role === "assistant" ? `<div class="who">${escapeHtml(agentName)}</div>` : "") + `<div class="body">${renderMarkdown(text || "")}</div>`;
  messages.appendChild(el); messages.scrollTop = messages.scrollHeight; return el;
}
// citations come from the RETRIEVAL layer (reliable), never parsed from the model's text.
function renderCitations(el, hits) {
  const wrap = document.createElement("div"); wrap.className = "cites";
  wrap.appendChild(Object.assign(document.createElement("span"), { className: "cites-label", textContent: "sources" }));
  hits.forEach((h, i) => {
    const name = String(h.source || "?").split("/").pop();
    const chip = document.createElement("span"); chip.className = "cite";
    chip.title = `${h.source}  ·  ${Math.round((h.score || 0) * 100)}% match\n\n${String(h.content || "").slice(0, 320)}`;
    // the chip number matches the [n] the model cites in its answer (same order as the grounding)
    chip.innerHTML = `<span class="cite-n">[${i + 1}]</span><span class="cite-ic">${h.sourceType === "vault" ? "&#128196;" : "&#128193;"}</span>${escapeHtml(name)} <span class="cite-score">${Math.round((h.score || 0) * 100)}%</span>`;
    chip.onclick = () => { if (h.sourceType === "vault" && byPath.has(h.source)) openNote(h.source); else toast(`${h.source}: ${String(h.content || "").slice(0, 220)}`); };
    wrap.appendChild(chip);
  });
  el.appendChild(wrap); messages.scrollTop = messages.scrollHeight;
}
async function send() {
  if (chatBusy) return;
  const text = chatText.value.trim(); if (!text) return;
  chatBusy = true; $("btn-send").disabled = true; chatText.value = "";
  addMsg("user", text);
  curAssistantEl = addMsg("assistant", ""); curAssistantEl.querySelector(".body").innerHTML = `<span class="spin"></span>`; curAssistantEl._raw = "";
  if (tgAgent.checked) {
    const baseKey = chatBase.value, permission = agentPerm.value;
    $("chat-model-state").textContent = `agent (${permission}) · ${baseKey} working...`;
    try {
      const d = await request("agent.chat", { message: text, history, baseKey, permission });
      history.push({ role: "user", content: text }, { role: "assistant", content: d.contentText });
      if (history.length > 12) history = history.slice(-12);
      $("chat-model-state").textContent = `agent · ${baseKey} · ${(d.actions || []).length} tool calls`;
    } catch (e) { curAssistantEl.querySelector(".body").innerHTML = `<span style="color:var(--bad)">${escapeHtml(e.message)}</span>`; $("chat-model-state").textContent = ""; }
    finally { chatBusy = false; $("btn-send").disabled = false; }
    return;
  }
  const voice = tgVoice.checked, memory = tgMemory.checked;
  const adapter = voice && chatAdapter.value ? chatAdapter.value : null, baseKey = chatBase.value;
  $("chat-model-state").textContent = `loading ${baseKey}${adapter ? "+LoRA" : ""}${memory ? "+memory" : ""}...`;
  try {
    const d = await request("chat.send", { message: text, history, baseKey, adapter, voice, memory });
    history.push({ role: "user", content: text }, { role: "assistant", content: d.contentText });
    if (history.length > 12) history = history.slice(-12);
    if (d.hits && d.hits.length) renderCitations(curAssistantEl, d.hits);
    $("chat-model-state").textContent = `${baseKey}${d.model?.voice ? " · voice" : ""}${d.model?.memory ? " · memory" : ""}${d.stats?.tokensPerSecond ? " · " + d.stats.tokensPerSecond.toFixed(0) + " tok/s" : ""}`;
  } catch (e) { curAssistantEl.querySelector(".body").innerHTML = `<span style="color:var(--bad)">${escapeHtml(e.message)}</span>`; $("chat-model-state").textContent = ""; }
  finally { chatBusy = false; $("btn-send").disabled = false; }
}
$("btn-send").onclick = send;
chatText.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

// ============================================================ models pane
let modelsLoaded = false;
const GROUP_TITLES = { voice: "Train your voice on these (fine-tunable bases)", chat: "Chat models", embedding: "Embeddings" };
async function ensureModels(force) {
  if (modelsLoaded && !force) return;
  const el = $("models-list"); el.innerHTML = `<div class="empty"><span class="spin"></span> loading catalog...</div>`;
  try { const d = await request("model.catalog"); renderModels(d.models, d.hardware, d.recommend); modelsLoaded = true; }
  catch (e) { el.innerHTML = `<div class="empty">could not load catalog: ${escapeHtml(e.message)}</div>`; }
}
function renderModels(models, hw, rec) {
  const el = $("models-list"); el.innerHTML = "";
  if (hw) {
    const b = document.createElement("div"); b.className = "hw-banner";
    b.innerHTML = `<div><span class="hw-ico">🖥️</span> <b>Your machine:</b> ${hw.ramGB} GB RAM · ${escapeHtml(hw.gpu)} · ${hw.cpus} cores</div>
      <div style="margin-top:4px"><b>Recommended:</b> chat up to <span style="color:var(--accent)">${escapeHtml(rec?.chat || "?")}</span>, train up to <span style="color:var(--accent)">${escapeHtml(rec?.train || "?")}</span></div>`;
    el.appendChild(b);
  }
  for (const group of ["voice", "chat", "embedding"]) {
    const list = models.filter((m) => m.group === group);
    if (!list.length) continue;
    const g = document.createElement("div"); g.className = "model-group";
    g.innerHTML = `<h3>${GROUP_TITLES[group]}</h3>`;
    for (const m of list) g.appendChild(modelCard(m));
    el.appendChild(g);
  }
}
function modelCard(m) {
  const card = document.createElement("div"); card.className = "model-card"; card.dataset.name = m.name;
  const src = m.hf ? `<a class="mc-hf" href="${m.hf}" target="_blank" rel="noopener">Hugging Face &#8599;</a>` : `<span class="mc-hf" style="color:var(--mut)">QVAC registry</span>`;
  const fitLabel = { ok: "runs well", tight: "runs (tight)", "too-big": "too big to run" };
  const fitClass = { ok: "ok", tight: "tight", "too-big": "big" };
  const f = m.fit || {};
  const runBadge = f.run ? `<span class="fit fit-${fitClass[f.run]}">${fitLabel[f.run]}</span>` : "";
  const trainBadge = (m.fineTunable && f.train && f.train !== "n/a") ? `<span class="fit fit-${fitClass[f.train]}">trains: ${f.train === "too-big" ? "too big" : f.train}</span>` : "";
  card.innerHTML = `<div class="mc-main">
      <div class="mc-title">${escapeHtml(m.label)} ${m.fineTunable ? '<span class="mc-badge ft">fine-tunable</span>' : ""} <span class="mc-badge">${m.params} · ${m.quant}</span> ${runBadge} ${trainBadge}</div>
      <div class="mc-meta">${m.sizeGB} GB · ${m.engine.replace("llamacpp-", "")}</div>
      <div class="mc-note">${escapeHtml(m.note)} · ${src}</div>
    </div>
    <div class="mc-actions"><div class="status"></div><div class="mc-bar"><div></div></div></div>`;
  renderCardStatus(card, m);
  return card;
}
function renderCardStatus(card, m) {
  const st = card.querySelector(".status"); st.innerHTML = "";
  if (m.cached) {
    st.innerHTML = `<span class="mc-cached">&#10003; Downloaded</span>`;
    const del = document.createElement("button"); del.className = "btn danger"; del.textContent = "Delete"; del.style.marginTop = "4px";
    del.onclick = async () => { if (!await confirmModal(`Delete ${m.label} from your machine? You can re-download it later.`, { title: "Delete model?", okLabel: "Delete", danger: true })) return; try { await request("model.delete", { name: m.name }); m.cached = false; renderCardStatus(card, m); toast(`Deleted ${m.label}`); } catch (e) { toast(e.message, "bad"); } };
    st.appendChild(del);
  } else {
    const dl = document.createElement("button"); dl.className = "btn primary"; dl.textContent = `Download ${m.sizeGB} GB`;
    dl.onclick = () => downloadModel(card, m, dl);
    st.appendChild(dl);
  }
}
async function downloadModel(card, m, btn) {
  btn.disabled = true; btn.textContent = "downloading...";
  const bar = card.querySelector(".mc-bar"); bar.style.display = "block"; card._dl = bar.firstElementChild;
  try { await request("model.download", { name: m.name }); m.cached = true; renderCardStatus(card, m); bar.style.display = "none"; toast(`${m.label} is ready`); }
  catch (e) { btn.disabled = false; btn.textContent = `Download ${m.sizeGB} GB`; bar.style.display = "none"; toast("Download failed: " + e.message, "bad"); }
}
on("download.progress", (m) => { const card = document.querySelector(`.model-card[data-name="${m.name}"]`); if (card && card._dl) card._dl.style.width = Math.min(100, m.pct) + "%"; });

// ============================================================ command palette + quick switcher
const palette = $("palette"), paletteInput = $("palette-input"), paletteList = $("palette-list");
let palSel = 0, palItems = [];
function commands() {
  return [
    { ico: "✎", label: "New note", hint: "", run: newNote },
    { ico: "◰", label: "Go to Notes", run: () => switchPane("vault") },
    { ico: "◓", label: "Go to Graph", run: () => switchPane("graph") },
    { ico: "✉", label: "Go to Chat", run: () => switchPane("chat") },
    { ico: "⤓", label: "Models: download / manage", run: () => switchPane("models") },
    { ico: "📁", label: "Switch vault", run: () => openSettings("vault") },
    { ico: "📂", label: "Open a folder as a vault", run: openVaultFlow },
    { ico: "➕", label: "Create a new vault", run: createVaultFlow },
    { ico: "📥", label: "Import ChatGPT / Claude conversations", run: importCloudFlow },
    { ico: "⚙", label: "Open settings", run: () => openSettings() },
    { ico: "📡", label: "Share this machine's GPU (remote inference)", run: shareGpu },
    { ico: "⚡", label: "Connect to a remote machine", run: connectRemote },
    { ico: "◑", label: "Cycle theme (dark / light / QVAC)", run: cycleTheme },
    { ico: "◉", label: "Rebuild knowledge graph", run: () => { switchPane("graph"); $("btn-graph-build").click(); } },
    { ico: "✨", label: "Add semantic links", run: () => { switchPane("graph"); $("btn-graph-embed").click(); } },
    { ico: "🔎", label: "Search your notes (graph)", run: () => { switchPane("graph"); setTimeout(() => $("hl-input").focus(), 50); } },
    { ico: "🧬", label: "Train your voice", run: openTrainDrawer },
    { ico: "⦿", label: "Auto-select relevant notes", run: () => { openTrainDrawer(); autoSelect(); } },
    { ico: "▶", label: "Start training", run: () => { openTrainDrawer(); trainBtn.click(); } },
    { ico: "🧠", label: "Index vault for memory", run: () => { switchPane("chat"); ingest(); } },
    { ico: "⎙", label: "Share card (your model stats)", run: shareCard },
    { ico: "✦", label: "Show welcome tour", run: () => startOnboarding(true) },
  ];
}
let paletteReturnFocus = null;
function openPalette(noteMode) {
  paletteReturnFocus = document.activeElement;
  palette.classList.add("show"); paletteInput.value = ""; paletteInput.placeholder = noteMode ? "Jump to a note..." : "Type a command or search notes...";
  renderPalette(""); paletteInput.focus();
}
function closePalette() { palette.classList.remove("show"); if (paletteReturnFocus && paletteReturnFocus.focus) paletteReturnFocus.focus(); }
function fuzzy(q, s) { q = q.toLowerCase(); s = s.toLowerCase(); let i = 0; for (const c of s) if (c === q[i]) i++; return i === q.length; }
function renderPalette(q) {
  const cmds = commands().filter((c) => !q || fuzzy(q, c.label)).map((c) => ({ ...c, kind: "cmd" }));
  const notes = (q ? files.filter((f) => fuzzy(q, f.title) || fuzzy(q, f.path)) : files.slice(0, 8))
    .slice(0, 8).map((f) => ({ ico: "📄", label: f.title, sub: f.dir, kind: "note", run: () => openNote(f.path) }));
  palItems = [...cmds, ...notes]; palSel = 0;
  paletteList.innerHTML = palItems.map((it, i) =>
    `<div class="palette-item${i === 0 ? " sel" : ""}" data-i="${i}"><span class="ico">${it.ico}</span><span>${escapeHtml(it.label)}${it.sub ? ` <span class="sub">${escapeHtml(it.sub)}</span>` : ""}</span>${it.hint ? `<span class="hint">${it.hint}</span>` : ""}</div>`).join("")
    || `<div class="palette-item">no matches</div>`;
  paletteList.querySelectorAll(".palette-item[data-i]").forEach((el) => { el.onclick = () => runPal(Number(el.dataset.i)); el.onmouseenter = () => setPalSel(Number(el.dataset.i)); });
}
function setPalSel(i) { palSel = i; paletteList.querySelectorAll(".palette-item").forEach((el, j) => el.classList.toggle("sel", j === i)); }
function runPal(i) { const it = palItems[i]; if (!it) return; closePalette(); it.run(); }
paletteInput.addEventListener("input", (e) => renderPalette(e.target.value.trim()));
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setPalSel(Math.min(palSel + 1, palItems.length - 1)); paletteList.children[palSel]?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setPalSel(Math.max(palSel - 1, 0)); paletteList.children[palSel]?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "Enter") { e.preventDefault(); runPal(palSel); }
  else if (e.key === "Escape") closePalette();
});
palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });
$("btn-palette").onclick = () => openPalette();

// ============================================================ sidebar: expand / collapse
const rail = $("rail");
if (localStorage.getItem("ss-rail") === "expanded") rail.classList.add("expanded");
$("rail-toggle").onclick = () => { const on = !rail.classList.contains("expanded"); rail.classList.toggle("expanded", on); localStorage.setItem("ss-rail", on ? "expanded" : "collapsed"); };

// ============================================================ current vault + switcher
let vaultInfo = null;
async function updateVaultChip() {
  try { vaultInfo = await request("vault.info"); } catch { return; }
  $("vault-name").textContent = vaultInfo.name || "vault";
  $("vault-chip").title = "Vault: " + vaultInfo.root + "  (click to switch)";
  $("demo-banner").style.display = vaultInfo.isDemo ? "flex" : "none";
}
function sameVault(a, b) { return a && b && a.replace(/\/+$/, "") === b.replace(/\/+$/, ""); }
function resetVaultState() {
  clearTimeout(autosaveTimer); // don't let a pending autosave write the old note into the new vault
  graphData = null; current = null; selection = new Set(); dirty = false; history = [];
  editor.value = ""; preview.innerHTML = ""; noteTitle.textContent = "No note open";
  setEditMode(false); syncSelection();
}

const vaultPop = $("vault-pop");
$("vault-chip").onclick = async (e) => {
  e.stopPropagation();
  if (vaultPop.classList.contains("show")) { vaultPop.classList.remove("show"); return; }
  await renderVaultList($("vault-pop-list"));
  const r = $("vault-chip").getBoundingClientRect();
  vaultPop.style.left = Math.min(r.right + 8, innerWidth - 296) + "px";
  vaultPop.style.top = Math.min(r.top, innerHeight - 240) + "px";
  vaultPop.classList.add("show");
};
document.addEventListener("click", (e) => { if (!vaultPop.contains(e.target) && !$("vault-chip").contains(e.target)) vaultPop.classList.remove("show"); });
$("pop-open").onclick = () => { vaultPop.classList.remove("show"); openVaultFlow(); };
$("pop-create").onclick = () => { vaultPop.classList.remove("show"); createVaultFlow(); };

async function renderVaultList(el) {
  let d; try { d = await request("vault.vaults"); } catch { return; }
  el.innerHTML = d.vaults.map((v) => {
    const cur = sameVault(v.path, d.current);
    return `<div class="vault-item${cur ? " current" : ""}" data-path="${escapeHtml(v.path)}">
      <div class="vi-main"><div class="vi-name">${escapeHtml(v.name)}</div><div class="vi-path">${escapeHtml(v.path)}</div></div>
      ${cur ? '<span class="vi-badge">current</span>' : `<button class="vi-remove" data-rm="${escapeHtml(v.path)}" title="Forget this vault (does not delete files)">&times;</button>`}
    </div>`;
  }).join("") || `<div style="color:var(--mut);font-size:12px;padding:8px">no vaults yet</div>`;
  el.querySelectorAll(".vault-item").forEach((it) => it.onclick = (ev) => { if (ev.target.dataset.rm) return; switchVault(it.dataset.path); });
  el.querySelectorAll(".vi-remove").forEach((b) => b.onclick = async (ev) => { ev.stopPropagation(); try { await request("vault.removeVault", { path: b.dataset.rm }); } catch { /* */ } renderVaultList(el); });
}
// choosing/creating/importing a vault always means "work on THIS device" -> leave the master first
async function leaveMasterIfConnected() {
  try { const m = await request("master.status"); if (m.connected) { await request("master.disconnect"); updateRemoteIndicator(); } } catch { /* */ }
}
async function switchVault(path) {
  vaultPop.classList.remove("show");
  if (vaultInfo && sameVault(path, vaultInfo.root)) return;
  if (!await confirmDiscard()) return;
  await leaveMasterIfConnected();
  try { await request("vault.switchVault", { path }); resetVaultState(); await loadFiles(); await updateVaultChip(); toast("Switched vault"); }
  catch (e) { toast(e.message, "bad"); }
}

// ============================================================ folder / file picker
const picker = $("picker");
let pickerState = { resolve: null, mode: "folder", ext: null, path: null, parent: null, home: null };
async function browse(target) {
  let d; try { d = await request("fs.browse", { path: target, files: pickerState.mode === "file", ext: pickerState.ext }); }
  catch (e) { toast(e.message, "bad"); return; }
  pickerState.path = d.path; pickerState.parent = d.parent; pickerState.home = d.home;
  $("picker-path").textContent = d.path;
  const list = $("picker-list"); list.innerHTML = "";
  for (const dir of d.dirs) {
    const el = document.createElement("div"); el.className = "picker-entry";
    el.innerHTML = `<span class="pe-ico">&#128193;</span><span>${escapeHtml(dir.name)}</span>${dir.notes ? `<span class="pe-count">${dir.notes} notes</span>` : ""}`;
    el.onclick = () => browse(dir.path);
    list.appendChild(el);
  }
  if (pickerState.mode === "file") for (const f of d.files) {
    const el = document.createElement("div"); el.className = "picker-entry";
    el.innerHTML = `<span class="pe-ico">&#128196;</span><span>${escapeHtml(f.name)}</span>`;
    el.onclick = () => finishPick(f.path);
    list.appendChild(el);
  }
  if (!list.children.length) list.innerHTML = `<div class="empty" style="padding:24px">nothing here</div>`;
}
function pickPath({ title, mode = "folder", ext = null }) {
  if (pickerState.resolve) { const prev = pickerState.resolve; pickerState.resolve = null; prev(null); } // resolve a leftover picker
  return new Promise((resolve) => {
    pickerState = { resolve, mode, ext, path: null, parent: null, home: null };
    $("picker-title").textContent = title;
    $("picker-use").style.display = mode === "folder" ? "" : "none";
    $("picker-newfolder").style.display = mode === "folder" ? "" : "none";
    picker.classList.add("show");
    browse(null);
  });
}
function finishPick(val) { picker.classList.remove("show"); const r = pickerState.resolve; pickerState.resolve = null; if (r) r(val); }
$("picker-cancel").onclick = () => finishPick(null);
$("picker-up").onclick = () => { if (pickerState.parent) browse(pickerState.parent); };
$("picker-home").onclick = () => browse(pickerState.home);
$("picker-use").onclick = () => finishPick(pickerState.path);
$("picker-newfolder").onclick = async () => {
  const name = prompt("New folder name:"); if (!name) return;
  try { const r = await request("fs.mkdir", { path: pickerState.path, name }); browse(r.path); } catch (e) { toast(e.message, "bad"); }
};
picker.addEventListener("click", (e) => { if (e.target === picker) finishPick(null); });

async function openVaultFlow() {
  if (!await confirmDiscard()) return;
  const dir = await pickPath({ title: "Open a folder as your vault", mode: "folder" });
  if (!dir) return;
  await leaveMasterIfConnected();
  try { await request("vault.switchVault", { path: dir }); resetVaultState(); await loadFiles(); await updateVaultChip(); toast("Vault: " + dir); }
  catch (e) { toast(e.message, "bad"); }
}
async function createVaultFlow() {
  if (!await confirmDiscard()) return;
  const parent = await pickPath({ title: "Choose where to create the new vault", mode: "folder" });
  if (!parent) return;
  const name = prompt("Name your new vault folder:", "my-vault"); if (!name) return;
  const full = parent.replace(/\/+$/, "") + "/" + name;
  await leaveMasterIfConnected();
  try { await request("vault.createVault", { path: full, name }); resetVaultState(); await loadFiles(); await updateVaultChip(); toast("New vault created at " + full); }
  catch (e) { toast(e.message, "bad"); }
}
async function importCloudFlow() {
  const p = await pickPath({ title: "Select your ChatGPT or Claude export (a .json file)", mode: "file", ext: ".json" });
  if (!p) return;
  await leaveMasterIfConnected();
  toast("Importing conversations...");
  try { const r = await request("import.cloud", { path: p }); toast(`Imported ${r.written} ${r.source} conversations into ${r.folder}`); await loadFiles(); }
  catch (e) { toast("Import failed: " + e.message, "bad"); }
}
$("btn-demo-create").onclick = createVaultFlow;

// ============================================================ settings modal (tabbed)
const settings = $("settings");
function openSettings(tab) { settings.classList.add("show"); if (tab) setSettingsTab(tab); else if (settings.querySelector(".stab.active")) setSettingsTab(settings.querySelector(".stab.active").dataset.tab); }
function closeSettings() { settings.classList.remove("show"); }
function setSettingsTab(tab) {
  settings.querySelectorAll(".stab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  settings.querySelectorAll(".spane").forEach((p) => p.classList.toggle("active", p.dataset.tab === tab));
  if (tab === "vault") renderVaultList($("set-vault-list"));
  if (tab === "devices") refreshDevicesStatus();
}
$("btn-settings").onclick = () => openSettings();
$("settings-close").onclick = closeSettings;
settings.addEventListener("click", (e) => { if (e.target === settings) closeSettings(); });
settings.querySelectorAll(".stab").forEach((t) => t.onclick = () => setSettingsTab(t.dataset.tab));
$("set-onboard").onclick = () => { closeSettings(); startOnboarding(true); };
$("set-addsource").onclick = addSourceFlow; // "Add a folder" lives in the Memory tab footer now
$("btn-manage-memory").onclick = () => switchPane("memory"); // from the chat panel -> the sources hub
$("set-open").onclick = () => { closeSettings(); openVaultFlow(); };
$("set-newvault").onclick = () => { closeSettings(); createVaultFlow(); };
$("set-import").onclick = () => { closeSettings(); importCloudFlow(); };
$("set-share").onclick = shareGpu;
$("set-remote").onclick = connectRemote;

// ---- remote / delegated inference ----
async function refreshDevicesStatus() {
  try {
    const [r, m] = await Promise.all([request("remote.status"), request("master.status")]);
    let txt;
    if (m.connected) txt = "⚡ Connected to a master machine - you're working on its vault.";
    else if (m.master) txt = "🖥️ This machine is a MASTER (its vault + model are shared). Pairing code is active.";
    else if (r.remote) txt = "⚡ Borrowing a remote GPU for chat.";
    else if (r.provider) txt = "📡 Sharing this machine's GPU.";
    else txt = "Not connected. Everything runs on this machine.";
    $("devices-status").textContent = txt;
  } catch { /* */ }
}
// ---- master machine (Path 2): this box holds the vault + model; satellites are thin clients ----
$("set-master-start").onclick = becomeMaster;
$("set-master-connect").onclick = connectToMaster;
async function becomeMaster() {
  toast("Starting the master link (a few seconds)...");
  try {
    const d = await request("master.start");
    prompt("This machine is now a MASTER: it holds the vault and runs the model. Paste this pairing code into your other device (Settings -> Devices -> Connect to a master machine). Keep this app running:", d.publicKey);
    refreshDevicesStatus(); updateRemoteIndicator();
  } catch (e) { toast("Could not become master: " + e.message, "bad"); }
}
async function connectToMaster() {
  closeSettings();
  const pk = prompt("Paste the master machine's pairing code (the 64-hex public key from its 'Become master'):");
  if (!pk) return;
  if (!await confirmDiscard()) return;
  toast("Connecting to the master machine...");
  try {
    await request("master.connect", { publicKey: pk.trim() });
    resetVaultState(); await loadFiles(); await updateVaultChip(); refreshDevicesStatus(); updateRemoteIndicator();
    request("graph.build").then((g) => { graphData = g; if (current) renderBacklinks(current); }).catch(() => {});
    toast("Connected. You're now working on the master's vault, on its GPU.");
  } catch (e) { toast("Connect failed: " + e.message, "bad"); }
}
on("remote.lost", () => {
  for (const [, p] of pending) { try { p.reject(new Error("connection to the master was lost")); } catch { /* */ } }
  pending.clear(); // clear hung spinners for forwarded requests that will never get a reply
  toast("Lost the connection to the master machine. Back to this device.", "bad");
  request("master.disconnect").catch(() => {}); resetVaultState(); loadFiles().catch(() => {}); updateVaultChip(); updateRemoteIndicator();
});
$("remote-state").onclick = async () => {
  let m = {}; try { m = await request("master.status"); } catch { /* */ }
  if (m.connected) {
    if (!await confirmModal("Disconnect from the master machine? You'll go back to this device's own vault.", { title: "Disconnect?", okLabel: "Disconnect" })) return;
    try { await request("master.disconnect"); resetVaultState(); await loadFiles(); await updateVaultChip(); updateRemoteIndicator(); toast("Disconnected. Back on this machine."); }
    catch (e) { toast(e.message, "bad"); }
    return;
  }
  if (!await confirmModal("Disconnect from the remote machine? Chat goes back to local.", { title: "Disconnect?", okLabel: "Disconnect" })) return;
  try { await request("remote.disconnect"); updateRemoteIndicator(); toast("Disconnected. Running locally."); } catch (e) { toast(e.message, "bad"); }
};
async function shareGpu() {
  closeSettings();
  toast("Starting provider (this may take a few seconds)...");
  try {
    const d = await request("provider.start");
    prompt("This machine is now sharing its GPU. Paste this pairing code into your other device (Settings -> Devices -> Connect). Keep this app running to keep serving:", d.publicKey);
    updateRemoteIndicator();
  } catch (e) { toast("Could not start provider: " + e.message, "bad"); }
}
async function connectRemote() {
  closeSettings();
  const pk = prompt("Paste the remote machine's pairing code (the 64-hex public key from its 'Share GPU'):");
  if (!pk) return;
  toast("Connecting to the remote machine...");
  try { await request("remote.connect", { providerPublicKey: pk.trim(), baseKey: chatBase.value }); updateRemoteIndicator(); toast("Connected. Chat + agent now run on the remote machine; your vault stays here."); }
  catch (e) { toast("Connect failed: " + e.message, "bad"); }
}
async function updateRemoteIndicator() {
  try {
    const [s, m] = await Promise.all([request("remote.status"), request("master.status")]);
    const el = $("remote-state");
    if (m.connected) el.innerHTML = `<span style="color:var(--accent)">&#9889; on master machine</span>`;
    else if (m.master) el.innerHTML = `<span style="color:var(--accent2)">&#128421; master (vault shared)</span>`;
    else if (s.remote) el.innerHTML = `<span style="color:var(--accent)">&#9889; running on remote</span>`;
    else if (s.provider) el.innerHTML = `<span style="color:var(--accent2)">&#128225; sharing GPU</span>`;
    else el.innerHTML = "";
  } catch { /* */ }
}

// ============================================================ onboarding
const STEPS = [
  { art: "🔒", h: 'Welcome to <span class="accent">Second Self</span>', p: "An open-source second brain that learns to talk like you, and knows what you know. Your notes, your model, your machine. Nothing is ever uploaded.", cta: "Start" },
  { art: "🗂️", h: "1. Your <span class=\"accent\">vault</span>", p: "A vault is just a folder of your notes. Write them in markdown and connect them with <code>[[wiki-links]]</code>. You're starting on a small <b>demo vault</b> so you can explore right away. Create your own from Settings whenever you're ready.", cta: "Next" },
  { art: "🕸️", h: "2. See your <span class=\"accent\">knowledge graph</span>", p: 'Every note becomes a dot; related notes link up automatically, on-device. Search your notes in plain language (e.g. "notes about travel") and the matches light up.', cta: "Next" },
  { art: "🧬", h: "3. Train a model on <span class=\"accent\">you</span>", p: "In the <b>Chat &amp; Train</b> tab, click <b>Train your voice</b>. One click fine-tunes a small model on your selected notes, entirely on your GPU. The result writes in your voice.", cta: "Next" },
  { art: "💬", h: "4. Chat with your <span class=\"accent\">second self</span>", p: "Toggle Voice (your LoRA) and Memory (retrieval over your notes) to feel the difference between a generic model and one that is you. Press Cmd+K anytime for commands.", cta: "Let's go" },
];
let onboardStep = 0;
function renderOnboard() {
  const s = STEPS[onboardStep];
  const grid = onboardStep === 0 ? `<div class="feature-grid">
    <div class="f"><div class="i">🗂️</div><b>Vault</b><span>edit, link, search</span></div>
    <div class="f"><div class="i">🕸️</div><b>Graph</b><span>semantic map</span></div>
    <div class="f"><div class="i">🧬</div><b>Train</b><span>a LoRA on you</span></div></div>` : "";
  $("onboard-box").innerHTML = `<div class="onboard-art">${s.art}</div><h1>${s.h}</h1><p>${s.p}</p>${grid}
    <div class="onboard-steps">${STEPS.map((_, i) => `<span class="dot${i === onboardStep ? " on" : ""}"></span>`).join("")}</div>
    <div class="onboard-actions">${onboardStep > 0 ? '<button class="btn" id="ob-skip">Skip</button>' : '<button class="btn" id="ob-skip">Skip tour</button>'}<button class="btn primary" id="ob-next">${s.cta}</button></div>`;
  $("ob-next").onclick = () => { if (onboardStep < STEPS.length - 1) { onboardStep++; renderOnboard(); } else endOnboarding(); };
  $("ob-skip").onclick = endOnboarding;
}
function startOnboarding(force) { if (!force && localStorage.getItem("ss-onboarded")) return; onboardStep = 0; $("onboard").classList.add("show"); renderOnboard(); }
function endOnboarding() { $("onboard").classList.remove("show"); localStorage.setItem("ss-onboarded", "1"); }
$("onboard").addEventListener("click", (e) => { if (e.target === $("onboard")) endOnboarding(); });

// ============================================================ share card
function shareCard() {
  request("train.adapters").then((d) => {
    const a = d.adapters[0];
    const lines = a ? [`My second self`, `trained on my own notes`, `${a.baseKey} · ${a.sizeMB} MB adapter`, `runs 100% on my machine`, `never left my device`]
      : [`Second Self`, `${files.length} notes in my vault`, `train a model on yourself`, `100% local · open source`];
    toast(lines.join("  ·  "));
  });
}

// ============================================================ keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); palette.classList.contains("show") ? closePalette() : openPalette(); }
  else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); openPalette(true); }
  else if (e.key === "Escape") {
    closePalette(); hoverCard.style.display = "none";
    if (settings.classList.contains("show")) closeSettings();
    if (picker.classList.contains("show")) finishPick(null);
    if ($("fda").classList.contains("show")) closeFda();
    if ($("confirm").classList.contains("show")) closeConfirm(false);
    if (graphSide.classList.contains("show")) closeGraphSide();
    vaultPop.classList.remove("show");
    closeTrainDrawer();
    if ($("onboard").classList.contains("show")) endOnboarding();
  }
  else if (mod && e.key === "1") { e.preventDefault(); switchPane("vault"); }
  else if (mod && e.key === "2") { e.preventDefault(); switchPane("graph"); }
  else if (mod && e.key === "3") { e.preventDefault(); switchPane("chat"); }
});

// ============================================================ easter eggs + confetti
const fx = $("fx"); const fxc = fx.getContext("2d");
function confetti(burst = 120) {
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return; // respect motion preference
  fx.width = innerWidth; fx.height = innerHeight; fx.style.display = "block";
  const cols = ["#16e3c1", "#78aaff", "#ffd24f", "#ff6b6b", "#ffffff"];
  const ps = Array.from({ length: burst }, () => ({ x: innerWidth / 2, y: innerHeight / 2, vx: (Math.random() - .5) * 16, vy: (Math.random() - .5) * 16 - 4, r: 3 + Math.random() * 4, c: cols[Math.floor(Math.random() * cols.length)], life: 1 }));
  let frames = 0;
  (function anim() {
    fxc.clearRect(0, 0, fx.width, fx.height); frames++;
    for (const p of ps) { p.vy += 0.4; p.x += p.vx; p.y += p.vy; p.life -= 0.012; fxc.globalAlpha = Math.max(0, p.life); fxc.fillStyle = p.c; fxc.beginPath(); fxc.arc(p.x, p.y, p.r, 0, 7); fxc.fill(); }
    if (frames < 120) requestAnimationFrame(anim); else { fx.style.display = "none"; fxc.globalAlpha = 1; }
  })();
}
// konami code -> confetti + secret toast
const konami = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"]; let kpos = 0;
document.addEventListener("keydown", (e) => { kpos = (e.key === konami[kpos] || e.key.toLowerCase() === konami[kpos]) ? kpos + 1 : 0; if (kpos === konami.length) { kpos = 0; confetti(220); toast("🐻 you found the bear. QVAC says hi."); } });
// brand: click 5x -> confetti
let brandClicks = 0, brandTimer;
$("brand").onclick = () => { brandClicks++; clearTimeout(brandTimer); brandTimer = setTimeout(() => (brandClicks = 0), 800); if (brandClicks >= 5) { brandClicks = 0; confetti(); toast("✦ made local, with QVAC"); } };

// ============================================================ boot
(async () => {
  const connected = await new Promise((r) => { let n = 0; const t = setInterval(() => { if (ws && ws.readyState === 1) { clearInterval(t); r(true); } else if (++n > 160) { clearInterval(t); r(false); } }, 50); });
  if (!connected) { toast("Can't reach the local server. Is `npm start` running?", "bad"); statusLine.textContent = "offline"; return; }
  await loadFiles(); refreshAdapters(); updateRemoteIndicator(); updateVaultChip(); loadRetrainCfg();
  // background build for backlinks; guard so it never clobbers a graph the user
  // already built+embedded while this was in flight (would silently drop embed edges).
  request("graph.build").then((g) => { if (!graphData) { graphData = g; if (current) renderBacklinks(current); } }).catch(() => {});
  startOnboarding(false);
})();
