// Build the knowledge graph from a vault: nodes = notes, edges = how they connect.
// Edge kinds: "link" (explicit [[wikilink]] / md link), "tag" (shared #tag),
// "embed" (semantic similarity, merged in later from the embedder). Folders are a
// node GROUP (color), not edges, so dense vaults stay readable.
import path from "node:path";

// Resolve an Obsidian-style link target to a node path.
// Accepts a wikilink name ("My Note"), a relative md path ("dir/My Note.md"),
// or a bare basename. Match by exact relpath, then by basename (no ext), then title.
function resolveTarget(target, byPath, byBase, byTitle) {
  const t = target.replace(/\\/g, "/").trim();
  if (byPath.has(t)) return byPath.get(t);
  const noExt = t.replace(/\.(md|markdown|txt)$/i, "");
  const base = noExt.split("/").pop().toLowerCase();
  if (byBase.has(base)) return byBase.get(base);
  if (byTitle.has(noExt.toLowerCase())) return byTitle.get(noExt.toLowerCase());
  return null;
}

// vault: a Vault instance. Returns { nodes, edges, stats }.
export function buildGraph(vault) {
  const files = vault.list();
  const byPath = new Map();   // relpath -> id
  const byBase = new Map();   // basename(no ext, lc) -> id
  const byTitle = new Map();  // title(lc) -> id
  const nodes = files.map((f, i) => {
    const id = f.path;
    byPath.set(f.path, id);
    byBase.set(f.name.replace(/\.(md|markdown|txt)$/i, "").toLowerCase(), id);
    byTitle.set(f.title.toLowerCase(), id);
    const group = f.dir ? f.dir.split("/")[0] : "(root)";
    return { id, label: f.title, path: f.path, group, size: f.size, degree: 0, tags: [] };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, kind, weight = 1) => {
    if (a === b) return;
    const key = a < b ? `${a} ${b} ${kind}` : `${b} ${a} ${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: a, target: b, kind, weight });
    nodeById.get(a).degree++;
    nodeById.get(b).degree++;
  };

  // Pass 1: link + tag edges from each note's content.
  const tagIndex = new Map(); // tag -> [id]
  for (const f of files) {
    let content = "";
    try { content = vault.read(f.path); } catch { continue; }
    const id = byPath.get(f.path);
    for (const target of vault.parseLinks(content)) {
      const dst = resolveTarget(target, byPath, byBase, byTitle);
      if (dst) addEdge(id, dst, "link", 2);
    }
    const tags = vault.parseTags(content);
    nodeById.get(id).tags = tags;
    for (const tag of tags) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, []);
      tagIndex.get(tag).push(id);
    }
  }
  // Shared-tag edges (light): connect notes that share a tag, capped per tag to avoid cliques.
  for (const [, ids] of tagIndex) {
    if (ids.length < 2 || ids.length > 12) continue; // skip ubiquitous tags
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j], "tag", 0.5);
  }

  const stats = {
    notes: nodes.length,
    links: edges.filter((e) => e.kind === "link").length,
    tagEdges: edges.filter((e) => e.kind === "tag").length,
    orphans: nodes.filter((n) => n.degree === 0).length,
    groups: [...new Set(nodes.map((n) => n.group))].sort(),
  };
  return { nodes, edges, stats };
}

// Merge semantic-similarity edges (from the embedder) into an existing graph.
// pairs: [{ a: relpath, b: relpath, score }]. Adds "embed" edges above a threshold.
export function addEmbedEdges(graph, pairs, threshold = 0.6) {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Normalize the dedup key (sorted endpoints) for BOTH existing + new edges, else a
  // re-embed double-counts degree when a pair was first pushed in the opposite order.
  const norm = (s, t, k) => (s < t ? `${s} ${t} ${k}` : `${t} ${s} ${k}`);
  const seen = new Set(graph.edges.map((e) => norm(e.source, e.target, e.kind)));
  let added = 0;
  for (const { a, b, score } of pairs) {
    if (score < threshold || !ids.has(a) || !ids.has(b) || a === b) continue;
    const key = norm(a, b, "embed");
    if (seen.has(key)) continue;
    seen.add(key);
    graph.edges.push({ source: a, target: b, kind: "embed", weight: Number(score.toFixed(3)) });
    nodeById.get(a).degree++; nodeById.get(b).degree++;
    added++;
  }
  graph.stats.embedEdges = (graph.stats.embedEdges || 0) + added;
  return graph;
}
