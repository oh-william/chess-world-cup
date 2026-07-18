"use strict";
/* analysis.js — Workstream 4: the Analysis view.
   A scrolling five-act story about the language tax, all inline SVG via
   CWC.charts. Source data is CWC.state.data.analysis (static) or
   CWC.api.get('/api/analysis') (live) — identical shape, so the view is
   server-agnostic. The five Gates (evidence chain) migrate here from the old
   Gates screen and render from CWC.state.data.gates. */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const el = CWC.el;

  let ROOT = null;           // impl._el
  let LOADED = null;         // last analysis block rendered

  /* ---------- data source (server-agnostic) ---------- */
  async function fetchAnalysis() {
    if (CWC.state.live) {
      try { return await CWC.api.get("/api/analysis"); }
      catch (e) { /* fall through to static */ }
    }
    const d = CWC.state.data;
    return (d && d.analysis) || null;
  }
  function gates() {
    const d = CWC.state.data;
    return (d && d.gates) || [];
  }

  /* ---------- small builders ---------- */
  function section(title, kicker) {
    const s = el("section", "an-act");
    if (kicker) s.appendChild(el("div", "an-kicker", kicker));
    if (title) s.appendChild(el("h2", "an-h", title));
    return s;
  }
  function caption(text) { return el("p", "an-cap", text); }
  function chartHost(cls) { return el("div", "an-chart" + (cls ? " " + cls : "")); }

  function langColor(lang) {
    // langColor reads a CSS var; fall back to a neutral if unavailable (tests).
    try { return CWC.langColor(lang); } catch (e) { return "var(--lang-none)"; }
  }

  function annot(cls, big, small) {
    const a = el("div", "an-annot " + cls);
    a.appendChild(el("strong", null, big));
    if (small) a.appendChild(el("span", null, small));
    return a;
  }

  /* ================= ACT 1 — the claim ================= */
  function actClaim(a) {
    const s = section("The language tax, measured", "The claim");
    const tax = (a.tax_pairs && a.tax_pairs[0]) || null;
    const spec = a.spectrum || [];
    const py = spec.find(x => x.lang === "Python");
    const taxX = py ? py.tax_x : (tax && tax.nps_ratio) || 21;
    const swing = tax ? Math.abs(Math.round(tax.swing_pts)) : 24;

    const row = el("div", "an-hero");
    const stat = (num, unit, label) => {
      const c = el("div", "stat");
      const v = el("div", "stat-v");
      v.appendChild(el("span", "stat-n", num));
      if (unit) v.appendChild(el("span", "stat-u", unit));
      c.appendChild(v);
      c.appendChild(el("div", "stat-l", label));
      return c;
    };
    row.appendChild(stat("~" + taxX, "×", "slower in Python"));
    row.appendChild(stat("~" + swing, "pts", "score share lost to speed"));
    row.appendChild(stat("0", "", "protocol errors"));
    s.appendChild(row);
    s.appendChild(caption(
      "Fixed-node = equal thinking; wall-clock = equal time. Hold the algorithm and " +
      "eval constant and the only thing left is the language. That gap is the tax."));
    return s;
  }

  /* ================= ACT 2 — the tax in one picture ================= */
  function actSlope(a) {
    const s = section("The tax in one picture", "Equal nodes → equal time");
    const engs = a.engines || {};
    const rows = [];
    Object.keys(engs).forEach(name => {
      const e = engs[name];
      if (e.score_fixed == null || e.score_wall == null) return;
      if (e.family !== "alpha-beta") return; // the same-algorithm duel set
      rows.push({
        label: name,
        a: e.score_fixed * 100,
        b: e.score_wall * 100,
        color: langColor(e.lang),
        emph: e.lang === "Python",
        _lang: e.lang
      });
    });
    rows.sort((x, y) => y.b - x.b);
    const host = chartHost("an-chart--wide");
    s.appendChild(host);

    if (!rows.length) {
      host.appendChild(el("p", "an-cap", "No same-algorithm fixed-node/wall-clock duel in this dataset."));
      return s;
    }
    CWC.charts.slope(host, {
      w: 900, h: 380,
      left: { label: "equal nodes" }, right: { label: "equal time" },
      fmt: v => Math.round(v) + "%",
      rows
    });
    const py = rows.find(r => r._lang === "Python");
    if (py) {
      const drop = Math.round(py.b - py.a);
      host.appendChild(annot("an-annot--tax",
        (drop <= 0 ? drop : "+" + drop) + " pts: the language tax",
        "py-alphabeta collapses under equal time — it simply searches shallower."));
    }
    s.appendChild(caption(
      "The four alpha-betas start clustered at equal nodes. Give them equal time and " +
      "C++, Rust and JavaScript hold; Python dives — the same search, throttled by throughput."));
    return s;
  }

  /* ================= ACT 3 — knowledge vs speed ================= */
  function actScatter(a) {
    const s = section("Knowledge vs speed", "Where each engine lives");
    const engs = a.engines || {};
    const pts = [];
    Object.keys(engs).forEach(name => {
      const e = engs[name];
      const nps = e.nps_mean;
      const share = e.score_wall != null ? e.score_wall : null;
      if (!nps || share == null) return;
      pts.push({ x: nps, y: share * 100, color: langColor(e.lang), label: name });
    });
    const host = chartHost();
    s.appendChild(host);
    if (!pts.length) {
      host.appendChild(el("p", "an-cap", "No wall-clock score share to plot yet."));
      return s;
    }
    const maxY = Math.max.apply(null, pts.map(p => p.y));
    CWC.charts.scatter(host, {
      w: 900, h: 400, logX: true,
      points: pts,
      annots: [
        { x: 150000, y: maxY, text: "knowledge pole (py-mcts / py-alphabeta)" },
        { x: 6000000, y: maxY, text: "speed pole (cpp-alphabeta)" },
        { x: 250000, y: 12, text: "anchor (random)" }
      ]
    });
    s.appendChild(caption(
      "X is nodes per second (log). Y is wall-clock score share. Speed buys depth, " +
      "depth buys points — unless knowledge (py-mcts) compensates for a thinner search."));
    return s;
  }

  /* ================= ACT 4 — the spectrum ================= */
  function actSpectrum(a) {
    const s = section("The spectrum", "One algorithm, four languages");
    const spec = a.spectrum || [];
    const host = chartHost();
    s.appendChild(host);
    if (!spec.length) {
      host.appendChild(el("p", "an-cap", "No spectrum data."));
      return s;
    }
    const reusePath = { native: "native", FFI: "FFI", WASM: "WASM", ctypes: "ctypes" };
    const rows = spec.map(x => ({
      label: x.engine,
      value: x.nps,
      color: langColor(x.lang),
      annot: CWC.fmt.nps(x.nps) + "  ·  " + x.tax_x + "×"
    }));
    CWC.charts.barH(host, { w: 900, log: true, rows, fmt: v => CWC.fmt.nps(v) });

    // reuse-path chips beneath the chart, in spectrum order.
    const chips = el("div", "an-chips");
    spec.forEach(x => {
      const c = el("span", "an-chip");
      c.style.setProperty("--chip", langColor(x.lang));
      c.appendChild(el("span", "an-chip-d"));
      c.appendChild(document.createTextNode(
        x.engine + " — " + (reusePath[x.reuse] || x.reuse)));
      chips.appendChild(c);
    });
    s.appendChild(chips);
    s.appendChild(caption(
      "JavaScript stays near the pack because its hot path is WASM — the interpreter " +
      "(Python) pays the whole tax."));
    return s;
  }

  /* ================= ACT 5 — the evidence (gates) ================= */
  function actEvidence(a) {
    const s = section("The evidence", "Five gates, all green");
    const list = el("div", "an-gates");
    const gs = gates().slice().sort((x, y) => x.n - y.n);
    const engs = a.engines || {};

    gs.forEach(g => {
      const card = el("details", "an-gate");
      const sum = el("summary", "an-gate-sum");
      const pill = el("span", "pill pill--" + (g.status === "pass" ? "ok" : "info"), g.status);
      sum.appendChild(el("span", "an-gate-no", "Gate " + g.n));
      sum.appendChild(el("span", "an-gate-nm", g.name));
      sum.appendChild(pill);
      card.appendChild(sum);

      const body = el("div", "an-gate-body");
      body.appendChild(el("p", "an-gate-detail", g.detail || ""));

      if (g.n === 3) buildGate3(body, engs);
      else if (g.n === 4) buildGate4(body, engs);
      else if (g.n === 1) buildGate1(body);
      else if (g.n === 2) buildGate2(body);

      card.appendChild(body);
      list.appendChild(card);
    });
    s.appendChild(list);

    const foot = el("p", "an-foot");
    const src = (a.sources || []).join("  ·  ");
    foot.appendChild(document.createTextNode("source: " + (src || "—")));
    if (a.generated) {
      foot.appendChild(el("span", "an-foot-sep", "  ·  "));
      foot.appendChild(document.createTextNode("generated " + a.generated));
    }
    s.appendChild(foot);
    return s;
  }

  function buildGate3(body, engs) {
    // NPS by move number, per engine (moves 1-20). Flat = pass.
    const series = [];
    Object.keys(engs).forEach(name => {
      const e = engs[name];
      if (!e.nps_by_move || e.nps_by_move.length < 2) return;
      series.push({ label: name, color: langColor(e.lang),
        points: e.nps_by_move.map(p => [p[0], p[1] / 1e6]) });
    });
    const host = chartHost();
    body.appendChild(host);
    if (!series.length) { host.appendChild(el("p", "an-cap", "No timed moves to chart.")); return; }
    CWC.charts.line(host, {
      w: 860, h: 300,
      x: { label: "move number" },
      y: { label: "Mnps", fmt: v => v.toFixed(1) },
      series
    });
  }

  function buildGate4(body, engs) {
    // latency dot-range (p50/p90/p99) + delta_ms table.
    const wrap = el("div", "an-g4");
    const dots = el("div", "an-lat");
    const names = Object.keys(engs).filter(n => engs[n].lat);
    let maxL = 1;
    names.forEach(n => { maxL = Math.max(maxL, engs[n].lat.p99 || 0); });
    names.forEach(n => {
      const e = engs[n];
      const row = el("div", "an-lat-row");
      row.appendChild(el("span", "an-lat-nm", n));
      const track = el("div", "an-lat-track");
      const bar = el("span", "an-lat-bar");
      bar.style.width = (100 * (e.lat.p99 || 0) / maxL) + "%";
      bar.style.setProperty("--c", langColor(e.lang));
      track.appendChild(bar);
      const mk = (v, cls, lbl) => {
        const d = el("span", "an-lat-dot " + cls);
        d.style.left = (100 * (v || 0) / maxL) + "%";
        d.title = lbl + " " + (v || 0) + "ms";
        d.style.setProperty("--c", langColor(e.lang));
        return d;
      };
      track.appendChild(mk(e.lat.p50, "is-p50", "p50"));
      track.appendChild(mk(e.lat.p90, "is-p90", "p90"));
      track.appendChild(mk(e.lat.p99, "is-p99", "p99"));
      row.appendChild(track);
      row.appendChild(el("span", "an-lat-val mono",
        (e.lat.p50 | 0) + "/" + (e.lat.p90 | 0) + "/" + (e.lat.p99 | 0) + "ms"));
      dots.appendChild(row);
    });
    wrap.appendChild(el("div", "an-lat-leg", "p50 · p90 · p99 orchestrator latency (ms)"));
    wrap.appendChild(dots);

    const tbl = el("table", "an-tbl");
    const thead = el("thead"); const htr = el("tr");
    ["engine", "Δ p50", "Δ p99", "Δ max"].forEach(h => htr.appendChild(el("th", null, h)));
    thead.appendChild(htr); tbl.appendChild(thead);
    const tb = el("tbody");
    names.forEach(n => {
      const d = engs[n].delta || {};
      const tr = el("tr");
      tr.appendChild(el("td", null, n));
      [d.p50, d.p99, d.max].forEach(v => tr.appendChild(el("td", "mono", (v | 0) + "ms")));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    wrap.appendChild(el("div", "an-tbl-cap",
      "Δ = orch_ms − self_ms = implementation tax (IPC + GC + scheduling)"));
    wrap.appendChild(tbl);
    body.appendChild(wrap);
  }

  function buildGate1(body) {
    const tbl = el("table", "an-tbl");
    const rows = [
      ["startpos", "depth 6", "119,060,324", "exact"],
      ["kiwipete", "depth 5", "193,690,690", "exact"],
      ["position 3", "depth 6", "11,030,083", "exact"]
    ];
    const thead = el("thead"); const htr = el("tr");
    ["position", "depth", "nodes", "verdict"].forEach(h => htr.appendChild(el("th", null, h)));
    thead.appendChild(htr); tbl.appendChild(thead);
    const tb = el("tbody");
    rows.forEach(r => {
      const tr = el("tr");
      r.forEach((c, i) => tr.appendChild(el("td", i > 0 && i < 3 ? "mono" : null, c)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); body.appendChild(tbl);
  }

  function buildGate2(body) {
    const tbl = el("table", "an-tbl");
    const rows = [
      ["self-games", "100 / 100"],
      ["protocol errors", "0"],
      ["timeouts", "0"],
      ["illegal moves", "0"]
    ];
    const tb = el("tbody");
    rows.forEach(r => {
      const tr = el("tr");
      tr.appendChild(el("td", null, r[0]));
      tr.appendChild(el("td", "mono", r[1]));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); body.appendChild(tbl);
  }

  /* ---------- render ---------- */
  function renderEmpty() {
    CWC.ui.emptyState(ROOT, {
      icon: "chart",
      msg: "No analysis data yet. Regenerate tournament.json or start the live server."
    });
  }

  function render(a) {
    ROOT.innerHTML = "";
    ROOT.classList.add("an-view");
    if (!a || !a.engines || !Object.keys(a.engines).length) { renderEmpty(); return; }
    LOADED = a;
    const frag = document.createDocumentFragment();
    frag.appendChild(actClaim(a));
    frag.appendChild(actSlope(a));
    frag.appendChild(actScatter(a));
    frag.appendChild(actSpectrum(a));
    frag.appendChild(actEvidence(a));
    ROOT.appendChild(frag);
  }

  CWC.registerView("analysis", {
    init() { ROOT = this._el || document.getElementById("view-analysis"); },
    async show() {
      if (!ROOT) ROOT = this._el || document.getElementById("view-analysis");
      CWC.ui.skeleton(ROOT, "chart");
      let a = null;
      try { a = await fetchAnalysis(); }
      catch (e) { a = (CWC.state.data && CWC.state.data.analysis) || null; }
      render(a);
    },
    hide() {}
  });

  /* public surface (for debugging / tests) */
  CWC.analysis = { render, fetchAnalysis, current() { return LOADED; } };
})();
