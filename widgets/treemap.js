// Canvas-based squarified treemap with zoom-in animation.
// Accepts a flat list of {path, value} leaves; builds the hierarchy by
// splitting paths on "/".

const STYLE = {
  padding: 4,
  header: 20,
  animMs: 350,
  border: "rgba(0,0,0,0.08)",
  bg: "#ffffff",
  hoverOverlay: "rgba(0,0,0,0.05)",
  fadeOverlay: "#ffffff",
  headerFont: "600 13px ui-sans-serif, system-ui, sans-serif",
  leafFont: "13px ui-sans-serif, system-ui, sans-serif",
};

const CONTAINER = "rgba(15, 23, 42, 0.04)";
const HEADER_TEXT = "rgba(15, 23, 42, 0.85)";

// Okabe–Ito palette, from https://siegal.bio.nyu.edu/color-palette/
// (Black omitted for root-level assignment — saved as a fallback slot.)
const PALETTE_HEX = [
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#009E73", // bluish green
  "#F0E442", // yellow
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#CC79A7", // reddish purple
  "#888888", // neutral grey fallback
];

// Convert a hex string to {h, s, l} in HSL percent space so we can nudge
// lightness per depth without changing hue.
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const PALETTE = PALETTE_HEX.map(hexToHsl);

function hslColor(h, s, l) {
  return `hsl(${h}deg ${s}% ${l}%)`;
}

// Assign colors so each top-level directory gets a distinct palette entry
// (sized-sorted so the biggest subtrees take the most recognizable hues).
// Descendants keep the parent's hue but lighten with depth so nested rects
// read as variations of the same family.
// Neutral grey for the "only one option" case — no point using a palette
// slot when there's nothing to distinguish it from.
const GREY = { h: 0, s: 0, l: 62 };

function assignColors(root) {
  // Root always renders as a neutral grey wrapper; its children get the
  // palette so the "inside" is colored regardless of whether a common
  // prefix had to be hoisted.
  root.color = hslColor(GREY.h, GREY.s, GREY.l);
  const sorted = [...root.children].sort((a, b) => b.value - a.value);
  const useGrey = sorted.length === 1;
  sorted.forEach((child, i) => {
    const base = useGrey ? GREY : PALETTE[i % PALETTE.length];
    paint(child, base, 1);
  });

  function paint(node, base, depth) {
    // nudge lightness up and saturation down with depth; clamp so deeper
    // levels stay readable without going fully white
    const light = Math.min(82, base.l + (depth - 1) * 6);
    const sat = Math.max(25, base.s - (depth - 1) * 8);
    node.color = hslColor(base.h, sat, light);
    for (const child of node.children) paint(child, base, depth + 1);
  }
}
const inset = () => STYLE.padding * 2;
const insetY = () => STYLE.header + STYLE.padding;

// ---------------------------------------------------------------- utilities

function formatDuration(seconds) {
  if (seconds < 1e-3) return `${Math.round(seconds * 1e6)}µs`;
  if (seconds < 1) return `${Math.round(seconds * 1e3)}ms`;
  return `${seconds.toFixed(2)}s`;
}

function truncate(ctx, text, font, maxWidth) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  if (maxWidth < 16) return "";
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo === 0 ? "" : text.slice(0, lo) + ellipsis;
}

// ----------------------------------------------------------- data → hierarchy

