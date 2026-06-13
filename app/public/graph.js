// Canvas force-directed knowledge graph (no dependency, offline). Nodes = notes,
// edges = links/tags/embed-similarity. Pan, zoom, drag, hover, click, a "selected"
// set (training corpus) and a "highlight" set (NL query results, glowing).
//
// Hover dynamics (Obsidian-like) WITHOUT breaking selection: the hovered node grows
// in place (eased scale) and is PINNED under the cursor (fx/fy) so a click always lands;
// a gentle one-shot reheat lets neighbors declutter, then the sim settles again.
const EDGE_STYLE = {
  link:  { color: "rgba(120,170,255,0.55)", width: 1.4, dash: [] },
  tag:   { color: "rgba(150,150,170,0.30)", width: 0.8, dash: [4, 4] },
  embed: { color: "rgba(22,227,193,0.42)",  width: 1.0, dash: [2, 4] },
};

function hashHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

export class Graph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.nodes = []; this.edges = [];
    this.byId = new Map();
    this.selected = new Set();
    this.highlight = new Set();
    this.hover = null; this.dragging = null; this.hoverPin = null;
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.alpha = 1;
    this.accent = "#16e3c1";
    this.reduceMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.onClick = () => {};
    this._bind();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setData(graph) {
    // drop interaction refs: they point at the OLD node objects we are about to replace
    this.hover = this.hoverPin = this.dragging = null;
    const W = this.canvas.width || 800, H = this.canvas.height || 600;
    this.nodes = graph.nodes.map((n, i) => {
      const prev = this.byId.get(n.id);
      const ang = (i / graph.nodes.length) * Math.PI * 2;
      const r = Math.min(W, H) * 0.35;
      return Object.assign({}, n, {
        x: prev ? prev.x : W / 2 + Math.cos(ang) * r,
        y: prev ? prev.y : H / 2 + Math.sin(ang) * r,
        vx: 0, vy: 0, scale: 1, fx: null, fy: null,
        hue: hashHue(n.group || ""),
      });
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = graph.edges.filter((e) => this.byId.has(e.source) && this.byId.has(e.target));
    this.adj = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const e of this.edges) { this.adj.get(e.source).add(e.target); this.adj.get(e.target).add(e.source); }
    this.alwaysLabel = new Set([...this.nodes].sort((a, b) => b.degree - a.degree).slice(0, 12).map((n) => n.id));
    this.alpha = 1;
  }

  setSelected(ids) { this.selected = new Set(ids); }
  getSelected() { return [...this.selected]; }
  setHighlight(ids) { this.highlight = new Set(ids); this.alpha = Math.max(this.alpha, 0.2); }
  clearHighlight() { this.highlight = new Set(); }
  setAccent(c) { this.accent = c; }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left - this.ox) / this.scale, y: (e.clientY - r.top - this.oy) / this.scale }; };
    let panning = false, last = null, downAt = null;
    c.addEventListener("mousedown", (e) => {
      const p = pos(e); const n = this._hit(p);
      downAt = { x: e.clientX, y: e.clientY };
      if (n) { this.dragging = n; n.fx = p.x; n.fy = p.y; }
      else { panning = true; last = { x: e.clientX, y: e.clientY }; }
    });
    window.addEventListener("mousemove", (e) => {
      const p = pos(e);
      if (this.dragging) { this.dragging.x = this.dragging.fx = p.x; this.dragging.y = this.dragging.fy = p.y; this.alpha = Math.max(this.alpha, 0.3); }
      else if (panning) { this.ox += e.clientX - last.x; this.oy += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; }
      else {
        const n = this._hit(p);
        if (n !== this.hover) this._setHover(n);
        c.style.cursor = n ? "pointer" : "grab";
      }
    });
    window.addEventListener("mouseup", () => {
      if (this.dragging) { this.dragging.fx = this.dragging.fy = null; this.dragging = null; }
      panning = false;
    });
    c.addEventListener("mouseleave", () => this._setHover(null));
    c.addEventListener("click", (e) => {
      // ignore clicks that were really drags
      if (downAt && (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y)) > 5) return;
      const n = this._hit(pos(e)); if (n) this.onClick(n, e);
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.ox = mx - (mx - this.ox) * f; this.oy = my - (my - this.oy) * f; this.scale *= f;
    }, { passive: false });
  }

  _setHover(n) {
    // unpin previous hovered node (unless it is being dragged)
    if (this.hoverPin && this.hoverPin !== this.dragging) { this.hoverPin.fx = this.hoverPin.fy = null; }
    this.hover = n; this.hoverPin = null;
    if (n) { n.fx = n.x; n.fy = n.y; this.hoverPin = n; if (!this.reduceMotion) this.alpha = Math.max(this.alpha, 0.18); } // pin (+ gentle reheat unless reduced-motion)
  }

  _hit(p) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]; const rad = this._radius(n) * (n.scale || 1) + 5;
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= rad * rad) return n;
    }
    return null;
  }

  _radius(n) { return 3 + Math.min(10, Math.sqrt(n.degree || 0) * 2.2); }

  _tick() {
    const hl = this.hover ? this.adj.get(this.hover.id) : null;
    // ease per-node scale toward hover target (visual only -> never moves the node)
    for (const n of this.nodes) {
      const target = n === this.hover ? 1.6 : (hl && hl.has(n.id) ? 1.25 : 1);
      n.scale += (target - n.scale) * (this.reduceMotion ? 1 : 0.25); // snap if reduced-motion
    }
    if (this.alpha < 0.005) return;
    const W = this.canvas.width, H = this.canvas.height;
    const k = 0.04 * this.alpha;
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const b = this.nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy || 0.01;
        const rep = 1400 / d2;
        const d = Math.sqrt(d2); dx /= d; dy /= d;
        a.vx += dx * rep * k; a.vy += dy * rep * k; b.vx -= dx * rep * k; b.vy -= dy * rep * k;
      }
    }
    for (const e of this.edges) {
      const a = this.byId.get(e.source), b = this.byId.get(e.target);
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = 70; const f = (d - target) * 0.012 * (e.weight || 1) * this.alpha;
      dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of this.nodes) {
      n.vx += (W / 2 - n.x) * 0.0008 * this.alpha; n.vy += (H / 2 - n.y) * 0.0008 * this.alpha;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy;
    }
    this.alpha *= 0.992;
  }

  reheat() { this.alpha = 1; }

  _loop() {
    this._tick();
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    const hl = this.hover ? this.adj.get(this.hover.id) : null;
    const hasHL = this.highlight.size > 0;
    for (const e of this.edges) {
      const a = this.byId.get(e.source), b = this.byId.get(e.target);
      const st = EDGE_STYLE[e.kind] || EDGE_STYLE.link;
      const active = this.hover && (e.source === this.hover.id || e.target === this.hover.id);
      ctx.strokeStyle = active ? "rgba(255,255,255,0.75)" : st.color;
      ctx.lineWidth = (active ? st.width + 0.9 : st.width) / this.scale;
      ctx.setLineDash(st.dash.map((d) => d / this.scale));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of this.nodes) {
      const r = this._radius(n) * (n.scale || 1);
      const isHi = this.highlight.has(n.id);
      const dimByHover = this.hover && n !== this.hover && !(hl && hl.has(n.id));
      const dimByHL = hasHL && !isHi;
      const dim = dimByHover || dimByHL;
      const sel = this.selected.has(n.id);
      ctx.globalAlpha = dim ? 0.18 : 1;
      if (isHi) { // glow
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 / this.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,210,80,0.18)"; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHi ? "#ffd24f" : `hsl(${n.hue} 60% ${sel ? 62 : 55}%)`;
      ctx.fill();
      if (sel) { ctx.lineWidth = 2 / this.scale; ctx.strokeStyle = this.accent; ctx.stroke(); }
      const labelIt = n === this.hover || (hl && hl.has(n.id)) || sel || isHi || (this.alwaysLabel && this.alwaysLabel.has(n.id));
      if (this.scale > 0.5 && labelIt) {
        ctx.globalAlpha = dim ? 0.3 : 0.95; ctx.fillStyle = "#e7edf5";
        ctx.font = `${(n === this.hover ? 12.5 : 11) / this.scale}px ui-sans-serif, system-ui`;
        ctx.fillText(n.label, n.x + r + 3 / this.scale, n.y + 3 / this.scale);
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(this._loop);
  }

  resize(w, h) { this.canvas.width = w; this.canvas.height = h; }
  focus(id) { const n = this.byId.get(id); if (!n) return; this.ox = this.canvas.width / 2 - n.x * this.scale; this.oy = this.canvas.height / 2 - n.y * this.scale; this._setHover(n); }
}
