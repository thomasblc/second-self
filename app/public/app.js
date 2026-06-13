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
    if (!ws || ws.readyState !== 1) return reject(new Error("not connected"));
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, ...payload }));
  });
}
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { statusLine.innerHTML = 'connected <span class="kbd">Cmd K</span>'; };
  ws.onclose = () => { statusLine.textContent = "disconnected, retrying..."; setTimeout(connect, 1500); };
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
const panes = { vault: "vault-pane", graph: "graph-pane", chat: "chat-pane", models: "models-pane" };
function switchPane(name) {
  document.querySelectorAll(".rail-btn[data-pane]").forEach((x) => { const on = x.dataset.pane === name; x.classList.toggle("active", on); if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
  Object.entries(panes).forEach(([k, id]) => $(id).classList.toggle("active", k === name));
  if (name === "graph") { ensureGraph(); sizeGraph(); }
  if (name === "models") ensureModels();
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
  renderTree();
  if (!$("vault-pane").classList.contains("active")) switchPane("vault");
}
function confirmDiscard() { return !dirty || confirm("Discard unsaved changes?"); }
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
  if (!current || !confirm("Delete " + current + "?")) return;
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
graph.onClick = (n, e) => { if (e && e.shiftKey) toggleSelect(n.id); else openNote(n.path); };
function sizeGraph() { const r = $("graph-left").getBoundingClientRect(); graph.resize(r.width, r.height); graph.reheat(); }
window.addEventListener("resize", () => { if ($("graph-pane").classList.contains("active")) sizeGraph(); });
async function ensureGraph() {
  if (graphData) { graph.setData(graphData); return; }
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
$("hl-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runHighlight(e.target.value); });
$("btn-hl-clear").onclick = () => { graph.clearHighlight(); $("hl-input").value = ""; $("btn-hl-clear").style.display = "none"; };

// selection (training corpus)
let selection = new Set();
function toggleSelect(id) { selection.has(id) ? selection.delete(id) : selection.add(id); syncSelection(); }
function syncSelection() { graph.setSelected(selection); $("sel-count").textContent = selection.size; }
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
  if (!d.adapters.length) { el.textContent = "none yet - train one in section 2"; sel.innerHTML = `<option value="" disabled>no adapter - train one first</option>`; return; }
  el.innerHTML = d.adapters.map((a) => `<div>&#9679; ${a.file.replace("adapters/", "")} <span style="color:var(--mut)">(${a.baseKey}, ${a.sizeMB} MB)</span></div>`).join("");
  sel.innerHTML = d.adapters.map((a) => `<option value="${a.file}" data-base="${a.baseKey}">${a.file.replace("adapters/", "")}</option>`).join("");
}

// ============================================================ chat
const messages = $("messages"), chatText = $("chat-text"), tgVoice = $("tg-voice"), tgMemory = $("tg-memory"), chatAdapter = $("chat-adapter"), chatBase = $("chat-base");
let history = [], curAssistantEl = null, chatBusy = false;
tgVoice.onchange = () => {
  const hasAdapter = [...chatAdapter.options].some((o) => o.value);
  if (tgVoice.checked && !hasAdapter) { tgVoice.checked = false; chatAdapter.style.display = "none"; toast("Train a LoRA first (Graph + Train), then turn on Voice.", "warn"); return; }
  chatAdapter.style.display = tgVoice.checked ? "" : "none";
};
chatAdapter.onchange = () => { const o = chatAdapter.selectedOptions[0]; if (o) chatBase.value = o.dataset.base; };
async function ingest() {
  const btn = $("btn-ingest"); btn.textContent = "indexing..."; btn.disabled = true;
  try { const d = await request("rag.ingest", { paths: selection.size ? [...selection] : undefined }); btn.textContent = `indexed ${d.ingested} docs ✓`; toast(`Indexed ${d.ingested} docs (${d.chunks} chunks)`); }
  catch (e) { btn.textContent = "index failed"; toast(e.message, "bad"); }
  finally { btn.disabled = false; setTimeout(() => (btn.textContent = "Index vault for memory"), 2500); }
}
$("btn-ingest").onclick = ingest;
on("chat.token", (m) => { if (curAssistantEl) { curAssistantEl._raw += m.text; curAssistantEl.querySelector(".body").innerHTML = renderMarkdown(curAssistantEl._raw); messages.scrollTop = messages.scrollHeight; } });
on("chat.warn", (m) => toast(m.message, "warn"));
function addMsg(role, text) {
  if (messages.querySelector(".empty")) messages.innerHTML = "";
  const el = document.createElement("div"); el.className = "msg " + role; el._raw = text || "";
  el.innerHTML = (role === "assistant" ? `<div class="who">second self</div>` : "") + `<div class="body">${renderMarkdown(text || "")}</div>`;
  messages.appendChild(el); messages.scrollTop = messages.scrollHeight; return el;
}
async function send() {
  if (chatBusy) return;
  const text = chatText.value.trim(); if (!text) return;
  chatBusy = true; $("btn-send").disabled = true; chatText.value = "";
  addMsg("user", text);
  curAssistantEl = addMsg("assistant", ""); curAssistantEl.querySelector(".body").innerHTML = `<span class="spin"></span>`; curAssistantEl._raw = "";
  const voice = tgVoice.checked, memory = tgMemory.checked;
  const adapter = voice && chatAdapter.value ? chatAdapter.value : null, baseKey = chatBase.value;
  $("chat-model-state").textContent = `loading ${baseKey}${adapter ? "+LoRA" : ""}${memory ? "+memory" : ""}...`;
  try {
    const d = await request("chat.send", { message: text, history, baseKey, adapter, voice, memory });
    history.push({ role: "user", content: text }, { role: "assistant", content: d.contentText });
    if (history.length > 12) history = history.slice(-12);
    if (d.hits && d.hits.length) { const h = document.createElement("div"); h.className = "hits"; h.innerHTML = "memory used: " + d.hits.map((x) => `<span class="hit-score">${x.score?.toFixed(2)}</span>`).join(" "); curAssistantEl.appendChild(h); }
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
  try { const d = await request("model.catalog"); renderModels(d.models); modelsLoaded = true; }
  catch (e) { el.innerHTML = `<div class="empty">could not load catalog: ${escapeHtml(e.message)}</div>`; }
}
function renderModels(models) {
  const el = $("models-list"); el.innerHTML = "";
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
  card.innerHTML = `<div class="mc-main">
      <div class="mc-title">${escapeHtml(m.label)} ${m.fineTunable ? '<span class="mc-badge ft">fine-tunable</span>' : ""} <span class="mc-badge">${m.params} · ${m.quant}</span></div>
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
    del.onclick = async () => { if (!confirm(`Delete ${m.label} from your machine?`)) return; try { await request("model.delete", { name: m.name }); m.cached = false; renderCardStatus(card, m); toast(`Deleted ${m.label}`); } catch (e) { toast(e.message, "bad"); } };
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
    { ico: "◰", label: "Go to Vault", run: () => switchPane("vault") },
    { ico: "◓", label: "Go to Graph + Train", run: () => switchPane("graph") },
    { ico: "✉", label: "Go to Chat", run: () => switchPane("chat") },
    { ico: "⤓", label: "Models: download / manage", run: () => switchPane("models") },
    { ico: "◑", label: "Cycle theme (dark / light / QVAC)", run: cycleTheme },
    { ico: "◉", label: "Build knowledge graph", run: () => { switchPane("graph"); $("btn-graph-build").click(); } },
    { ico: "✨", label: "Add semantic links", run: () => { switchPane("graph"); $("btn-graph-embed").click(); } },
    { ico: "⦿", label: "Auto-select relevant docs", run: () => { switchPane("graph"); autoSelect(); } },
    { ico: "▶", label: "Start training", run: () => { switchPane("graph"); trainBtn.click(); } },
    { ico: "🧠", label: "Index vault for memory", run: ingest },
    { ico: "✨", label: "Highlight notes by query...", run: () => { switchPane("graph"); setTimeout(() => $("hl-input").focus(), 50); } },
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

// ============================================================ settings menu
const settingsMenu = $("settings-menu");
$("btn-settings").onclick = (e) => { e.stopPropagation(); settingsMenu.classList.toggle("show"); };
document.addEventListener("click", (e) => { if (!settingsMenu.contains(e.target) && e.target !== $("btn-settings")) settingsMenu.classList.remove("show"); });
$("set-theme").onclick = (e) => { if (!e.target.classList.contains("theme-dot")) cycleTheme(); };
$("set-vault").onclick = changeVault;
$("set-onboard").onclick = () => { settingsMenu.classList.remove("show"); startOnboarding(true); };
$("set-ingest").onclick = () => { settingsMenu.classList.remove("show"); ingest(); };
async function changeVault() {
  settingsMenu.classList.remove("show");
  if (!await confirmDiscard()) return;
  const info = await request("vault.info");
  const root = prompt("Vault folder (absolute path):", info.root);
  if (!root || root === info.root) return;
  try { await request("vault.setRoot", { path: root }); graphData = null; current = null; selection = new Set(); editor.value = ""; preview.innerHTML = ""; noteTitle.textContent = "No note open"; await loadFiles(); toast("Vault: " + root); }
  catch (e) { toast(e.message, "bad"); }
}

// ============================================================ onboarding
const STEPS = [
  { art: "🔒", h: 'Welcome to <span class="accent">Second Self</span>', p: "An open-source second brain that learns to talk like you, and knows what you know. Your notes, your model, your machine. Nothing is ever uploaded.", cta: "Start" },
  { art: "🗂️", h: "1. Your <span class=\"accent\">vault</span>", p: "Write and link markdown notes like Obsidian. Press + to create one, [[wikilink]] to connect them. The demo opens on a sample vault you can replace anytime in Settings.", cta: "Next" },
  { art: "🕸️", h: "2. See your <span class=\"accent\">knowledge graph</span>", p: 'Every note becomes a node. The app draws semantic links between related notes on-device, then auto-picks the docs worth training on. Try "highlight all docs of the recipe".', cta: "Next" },
  { art: "🧬", h: "3. Train a model on <span class=\"accent\">you</span>", p: "One click fine-tunes a small LoRA on your selected notes. It runs entirely on your GPU. The result is a model that writes in your voice.", cta: "Next" },
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
  else if (e.key === "Escape") { closePalette(); hoverCard.style.display = "none"; settingsMenu.classList.remove("show"); if ($("onboard").classList.contains("show")) endOnboarding(); }
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
  await loadFiles(); refreshAdapters();
  // background build for backlinks; guard so it never clobbers a graph the user
  // already built+embedded while this was in flight (would silently drop embed edges).
  request("graph.build").then((g) => { if (!graphData) { graphData = g; if (current) renderBacklinks(current); } }).catch(() => {});
  startOnboarding(false);
})();