function buildHierarchy(leaves) {
  const root = { name: "", path: "", value: 0, children: new Map() };
  let total = 0;

  for (const { path, value } of leaves) {
    if (!(value > 0)) continue;
    total += value;

    const parts = path.split("/").filter(Boolean);
    let parent = root;
    parent.value += value;

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const kids = (parent.children ??= new Map());
      let node = kids.get(seg);
      if (!node) {
        node = {
          name: seg,
          path: parent.path ? `${parent.path}/${seg}` : seg,
          value: 0,
          children: i === parts.length - 1 ? null : new Map(),
        };
        kids.set(seg, node);
      }
      node.value += value;
      parent = node;
    }
  }

  const freeze = (node, parent) => {
    const result = {
      name: node.name,
      path: node.path,
      value: node.value,
      label: formatDuration(node.value),
      parent,
      children: [],
      color: "",
    };
    if (node.children) {
      result.children = [...node.children.values()]
        .map((c) => freeze(c, result))
        .sort((a, b) => b.value - a.value);
    }
    return result;
  };

  const frozen = freeze(root, null);

  // Collapse any single-child chain anywhere in the tree: if a node has
  // one non-leaf child, pull the grandchildren up and concatenate names.
  // Keeps rectangles from being wasted on directories with only one entry.
  function collapse(node) {
    while (node.children.length === 1 && node.children[0].children.length) {
      const only = node.children[0];
      node.name = node.name ? `${node.name}/${only.name}` : only.name;
      node.path = only.path;
      node.children = only.children;
      for (const c of node.children) c.parent = node;
    }
    for (const child of node.children) collapse(child);
  }
  collapse(frozen);

  assignColors(frozen);
  return { root: frozen, total };
}

// ------------------------------------------------------------ squarify layout
// See "Squarified Treemaps" — van Wijk. This is the standard recursive
// implementation: peel off a "row" that keeps aspect ratios best, recurse
// into the rectangles that fit inside, recurse on the remaining strip.

function squarify(items, rect) {
  const result = [];
  let [x, y, width, height] = rect;
  let cursor = 0;

  const ratio = (area, totalArea, shortSide) => {
    const max = items[cursor].value * area;
    const min = items[cursor + 0].value * area; // placeholder; replaced below
    return Math.max(
      (shortSide * shortSide * max) / (totalArea * totalArea),
      (totalArea * totalArea) / (shortSide * shortSide * min),
    );
  };

  while (cursor < items.length) {
    // total area left
    let remainingValue = 0;
    for (let i = cursor; i < items.length; i++) remainingValue += items[i].value;
    if (remainingValue <= 0) return result;

    const shortSide = Math.min(width, height);
    const perValue = (width * height) / remainingValue;

    // grow the run while aspect ratio improves
    let runEnd = cursor;
    let runArea = 0;
    let prevRatio = Infinity;

    while (runEnd < items.length) {
      const area = items[runEnd].value * perValue;
      if (area <= 0) {
        runEnd++;
        continue;
      }
      const nextArea = runArea + area;
      const max = items[cursor].value * perValue;
      const min = items[runEnd].value * perValue;
      const nextRatio = Math.max(
        (shortSide * shortSide * max) / (nextArea * nextArea),
        (nextArea * nextArea) / (shortSide * shortSide * min),
      );
      if (runEnd > cursor && prevRatio < nextRatio) break;
      runArea = nextArea;
      prevRatio = nextRatio;
      runEnd++;
    }

    // split the strip off; rectangles inside the strip get laid out
    const strip = Math.round(runArea / shortSide);
    let laidOut = 0;

    for (let i = cursor; i < runEnd; i++) {
      const item = items[i];
      const area = item.value * perValue;
      const lo = Math.round((shortSide * laidOut) / runArea);
      const hi = Math.round((shortSide * (laidOut + area)) / runArea);
      const box =
        width >= height
          ? [x, y + lo, strip, hi - lo]
          : [x + lo, y, hi - lo, strip];
      const innerKids =
        item.children.length && box[2] > inset() && box[3] > insetY()
          ? squarify(item.children, [
              box[0] + STYLE.padding,
              box[1] + STYLE.header,
              box[2] - inset(),
              box[3] - insetY(),
            ])
          : [];
      result.push({ node: item, box, children: innerKids });
      laidOut += area;
    }

    cursor = runEnd;
    if (width >= height) {
      x += strip;
      width -= strip;
    } else {
      y += strip;
      height -= strip;
    }
  }

  return result;
}

// ------------------------------------------------------------------- rendering

