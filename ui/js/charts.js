"use strict";
/* charts.js — responsive inline-SVG charts. CWC.charts.{line,slope,barH,scatter,spark}
   Each chart: <svg viewBox> responsive, text >=11 units, preceded by a visually-hidden
   <table class="vh"> data table, colors from tokens, single 300ms draw-in gated by
   prefers-reduced-motion. */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const SVGNS = "http://www.w3.org/2000/svg";
  const reduce = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function svgEl(name, attrs) {
    const e = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function color(tok) {
    // tok may be a raw token name ("--green"), a var() ref, or a hex from data.
    if (!tok) return "var(--blue)";
    if (tok.startsWith("--")) return "var(" + tok + ")";
    return tok;
  }
  function clear(el) { el.innerHTML = ""; el.classList.add("cwc-chart"); }

  // Build the hidden data table used for accessibility / SR.
  function dataTable(headers, rows) {
    const t = CWC.el("table", "vh");
    const thead = CWC.el("thead"); const htr = CWC.el("tr");
    headers.forEach(h => htr.appendChild(CWC.el("th", null, h)));
    thead.appendChild(htr); t.appendChild(thead);
    const tb = CWC.el("tbody");
    rows.forEach(r => {
      const tr = CWC.el("tr");
      r.forEach(c => tr.appendChild(CWC.el("td", null, String(c))));
      tb.appendChild(tr);
    });
    t.appendChild(tb); return t;
  }

  function drawIn(svg) {
    if (reduce()) return;
    svg.style.opacity = "0";
    // single 300ms fade/scale draw-in
    svg.animate ? svg.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 300, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }
    ) : (svg.style.opacity = "1");
    requestAnimationFrame(() => { svg.style.opacity = "1"; });
  }

  function mount(el, svg, table) {
    clear(el);
    if (table) el.appendChild(table);
    el.appendChild(svg);
    drawIn(svg);
    return svg;
  }

  function extent(vals) {
    let lo = Infinity, hi = -Infinity;
    vals.forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    return [lo, hi];
  }

  CWC.charts = {
    /* ---- line ---- */
    line(el, cfg) {
      const w = cfg.w || 640, h = cfg.h || 320;
      const pad = { t: 14, r: 16, b: 34, l: 46 };
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
      const series = cfg.series || [];
      const allX = [], allY = [];
      series.forEach(s => s.points.forEach(p => { allX.push(p[0]); allY.push(p[1]); }));
      const [x0, x1] = extent(allX), [y0, y1] = extent(allY);
      const sx = v => pad.l + (iw * (v - x0)) / (x1 - x0);
      const sy = v => pad.t + ih - (ih * (v - y0)) / (y1 - y0);
      const yfmt = (cfg.y && cfg.y.fmt) || (v => String(Math.round(v)));

      const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "cwc-svg", role: "img",
        "aria-label": ((cfg.x && cfg.x.label) || "x") + " vs " + ((cfg.y && cfg.y.label) || "y") });
      // axes
      svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + ih, stroke: "var(--line-strong)" }));
      svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t + ih, x2: pad.l + iw, y2: pad.t + ih, stroke: "var(--line-strong)" }));
      // y ticks (4)
      for (let i = 0; i <= 4; i++) {
        const yv = y0 + (y1 - y0) * i / 4; const yy = sy(yv);
        svg.appendChild(svgEl("line", { x1: pad.l, y1: yy, x2: pad.l + iw, y2: yy, stroke: "var(--line)", "stroke-dasharray": "2 4" }));
        const tx = svgEl("text", { x: pad.l - 6, y: yy + 4, "text-anchor": "end", fill: "var(--dim)", "font-size": 11, "font-family": "var(--mono)" });
        tx.textContent = yfmt(yv); svg.appendChild(tx);
      }
      // optional band
      if (cfg.band) {
        svg.appendChild(svgEl("rect", { x: pad.l, y: sy(cfg.band[1]), width: iw,
          height: Math.abs(sy(cfg.band[0]) - sy(cfg.band[1])), fill: "var(--accent-bg)" }));
      }
      // series
      series.forEach(s => {
        const d = s.points.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join(" ");
        svg.appendChild(svgEl("path", { d, fill: "none", stroke: color(s.color), "stroke-width": 2, "stroke-linejoin": "round" }));
      });
      // axis labels
      const xl = svgEl("text", { x: pad.l + iw / 2, y: h - 6, "text-anchor": "middle", fill: "var(--dim)", "font-size": 11 });
      xl.textContent = (cfg.x && cfg.x.label) || ""; svg.appendChild(xl);
      const yl = svgEl("text", { x: 12, y: pad.t + ih / 2, "text-anchor": "middle", fill: "var(--dim)", "font-size": 11, transform: `rotate(-90 12 ${pad.t + ih / 2})` });
      yl.textContent = (cfg.y && cfg.y.label) || ""; svg.appendChild(yl);

      const rows = [];
      series.forEach(s => s.points.forEach(p => rows.push([s.label, p[0], yfmt(p[1])])));
      return mount(el, svg, dataTable(["series", (cfg.x && cfg.x.label) || "x", (cfg.y && cfg.y.label) || "y"], rows));
    },

    /* ---- slope ---- */
    slope(el, cfg) {
      const w = cfg.w || 480, h = cfg.h || 320;
      const pad = { t: 30, b: 20, l: 70, r: 70 };
      const rows = cfg.rows || [];
      const fmt = cfg.fmt || (v => String(v));
      const vals = []; rows.forEach(r => { vals.push(r.a, r.b); });
      const [y0, y1] = extent(vals);
      const sy = v => pad.t + (h - pad.t - pad.b) - ((h - pad.t - pad.b) * (v - y0)) / (y1 - y0);
      const xL = pad.l, xR = w - pad.r;

      const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "cwc-svg", role: "img", "aria-label": "slope chart" });
      const tl = svgEl("text", { x: xL, y: 16, "text-anchor": "middle", fill: "var(--dim)", "font-size": 11 });
      tl.textContent = (cfg.left && cfg.left.label) || "before"; svg.appendChild(tl);
      const tr = svgEl("text", { x: xR, y: 16, "text-anchor": "middle", fill: "var(--dim)", "font-size": 11 });
      tr.textContent = (cfg.right && cfg.right.label) || "after"; svg.appendChild(tr);
      svg.appendChild(svgEl("line", { x1: xL, y1: pad.t, x2: xL, y2: h - pad.b, stroke: "var(--line)" }));
      svg.appendChild(svgEl("line", { x1: xR, y1: pad.t, x2: xR, y2: h - pad.b, stroke: "var(--line)" }));

      rows.forEach(r => {
        const ya = sy(r.a), yb = sy(r.b);
        const col = color(r.color);
        svg.appendChild(svgEl("line", { x1: xL, y1: ya, x2: xR, y2: yb, stroke: col, "stroke-width": r.emph ? 3 : 1.5, opacity: r.emph ? 1 : 0.8 }));
        svg.appendChild(svgEl("circle", { cx: xL, cy: ya, r: 3, fill: col }));
        svg.appendChild(svgEl("circle", { cx: xR, cy: yb, r: 3, fill: col }));
        const la = svgEl("text", { x: xL - 8, y: ya + 4, "text-anchor": "end", fill: "var(--ink-2)", "font-size": 11, "font-family": "var(--mono)" });
        la.textContent = r.label + " " + fmt(r.a); svg.appendChild(la);
        const lb = svgEl("text", { x: xR + 8, y: yb + 4, "text-anchor": "start", fill: "var(--ink-2)", "font-size": 11, "font-family": "var(--mono)" });
        lb.textContent = fmt(r.b); svg.appendChild(lb);
      });

      return mount(el, svg, dataTable(["row", (cfg.left && cfg.left.label) || "a", (cfg.right && cfg.right.label) || "b"],
        rows.map(r => [r.label, fmt(r.a), fmt(r.b)])));
    },

    /* ---- horizontal bars ---- */
    barH(el, cfg) {
      const w = cfg.w || 560;
      const rows = cfg.rows || [];
      const fmt = cfg.fmt || (v => String(v));
      const rowH = 26, pad = { t: 8, b: 8, l: 120, r: 60 };
      const h = pad.t + pad.b + rows.length * rowH;
      const iw = w - pad.l - pad.r;
      const vals = rows.map(r => r.value);
      const maxV = Math.max(1, ...vals);
      const tx = v => {
        if (cfg.log) {
          const lo = Math.max(1, Math.min(...vals.filter(x => x > 0), maxV));
          return (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(maxV) - Math.log(lo) || 1) * iw;
        }
        return (v / maxV) * iw;
      };
      const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "cwc-svg", role: "img", "aria-label": "bar chart" });
      rows.forEach((r, i) => {
        const y = pad.t + i * rowH + 4;
        const lab = svgEl("text", { x: pad.l - 8, y: y + 12, "text-anchor": "end", fill: "var(--ink-2)", "font-size": 11 });
        lab.textContent = r.label; svg.appendChild(lab);
        svg.appendChild(svgEl("rect", { x: pad.l, y, width: iw, height: rowH - 10, rx: 4, fill: "var(--surface-2)" }));
        svg.appendChild(svgEl("rect", { x: pad.l, y, width: Math.max(1, tx(r.value)).toFixed(1), height: rowH - 10, rx: 4, fill: color(r.color) }));
        const val = svgEl("text", { x: pad.l + iw + 6, y: y + 12, "text-anchor": "start", fill: "var(--ink)", "font-size": 11, "font-family": "var(--mono)" });
        val.textContent = r.annot != null ? r.annot : fmt(r.value); svg.appendChild(val);
      });
      return mount(el, svg, dataTable(["label", "value"], rows.map(r => [r.label, fmt(r.value)])));
    },

    /* ---- scatter ---- */
    scatter(el, cfg) {
      const w = cfg.w || 560, h = cfg.h || 360;
      const pad = { t: 14, r: 16, b: 34, l: 46 };
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
      const pts = cfg.points || [];
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      let [x0, x1] = extent(xs); const [y0, y1] = extent(ys);
      const logX = !!cfg.logX;
      if (logX) { x0 = Math.max(1, Math.min(...xs.filter(v => v > 0), x1)); }
      const sx = v => {
        if (logX) return pad.l + iw * (Math.log(Math.max(v, x0)) - Math.log(x0)) / (Math.log(x1) - Math.log(x0) || 1);
        return pad.l + (iw * (v - x0)) / (x1 - x0);
      };
      const sy = v => pad.t + ih - (ih * (v - y0)) / (y1 - y0);
      const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "cwc-svg", role: "img", "aria-label": "scatter plot" });
      svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + ih, stroke: "var(--line-strong)" }));
      svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t + ih, x2: pad.l + iw, y2: pad.t + ih, stroke: "var(--line-strong)" }));
      pts.forEach(p => {
        svg.appendChild(svgEl("circle", { cx: sx(p.x).toFixed(1), cy: sy(p.y).toFixed(1), r: 5, fill: color(p.color), opacity: 0.85 }));
        if (p.label) {
          const t = svgEl("text", { x: sx(p.x) + 8, y: sy(p.y) + 4, fill: "var(--ink-2)", "font-size": 11 });
          t.textContent = p.label; svg.appendChild(t);
        }
      });
      (cfg.annots || []).forEach(a => {
        const t = svgEl("text", { x: sx(a.x), y: sy(a.y), fill: "var(--dim)", "font-size": 11 });
        t.textContent = a.text; svg.appendChild(t);
      });
      return mount(el, svg, dataTable(["label", "x", "y"], pts.map(p => [p.label || "", p.x, p.y])));
    },

    /* ---- sparkline ---- */
    spark(el, cfg) {
      const w = cfg.w || 120, h = cfg.h || 32;
      const vals = cfg.values || [];
      const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "cwc-svg spark", role: "img",
        "aria-label": "sparkline", preserveAspectRatio: "none" });
      if (vals.length >= 2) {
        const [lo, hi] = extent(vals);
        const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / (hi - lo) * h)).toFixed(1)}`).join(" ");
        svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: color(cfg.color || "--accent"), "stroke-width": 1.5 }));
      }
      // spark: table is optional but keep a11y parity
      return mount(el, svg, dataTable(["i", "value"], vals.map((v, i) => [i, v])));
    }
  };
})();
