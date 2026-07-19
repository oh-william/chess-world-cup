"use strict";
/* core.js — window.CWC namespace: state, bus, router, view registry, api, formatters, ui helpers */
(function () {
  const CWC = (window.CWC = window.CWC || {});

  /* ---------- state ---------- */
  CWC.state = { data: null, live: false, wc: null };

  /* ---------- event bus ---------- */
  CWC.bus = (function () {
    const map = Object.create(null); // evt -> [fn]
    return {
      on(evt, fn) { (map[evt] || (map[evt] = [])).push(fn); return () => {
        const a = map[evt]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      }; },
      emit(evt, payload) { (map[evt] || []).slice().forEach(fn => {
        try { fn(payload); } catch (e) { console.error("bus handler for " + evt, e); }
      }); }
    };
  })();

  /* ---------- DOM helpers ---------- */
  CWC.el = function (tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  CWC.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  CWC.icon = function (name) {
    return '<svg class="ico" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };

  /* ---------- reduced-motion ---------- */
  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }
  CWC.reducedMotion = reducedMotion;

  /* ---------- animation utilities (single source for number/price motion) ---------- */
  CWC.anim = {
    // countUp(el, from, to, {fmt, ms}) — rAF tween; instant under reduced-motion
    countUp(el, from, to, opts) {
      opts = opts || {};
      const fmt = typeof opts.fmt === "function" ? opts.fmt : (v => String(v));
      const ms = opts.ms == null ? 500 : opts.ms;
      from = Number(from) || 0; to = Number(to) || 0;
      if (!el) return;
      if (reducedMotion() || ms <= 0 || from === to) { el.textContent = fmt(to); return; }
      const start = (typeof performance !== "undefined" ? performance.now() : Date.now());
      function frame(now) {
        const t = Math.min(1, (now - start) / ms);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        el.textContent = fmt(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = fmt(to);
      }
      requestAnimationFrame(frame);
    },
    // flash(el, cls, ms) — add class, remove after ms (near-instant under reduced-motion)
    flash(el, cls, ms) {
      if (!el) return;
      cls = cls || "is-flash";
      ms = ms == null ? 600 : ms;
      el.classList.remove(cls);
      // force reflow so re-adding the class restarts the animation
      void el.offsetWidth;
      el.classList.add(cls);
      const wait = reducedMotion() ? 0 : ms;
      setTimeout(() => { el.classList.remove(cls); }, wait);
    }
  };

  /* ---------- view registry + router ---------- */
  const VIEWS = Object.create(null);  // id -> {init,show,hide,_inited,_el}
  const VALID = ["tournament", "watch", "betting", "analysis", "about"];

  CWC.registerView = function (id, impl) {
    if (VALID.indexOf(id) < 0) { console.warn("registerView: unknown id " + id); return; }
    VIEWS[id] = Object.assign({ init() {}, show() {}, hide() {}, _inited: false }, impl);
    VIEWS[id]._el = document.getElementById("view-" + id);
  };
  CWC._views = VIEWS;

  let CURRENT = null;
  function parseHash(hash) {
    const raw = (hash || location.hash || "").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    const id = parts[0] && VALID.indexOf(parts[0]) >= 0 ? parts[0] : "tournament";
    return { id, params: parts.slice(1) };
  }

  CWC.route = function (hashPath) {
    const { id, params } = parseHash(hashPath);
    if (hashPath && location.hash !== "#/" + id + (params.length ? "/" + params.join("/") : "")) {
      // let hashchange drive it; normalize only if explicitly navigating
    }
    // toggle view roots
    VALID.forEach(v => {
      const impl = VIEWS[v];
      const root = impl ? impl._el : document.getElementById("view-" + v);
      if (root) root.classList.toggle("is-active", v === id);
    });
    // tablist aria
    document.querySelectorAll(".tablist .tab").forEach(t => {
      const sel = t.dataset.view === id;
      t.setAttribute("aria-selected", sel ? "true" : "false");
      t.tabIndex = sel ? 0 : -1;
    });
    // lifecycle
    if (CURRENT && CURRENT !== id && VIEWS[CURRENT]) { try { VIEWS[CURRENT].hide(); } catch (e) { console.error(e); } }
    CURRENT = id;
    const impl = VIEWS[id];
    if (impl) {
      if (!impl._inited) { try { impl.init(); } catch (e) { console.error("view init " + id, e); } impl._inited = true; }
      try { impl.show(params); } catch (e) { console.error("view show " + id, e); }
    }
    CWC.bus.emit("route:change", { id, params });
  };

  /* ---------- api ---------- */
  CWC.api = {
    async get(path) {
      let res;
      try { res = await fetch(path, { headers: { Accept: "application/json" } }); }
      catch (e) { const err = new Error("network error: " + path); CWC.ui.toast(err.message, "err"); throw err; }
      if (!res.ok) { const err = new Error("HTTP " + res.status + " " + path); CWC.ui.toast(err.message, "err"); throw err; }
      try { return await res.json(); }
      catch (e) { const err = new Error("bad JSON from " + path); CWC.ui.toast(err.message, "err"); throw err; }
    },
    async post(path, body) {
      let res;
      try {
        res = await fetch(path, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body || {})
        });
      } catch (e) { const err = new Error("network error: " + path); CWC.ui.toast(err.message, "err"); throw err; }
      if (!res.ok) { const err = new Error("HTTP " + res.status + " " + path); CWC.ui.toast(err.message, "err"); throw err; }
      try { return await res.json(); }
      catch (e) { const err = new Error("bad JSON from " + path); CWC.ui.toast(err.message, "err"); throw err; }
    }
  };

  /* ---------- flag / lang / engine ---------- */
  // Subdivision (non-ISO2) flags built as tag sequences: 0x1F3F4 + tag chars + 0xE007F.
  const SUBDIV = { ENG: "gbeng", SCT: "gbsct", WLS: "gbwls" };
  function tagFlag(subtag) {
    const cps = [0x1f3f4];
    for (let i = 0; i < subtag.length; i++) cps.push(0xe0000 + subtag.charCodeAt(i));
    cps.push(0xe007f);
    return String.fromCodePoint.apply(null, cps);
  }
  CWC.flag = function (cc) {
    const code = String(cc || "").toUpperCase();
    if (SUBDIV[code]) return tagFlag(SUBDIV[code]);
    if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return "\u{1F3F3}"; // white flag fallback
    const A = 0x1f1e6;
    return String.fromCodePoint(A + code.charCodeAt(0) - 65,
                                A + code.charCodeAt(1) - 65);
  };
  // flagBadge(code, name) — flag glyph + a small readable abbreviation for
  // subdivision / unknown codes (in case the platform renders a bare black flag).
  CWC.flagBadge = function (code, name) {
    const raw = String(code || "").toUpperCase();
    const glyph = CWC.flag(code);
    const isIso2 = /^[A-Za-z]{2}$/.test(raw) && !SUBDIV[raw];
    const html = '<span class="flag" title="' + CWC.esc(name || raw) + '">' + glyph + "</span>";
    if (isIso2) return html;
    const label = raw || "?";
    return html + '<span class="flag-abbr">' + CWC.esc(label) + "</span>";
  };

  // Maps a language name (as delivered in data) to a CSS var token key.
  const LANG_KEY = { "c++": "cpp", cpp: "cpp", rust: "rust", rs: "rust",
    javascript: "js", js: "js", python: "py", py: "py" };
  CWC.langKey = function (lang) {
    return LANG_KEY[String(lang || "").toLowerCase()] || "none";
  };
  // Read the token value (single source of truth is tokens.css).
  CWC.langColor = function (lang) {
    const key = CWC.langKey(lang);
    const v = getComputedStyle(document.documentElement).getPropertyValue("--lang-" + key).trim();
    return v || "var(--lang-none)";
  };
  CWC.engineOf = function (name) {
    const d = CWC.state.data;
    if (d && d.engines && d.engines[name]) return d.engines[name];
    return { name, lang: "?", family: "?", country: "XX", color: CWC.langColor("none") };
  };

  /* ---------- formatters ---------- */
  CWC.fmt = {
    money(n) {
      const v = Number(n) || 0;
      const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      return (v < 0 ? "-$" : "$") + s;
    },
    pct(p) { // accepts 0..1
      return (Number(p) * 100).toFixed(0) + "%";
    },
    num(n) { return (Number(n) || 0).toLocaleString("en-US"); },
    nps(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
      return String(Math.round(v));
    },
    ms(n) {
      const v = Number(n) || 0;
      if (v >= 1000) return (v / 1000).toFixed(2) + "s";
      return Math.round(v) + "ms";
    }
  };

  /* ---------- ui helpers ---------- */
  CWC.ui = {
    emptyState(el, opts) {
      opts = opts || {};
      el.innerHTML = "";
      const wrap = CWC.el("div", "empty");
      if (opts.icon) { const i = document.createElement("div"); i.className = "empty-ico"; i.innerHTML = CWC.icon(opts.icon); wrap.appendChild(i); }
      wrap.appendChild(CWC.el("div", "empty-msg", opts.msg || "Nothing here yet."));
      if (opts.action) {
        const b = CWC.el("button", "btn btn--primary", opts.action.label || "Retry");
        b.type = "button";
        if (opts.action.onClick) b.addEventListener("click", opts.action.onClick);
        wrap.appendChild(b);
      }
      el.appendChild(wrap);
      return wrap;
    },
    skeleton(el, kind) {
      el.innerHTML = "";
      if (kind === "board") {
        const b = CWC.el("div", "skeleton skeleton--block");
        b.style.aspectRatio = "1"; b.style.height = "auto"; b.style.width = "100%";
        el.appendChild(b);
      } else if (kind === "table") {
        for (let i = 0; i < 6; i++) el.appendChild(CWC.el("div", "skeleton skeleton--line"));
      } else if (kind === "chart") {
        el.appendChild(CWC.el("div", "skeleton skeleton--block"));
      } else {
        for (let i = 0; i < 3; i++) el.appendChild(CWC.el("div", "skeleton skeleton--line"));
      }
    },
    teamPopover(anchorEl, htmlContent) { return CWC.teamPopover(anchorEl, htmlContent); },
    toast(msg, kind) {
      let host = document.getElementById("toast-host");
      if (!host) { host = CWC.el("div"); host.id = "toast-host"; document.body.appendChild(host); }
      const t = CWC.el("div", "toast toast--" + (kind || "info"), msg);
      t.setAttribute("role", "status");
      host.appendChild(t);
      setTimeout(() => {
        t.style.transition = "opacity var(--ease)"; t.style.opacity = "0";
        setTimeout(() => t.remove(), 240);
      }, 3800);
      return t;
    }
  };

  /* ---------- team popover (generic, one open at a time) ---------- */
  let _popEl = null, _popCleanup = null;
  CWC.closeTeamPopover = function () {
    if (_popCleanup) { try { _popCleanup(); } catch (e) {} _popCleanup = null; }
    if (_popEl) { _popEl.remove(); _popEl = null; }
  };
  CWC.teamPopover = function (anchorEl, htmlContent) {
    CWC.closeTeamPopover();
    if (!anchorEl) return null;
    const pop = CWC.el("div", "team-pop");
    pop.setAttribute("role", "dialog");
    pop.innerHTML = htmlContent == null ? "" : htmlContent;
    document.body.appendChild(pop);
    _popEl = pop;

    // position near anchor (below by default, flip up if it would overflow)
    const r = anchorEl.getBoundingClientRect();
    const sx = window.scrollX || 0, sy = window.scrollY || 0;
    let top = r.bottom + sy + 6;
    let left = r.left + sx;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    if (left + pw > sx + document.documentElement.clientWidth - 8)
      left = Math.max(sx + 8, sx + document.documentElement.clientWidth - pw - 8);
    if (r.bottom + ph + 6 > document.documentElement.clientHeight && r.top - ph - 6 > 0)
      top = r.top + sy - ph - 6;
    pop.style.top = top + "px";
    pop.style.left = left + "px";

    function onKey(e) { if (e.key === "Escape") { CWC.closeTeamPopover(); } }
    function onDown(e) {
      if (pop.contains(e.target) || anchorEl.contains(e.target)) return;
      CWC.closeTeamPopover();
    }
    // defer outside-click binding so the opening click doesn't immediately close it
    setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
    document.addEventListener("keydown", onKey, true);
    _popCleanup = function () {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
    return pop;
  };

  /* ---------- route -> body view class ---------- */
  CWC.bus.on("route:change", function (r) {
    if (r && r.id) document.body.dataset.view = r.id;
  });

  /* ---------- demo payload (tournament.json-shaped) ---------- */
  CWC.__demo = {
    generated: "2026-07-16T00:00:00Z",
    engines: {
      "cpp-alphabeta": { name: "cpp-alphabeta", country: "DE", lang: "C++", family: "alpha-beta", color: "#e63946" },
      "rs-alphabeta":  { name: "rs-alphabeta", country: "SE", lang: "Rust", family: "alpha-beta", color: "#dea584" },
      "js-alphabeta":  { name: "js-alphabeta", country: "US", lang: "JavaScript", family: "alpha-beta", color: "#f7df1e" },
      "py-mcts":       { name: "py-mcts", country: "BR", lang: "Python", family: "mcts", color: "#4b8bbe" }
    },
    events: [{
      id: "fixed-node", label: "Fixed-Node Duel", mode: "nodes", budget: 20000,
      engines: ["cpp-alphabeta", "py-mcts"],
      countries: { "cpp-alphabeta": "DE", "py-mcts": "BR" },
      standings: {
        "cpp-alphabeta": { games: 2, w: 1, d: 1, l: 0, pts: 1.5 },
        "py-mcts": { games: 2, w: 0, d: 1, l: 1, pts: 0.5 }
      },
      stats: {
        "cpp-alphabeta": { nps_mean: 8200000, lat_p50: 6, lat_p99: 41, delta_p99: 3 },
        "py-mcts": { nps_mean: 120000, lat_p50: 55, lat_p99: 210, delta_p99: 44 }
      },
      games: [{
        id: "g1", white: "cpp-alphabeta", black: "py-mcts",
        white_country: "DE", black_country: "BR",
        result: "1-0", reason: "checkmate", plies: 3,
        moves: [
          { ply: 0, color: "w", engine: "cpp-alphabeta", uci: "e2e4",
            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            orch_ms: 6, self_ms: 6, delta_ms: 0, self_nodes: 20000 },
          { ply: 1, color: "b", engine: "py-mcts", uci: "e7e5",
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
            orch_ms: 55, self_ms: 50, delta_ms: 5, self_nodes: 12000 },
          { ply: 2, color: "w", engine: "cpp-alphabeta", uci: "g1f3",
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
            orch_ms: 7, self_ms: 6, delta_ms: 1, self_nodes: 20000 }
        ],
        positions: [
          "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
          "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
        ]
      }]
    }],
    gates: [
      { n: 1, name: "perft", status: "pass", detail: "startpos exact to depth 6." },
      { n: 2, name: "latency", status: "measured", detail: "p50/p99 captured per engine." }
    ],
    markets: [
      { id: "fixed-node-cpp-wins", event: "Fixed-Node Duel",
        label: "cpp-alphabeta wins the Fixed-Node Duel",
        desc: "Resolves YES if cpp-alphabeta scores over 50%.", outcome: "NO" }
    ],
    bracket: {
      mode: "nodes", budget: 20000, games_per_tie: 4, champion: "cpp-alphabeta",
      seeds: ["cpp-alphabeta", "py-mcts"],
      rounds: [{ name: "Final", ties: [
        { round: "Final", a: "cpp-alphabeta", b: "py-mcts", seedA: 1, seedB: 2,
          scoreA: 3, scoreB: 1, winner: "cpp-alphabeta" }
      ] }]
    },
    // world-cup-shaped fixtures with odds + a betting contract, for stubs/demo
    fixtures: [
      { id: "wc-m1", a: "cpp-alphabeta", b: "py-mcts", played: false,
        odds: [0.62, 0.21, 0.17] }
    ]
  };
})();