class Treemap {
  constructor(container, { leaves }) {
    this.host = container;
    const { root, total } = buildHierarchy(leaves);
    this.root = root;
    this.total = total;

    this.canvas = null;
    this.ctx = null;
    this.layout = [];
    this.focusNode = null; // data node the user is zoomed into (settled state)
    this.focusLayout = null;
    this.hovered = null;

    // When animating, `anim` is non-null with shape
    //   { from, to, anchor, start, progress, direction }
    // direction is 'in' (root → node) or 'out' (node → root).
    this.anim = null;
    this.animHandle = null;

    this.crumb = null;
    this.tooltip = null;

    this._build();
  }

  _build() {
    this.host.innerHTML = "";

    const sheet = document.createElement("style");
    sheet.textContent = `
      .tm-host { position: relative; font: 13px ui-sans-serif, system-ui, sans-serif; color: #1a1a1a; }
      .tm-host canvas { display: block; border: 1px solid #e0e0e0; border-radius: 4px; background: ${STYLE.bg}; }
      .tm-breadcrumb { font: 12px ui-monospace, monospace; color: #555; margin: 0 0 6px 0; }
      .tm-breadcrumb button {
        background: none; border: 0; color: #0969da; padding: 0;
        cursor: pointer; font: inherit;
      }
      .tm-breadcrumb button:hover { text-decoration: underline; }
      .tm-breadcrumb .sep { color: #999; }
      .tm-tooltip {
        position: absolute; pointer-events: none; display: none;
        background: #1e1e1e; color: #eee; padding: 6px 9px; border-radius: 4px;
        font: 11px ui-monospace, monospace; max-width: 480px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25); z-index: 5;
      }
      .tm-tooltip b { color: #fff; }
    `;
    this.host.appendChild(sheet);

    const wrap = document.createElement("div");
    wrap.className = "tm-host";
    this.host.appendChild(wrap);
    this.wrap = wrap;

    this.crumb = document.createElement("nav");
    this.crumb.className = "tm-breadcrumb";
    wrap.appendChild(this.crumb);

    this.canvas = document.createElement("canvas");
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tm-tooltip";
    wrap.appendChild(this.tooltip);

    this.canvas.addEventListener("mousemove", (e) => this._onHover(e));
    this.canvas.addEventListener("mouseleave", () => this._onLeave());
    this.canvas.addEventListener("click", (e) => this._onClick(e));

    new ResizeObserver(() => this._resize(wrap)).observe(wrap);
    this._resize(wrap);
    this._drawBreadcrumb();
  }

  _resize(wrap) {
    const ratio = window.devicePixelRatio || 1;
    const w = Math.min(wrap.clientWidth || 900, 1400);
    const h = Math.max(Math.round(w / 2), 400);
    this.w = w;
    this.h = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Render root as a visible wrapping frame; squarify recurses into the
    // children automatically (see layoutTreemap).
    this.layout = squarify([this.root], [0, 0, w - 1, h - 1]);
    this._recomputeFocus();
    this._draw();
  }

  _recomputeFocus() {
    // We need a focus layout if we are either currently focused on a node,
    // OR we are animating between root and a node (in either direction).
    const node = this.anim
      ? this.anim.direction === "in" ? this.anim.to : this.anim.from
      : this.focusNode;
    if (!node) {
      this.focusLayout = null;
      return;
    }
    const anchor = this.anim ? this.anim.anchor : this._findBox(node);
    if (!anchor) {
      this.focusLayout = null;
      return;
    }
    const [ox, oy, ow, oh] = anchor;
    let t;
    if (this.anim) {
      t = this.anim.direction === "in" ? this.anim.progress : 1 - this.anim.progress;
    } else {
      t = 1; // settled, fully zoomed
    }
    const px = Math.round(this.w / 10);
    const py = Math.round(this.h / 10);
    const tx = Math.round(ox + (px - ox) * t);
    const ty = Math.round(oy + (py - oy) * t);
    const tx2 = Math.round(ox + ow + (this.w - px - 1 - ox - ow) * t);
    const ty2 = Math.round(oy + oh + (this.h - py - 1 - oy - oh) * t);
    this.focusLayout = squarify([node], [tx, ty, tx2 - tx, ty2 - ty])[0];
  }

  _tick() {
    if (!this.anim) return;
    const raw = (performance.now() - this.anim.start) / STYLE.animMs;

    if (raw >= 1) {
      // settle: focusNode was updated at zoom time, just clear the anim
      this.anim = null;
      this.animHandle = null;
    } else {
      const t = Math.max(0, raw);
      const inv = 1 - t;
      this.anim.progress = 1 - inv * inv * inv; // cubic ease-out
      this.animHandle = requestAnimationFrame(() => this._tick());
    }
    this._recomputeFocus();
    this._draw();
  }

  _zoomTo(node, anchorBox) {
    const from = this.focusNode;
    const to = node;
    if (from === to) return;

    const direction = to ? "in" : "out";
    // Anchor = the rect the zoom originates from (zoom in) or collapses back
    // to (zoom out). For 'out' we need the rect of the *leaving* node.
    const anchor =
      direction === "in"
        ? anchorBox || this._findBox(to) || [0, 0, this.w, this.h]
        : this._findBox(from) || [0, 0, this.w, this.h];

    this.focusNode = to; // settled destination
    this.anim = {
      from,
      to,
      direction,
      anchor,
      start: performance.now(),
      progress: 0,
    };
    if (this.animHandle === null) {
      this.animHandle = requestAnimationFrame(() => this._tick());
    }
    this._drawBreadcrumb();
  }

  _findBox(node) {
    if (!node) return null;
    const walk = (items) => {
      for (const item of items) {
        if (item.node === node) return item.box;
        const b = walk(item.children);
        if (b) return b;
      }
      return null;
    };
    return walk(this.layout);
  }

  _paintNode(layout) {
    const [x, y, w, h] = layout.box;
    const { ctx } = this;

    if (layout.children.length > 0) {
      // container frame uses the node's hue so ancestry is visible
      ctx.fillStyle = layout.node.color;
      ctx.fillRect(x, y, w, STYLE.header);
      ctx.fillRect(x, y + h - STYLE.padding, w, STYLE.padding);
      ctx.fillRect(x, y + STYLE.header, STYLE.padding, h - insetY());
      ctx.fillRect(x + w - STYLE.padding, y + STYLE.header, STYLE.padding, h - insetY());
      // subtle wash in the interior so the container is still visible when
      // children don't fill it edge-to-edge
      ctx.fillStyle = CONTAINER;
      ctx.fillRect(x + STYLE.padding, y + STYLE.header, w - inset(), h - insetY());
    } else {
      ctx.fillStyle = layout.node.color;
      ctx.fillRect(x, y, w, h);
    }
    for (const child of layout.children) this._paintNode(child);
  }

  _labelNode(layout, inFocus) {
    const node = layout.node;
    const [x, y, w, h] = layout.box;
    const { ctx } = this;

    if (this.hovered === node && (!this.focusLayout || inFocus)) {
      ctx.fillStyle = STYLE.hoverOverlay;
      if (node.children.length) {
        // container: overlay only the frame we actually painted, leave the
        // interior alone so children aren't washed out
        ctx.fillRect(x, y, w, STYLE.header);
        ctx.fillRect(x, y + h - STYLE.padding, w, STYLE.padding);
        ctx.fillRect(x, y + STYLE.header, STYLE.padding, h - insetY());
        ctx.fillRect(x + w - STYLE.padding, y + STYLE.header, STYLE.padding, h - insetY());
      } else {
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.strokeStyle = STYLE.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);

    if (h < STYLE.header) return;

    ctx.textBaseline = "middle";
    const font = node.children.length ? STYLE.headerFont : STYLE.leafFont;
    const maxWidth = w - inset();
    const name = truncate(ctx, node.name, font, maxWidth);

    ctx.font = font;
    const nameW = ctx.measureText(name).width;
    const textY = y + Math.round(insetY() / 2);

    if (node.children.length) {
      // try to fit " – <size>" alongside the bold name
      ctx.font = STYLE.leafFont;
      const detail = ` – ${node.label}`;
      const detailW = ctx.measureText(detail).width;
      const combined = nameW + detailW;
      const startX =
        combined <= maxWidth
          ? x + Math.round((w - combined) / 2)
          : x + Math.round((w - nameW) / 2);

      ctx.font = font;
      ctx.fillStyle = HEADER_TEXT;
      ctx.fillText(name, startX, textY);

      if (combined <= maxWidth) {
        ctx.font = STYLE.leafFont;
        ctx.globalAlpha = 0.6;
        ctx.fillText(detail, startX + nameW, textY);
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.font = font;
      ctx.fillStyle = "rgba(15,23,42,0.85)";
      ctx.fillText(name, x + Math.round((w - nameW) / 2), textY);
      if (h > insetY() + 14) {
        ctx.globalAlpha = 0.55;
        const dW = ctx.measureText(node.label).width;
        ctx.fillText(
          node.label,
          x + Math.round((w - dW) / 2),
          y + STYLE.header + Math.round((h - insetY()) / 2),
        );
        ctx.globalAlpha = 1;
      }
    }

    for (const child of layout.children) this._labelNode(child, inFocus);
  }

  _draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);

    for (const item of this.layout) this._paintNode(item);
    for (const item of this.layout) this._labelNode(item, false);

    // fade the whole background once we've locked a focus
    if (this.focusLayout) {
      let faded;
      if (this.anim) {
        faded = this.anim.direction === "in"
          ? this.anim.progress
          : 1 - this.anim.progress;
      } else {
        faded = 1;
      }
      ctx.fillStyle = STYLE.fadeOverlay;
      ctx.globalAlpha = 0.7 * faded;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;

      // drop shadow + redraw the focus on top
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 4;
      const [fx, fy, fw, fh] = this.focusLayout.box;
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(fx, fy, fw, fh);
      ctx.restore();

      this._paintNode(this.focusLayout);
      this._labelNode(this.focusLayout, true);
    }
  }

  _hit(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    const walk = (items, isRoot) => {
      for (const item of items) {
        const [x, y, w, h] = item.box;
        if (mx >= x && my >= y && mx < x + w && my < y + h) {
          return walk(item.children, false) || (isRoot ? null : item);
        }
      }
      return null;
    };

    return this.focusLayout
      ? walk([this.focusLayout], false)
      : walk(this.layout, true);
  }

  _onHover(ev) {
    const hit = this._hit(ev);
    const next = hit && hit.node;
    if (next !== this.hovered) {
      this.hovered = next;
      this.canvas.style.cursor = hit ? "pointer" : "default";
      this._draw();
    }
    if (!hit) {
      this.tooltip.style.display = "none";
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    this.tooltip.style.display = "block";
    this.tooltip.style.left = `${ev.clientX - rect.left + 12}px`;
    this.tooltip.style.top = `${ev.clientY - rect.top + 12}px`;
    this.tooltip.innerHTML = `<b>${hit.node.path}</b><br/>${hit.node.label} · ${(
      (hit.node.value / this.total) *
      100
    ).toFixed(1)}%`;
  }

  _onLeave() {
    this.hovered = null;
    this.tooltip.style.display = "none";
    this._draw();
  }

  _onClick(ev) {
    const hit = this._hit(ev);
    if (!hit) return;
    if (hit.node.children.length) this._zoomTo(hit.node, hit.box);
  }

  _drawBreadcrumb() {
    this.crumb.innerHTML = "";
    const stack = [];
    let current = this.focusNode;
    while (current && current.parent) {
      stack.unshift(current);
      current = current.parent;
    }

    const home = document.createElement("button");
    home.type = "button";
    home.textContent = this.root.name || "root";
    home.onclick = () => this._zoomTo(null);
    this.crumb.appendChild(home);

    for (const node of stack) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = " / ";
      this.crumb.appendChild(sep);
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = node.name;
      b.onclick = () => this._zoomTo(node);
      this.crumb.appendChild(b);
    }

    const summary = this.focusNode || this.root;
    const meta = document.createElement("span");
    meta.textContent = `   (${formatDuration(summary.value)}, ${summary.children.length} children)`;
    this.crumb.appendChild(meta);
  }
}

function render({ model, el }) {
  new Treemap(el, { leaves: model.get("leaves") || [] });
}

export default { render };
