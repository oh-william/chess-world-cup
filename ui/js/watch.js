"use strict";
/* watch.js — Workstream 2. Merges Broadcast (Replay) + Live into ONE board
   component with a segmented control. Renders into #view-watch (_el).
   ONE board (CWC.board), one movelist/tax renderer used by Replay, Live, and
   WC-match viewing. Vanilla JS, tokenized styles only. */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const el = CWC.el, esc = CWC.esc;

  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const SUBS = ["replay", "live"];
  const SPEEDS = [0.5, 1, 2];

  const W = {
    el: null,
    sub: "replay",
    // shared board refs (rebuilt on each layout render)
    dom: null,
    // replay state
    rp: {
      eventIdx: 0, gameIdx: 0,
      positions: [START_FEN], moves: [], // moves: [{uci, fen, engine, color, orch_ms, delta_ms, self_nodes, self_ms}]
      i: 0, playing: null, speed: 1,
      white: null, black: null, whiteCountry: null, blackCountry: null,
      whiteRating: null, blackRating: null, whiteForm: null, blackForm: null,
      result: null, reason: null, plies: 0,
      taxNote: null,
      wcId: null, title: null,
    },
    // live state
    lv: {
      es: null, meta: {}, tally: {}, results: [],
      game: null, // {white, black, ply, tax, orch, lastFen, lastMove}
      status: "idle", cfg: null, available: [],
    },
    keyHandler: null,
  };

  /* ================= shared plate / material ================= */

  // form dots: last-5 results for this player, newest last.
  // results: array of "w" | "l" | "d" (string codes), most-recent-last.
  function formDotsHTML(results) {
    if (!results || !results.length) return "";
    const last5 = results.slice(-5);
    let out = '<span class="pl-form" role="img" aria-label="recent form">';
    last5.forEach(r => {
      const cls = r === "w" ? "is-win" : r === "l" ? "is-loss" : "is-draw";
      out += '<span class="form-dot ' + cls + '" title="' +
        (r === "w" ? "win" : r === "l" ? "loss" : "draw") + '"></span>';
    });
    return out + "</span>";
  }

  // opts: {country, lang, rating, form:[...]}
  function plateHTML(name, country, side, opts) {
    opts = opts || {};
    if (!name) {
      return '<span class="pl-flag" aria-hidden="true">' + esc(CWC.flag(null)) +
        '</span><span class="pl-name">—</span>' +
        '<span class="pl-side">' + esc(side) + "</span>";
    }
    // Resolve engine metadata from the shared registry, then let per-game
    // overrides (opts) win. NEVER emit a literal "(?)" placeholder.
    const e = CWC.engineOf(name) || {};
    const lang = opts.lang || e.lang;
    const cc = country || opts.country || e.country;
    const rating = opts.rating != null ? opts.rating : e.rating;
    const key = CWC.langKey(lang);
    const langLabel = lang && lang !== "?" ? lang : CWC.langKey(lang).toUpperCase();
    let html = '<span class="pl-flag" aria-hidden="true">' + esc(CWC.flag(cc)) + "</span>";
    html += '<span class="chip chip--lang pl-lang" data-lang="' + esc(key) + '">' +
      esc(langLabel) + "</span>";
    html += '<span class="pl-name">' + esc(name) + "</span>";
    if (rating != null && rating !== "") {
      html += '<span class="pl-rating tnum" title="chess rating">' + esc(rating) + "</span>";
    }
    html += '<span class="pl-side">' + esc(side) + "</span>";
    html += formDotsHTML(opts.form);
    return html;
  }

  // captured-material readout for a color, from a FEN, relative to start.
  function materialHTML(fen, forWhite) {
    const m = CWC.board.material(fen);
    const START = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
    const GLYPH = { P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", p: "♙", n: "♘", b: "♗", r: "♖", q: "♕" };
    // pieces the given side has captured = opponent's missing pieces
    const oppUpper = forWhite ? false : true; // white captures black (lowercase) pieces
    let out = "";
    ["Q", "R", "B", "N", "P"].forEach(t => {
      const key = oppUpper ? t : t.toLowerCase();
      const missing = START[t] - (m.byPiece[key] || 0);
      for (let k = 0; k < missing; k++) out += GLYPH[t];
    });
    const diff = forWhite ? m.diff : -m.diff;
    const dtxt = diff > 0 ? " +" + diff : "";
    return '<span class="mat-pcs">' + (out || "") + "</span>" +
      (dtxt ? '<span class="mat-diff mono">' + esc(dtxt) + "</span>" : "");
  }

  // Vertical eval bar driven purely by material diff (always populated). White
  // advantage grows the white portion upward; label shows signed pawns.
  function renderEval(fen) {
    if (!W.dom || !W.dom.evalWhite) return;
    const m = CWC.board.material(fen);
    const diff = m.diff; // + = white ahead, in pawns
    // map material diff to a 0..100% white share via a soft clamp (±10 pawns).
    const clamped = Math.max(-10, Math.min(10, diff));
    const whitePct = 50 + (clamped / 10) * 50;
    W.dom.evalWhite.style.height = whitePct.toFixed(1) + "%";
    const txt = diff > 0 ? "+" + diff : diff < 0 ? String(diff) : "0";
    W.dom.evalLabel.textContent = txt;
    W.dom.evalBar.setAttribute("aria-label",
      "material evaluation: " + (diff === 0 ? "even" :
        (diff > 0 ? "white +" + diff : "black +" + (-diff))));
    W.dom.evalBar.classList.toggle("is-black-ahead", diff < 0);
  }

  // Ask the strong reference engine (cpp-analyst, live server only) to evaluate
  // the current position, and upgrade the eval bar + show its best line.
  function analyzeCurrent(fen) {
    const line = W.dom && W.dom.engineLine;
    if (!CWC.state.live) { if (line) line.textContent = ""; return; }
    if (line) line.textContent = "analysing…";
    const seq = (W.analyzeSeq = (W.analyzeSeq || 0) + 1);
    CWC.api.get("/api/analyze?fen=" + encodeURIComponent(fen) + "&nodes=200000")
      .then(res => {
        if (seq !== W.analyzeSeq || !W.dom) return;      // superseded
        if (res && res.cp != null) applyEngineEval(fen, res);
        else if (line) line.textContent = "";
      })
      .catch(() => { if (line) line.textContent = ""; });
  }

  function applyEngineEval(fen, res) {
    const cp = Math.max(-2000, Math.min(2000, res.cp));
    const wp = 1 / (1 + Math.pow(10, -cp / 400));        // win probability
    W.dom.evalWhite.style.height = (wp * 100).toFixed(1) + "%";
    W.dom.evalBar.classList.toggle("is-black-ahead", cp < 0);
    const pawns = (res.cp / 100).toFixed(1);
    const signed = res.cp > 0 ? "+" + pawns : pawns;
    W.dom.evalLabel.textContent = signed;
    W.dom.evalBar.setAttribute("aria-label", "engine evaluation " + signed);
    const best = res.best && res.best !== "0000"
      ? (CWC.san(fen, res.best) || res.best) : "—";
    W.dom.engineLine.innerHTML =
      'engine <span class="tnum">d' + (res.depth || "?") + "</span> · best <b>" +
      CWC.esc(best) + '</b> <span class="tnum">' + signed + "</span>";
  }

  // Last-5 form for an engine across an event's games (chronological), newest last.
  function eventForm(ev, engineName) {
    if (!ev || !ev.games || !engineName) return [];
    const out = [];
    ev.games.forEach(g => {
      let side = null;
      if (g.white === engineName) side = "w";
      else if (g.black === engineName) side = "b";
      if (!side) return;
      if (g.result === "1/2-1/2") out.push("d");
      else if (g.result === "1-0") out.push(side === "w" ? "w" : "l");
      else if (g.result === "0-1") out.push(side === "b" ? "w" : "l");
    });
    return out;
  }

  // rating for an engine from the shared engine registry (may be undefined).
  function engineRating(name) {
    const e = CWC.engineOf(name);
    return e && e.rating != null ? e.rating : null;
  }

  /* ================= shared movelist + tax + telemetry ================= */

  // moves: array of {uci, fen?, engine?, color?, orch_ms?, delta_ms?, self_nodes?, self_ms?}
  // positions: parallel positions array (positions[0] = start; positions[i+1] after move i)
  // cur = number of plies applied (0..len)
  function renderMovelist(host, positions, moves, cur, onSeek) {
    host.innerHTML = "";
    moves.forEach((m, idx) => {
      const beforeFen = positions[idx] || START_FEN;
      const san = CWC.san(beforeFen, m.uci);
      if (idx % 2 === 0) host.appendChild(el("span", "ml-num mono", (idx / 2 + 1) + "."));
      const s = el("span", "ml-mv" + (idx === cur - 1 ? " is-cur" : ""));
      s.appendChild(el("span", "ml-san", san));
      // inline per-move nodes / ms telemetry, when present
      const bits = [];
      if (m.self_nodes != null) bits.push(CWC.fmt.nps(m.self_nodes).replace(/(\d)([kM])/, "$1$2") + "n");
      if (m.orch_ms != null) bits.push(m.orch_ms + "ms");
      if (bits.length) s.appendChild(el("span", "ml-tele tnum", bits.join(" ")));
      s.tabIndex = 0;
      s.setAttribute("role", "button");
      if (onSeek) {
        s.addEventListener("click", () => onSeek(idx + 1));
        s.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSeek(idx + 1); } });
      }
      host.appendChild(s);
    });
    // autoscroll to current
    const curEl = host.querySelector(".is-cur");
    if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: "nearest" });
  }

  // Sparkline of per-move nodes (or ms) across the game, via CWC.charts.spark.
  function renderMoveSpark(host, moves, cur) {
    if (!host) return;
    host.innerHTML = "";
    const nodeVals = moves.map(m => m.self_nodes).filter(v => v != null);
    const msVals = moves.map(m => m.orch_ms).filter(v => v != null);
    const which = nodeVals.length >= 2 ? { vals: nodeVals, label: "nodes/move" }
      : msVals.length >= 2 ? { vals: msVals, label: "ms/move" } : null;
    if (!which) { host.classList.add("is-hidden"); return; }
    host.classList.remove("is-hidden");
    const cap = el("span", "w-ml-spark-cap", which.label);
    host.appendChild(cap);
    const sh = el("div", "w-ml-spark-svg");
    host.appendChild(sh);
    CWC.charts.spark(sh, { values: which.vals, w: 200, h: 24, color: "--accent" });
  }

  // Cumulative per-move tax meter (game HAS telemetry). Always shows the track,
  // even at 0% (ply 0), so it's never a "dead" empty bar — it fills as you step.
  function renderTaxCumulative(card, cumDelta, cumOrch) {
    if (!card) return;
    const track = card.querySelector(".w-tax-track");
    const fill = card.querySelector(".w-tax-fill");
    const val = card.querySelector(".w-tax-value");
    const agg = card.querySelector(".w-tax-agg");
    if (track) track.classList.remove("is-hidden");
    if (agg) agg.classList.add("is-hidden");
    const pct = cumOrch > 0 ? (cumDelta / cumOrch) * 100 : 0;
    if (fill) fill.style.width = Math.min(100, pct) + "%";
    if (val) {
      val.textContent = cumOrch > 0
        ? cumDelta + " ms tax over " + cumOrch + " ms wall (" + pct.toFixed(1) + "%)"
        : "step through moves to accrue implementation tax";
    }
  }

  // renderTax: when per-move telemetry is present (cumOrch>0) show the cumulative
  // meter. Otherwise, if an aggregate note is available, show it (never an empty
  // track); if nothing at all, hide the track and say so.
  function renderTax(card, cumDelta, cumOrch, aggNote) {
    if (!card) return;
    const track = card.querySelector(".w-tax-track");
    const fill = card.querySelector(".w-tax-fill");
    const val = card.querySelector(".w-tax-value");
    const agg = card.querySelector(".w-tax-agg");
    if (cumOrch > 0) {
      const pct = (cumDelta / cumOrch) * 100;
      if (track) track.classList.remove("is-hidden");
      if (fill) fill.style.width = Math.min(100, pct) + "%";
      if (val) val.textContent = cumDelta + " ms tax over " + cumOrch +
        " ms wall (" + pct.toFixed(1) + "%)";
      if (agg) agg.classList.add("is-hidden");
    } else if (aggNote) {
      // No per-move telemetry — surface the aggregate implementation-tax.
      if (track) track.classList.add("is-hidden");
      if (fill) fill.style.width = "0%";
      if (val) val.textContent = aggNote.headline || "";
      if (agg) {
        agg.classList.remove("is-hidden");
        agg.textContent = aggNote.explain || "";
      }
    } else {
      if (track) track.classList.add("is-hidden");
      if (fill) fill.style.width = "0%";
      if (val) val.textContent = "no implementation-tax data for this game";
      if (agg) agg.classList.add("is-hidden");
    }
  }

  // Build an aggregate implementation-tax note for a Replay game from the event's
  // per-engine stats (delta_p99 = ms/move of orchestration overhead). Compares the
  // two engines and phrases it in terms of language, e.g. "Python paid +44 ms/move
  // vs C++ here". Returns null if stats are unavailable.
  function aggregateTaxNote(ev, white, black) {
    if (!ev || !ev.stats) return null;
    const sw = ev.stats[white], sb = ev.stats[black];
    const dw = sw && sw.delta_p99 != null ? sw.delta_p99 : null;
    const db = sb && sb.delta_p99 != null ? sb.delta_p99 : null;
    if (dw == null && db == null) return null;
    const langOf = n => { const e = CWC.engineOf(n); return (e && e.lang) || n; };
    const lw = langOf(white), lb = langOf(black);
    // Identify who paid more overhead.
    let headline, explain;
    if (dw != null && db != null) {
      const diff = Math.abs(dw - db);
      const hi = dw >= db ? lw : lb, lo = dw >= db ? lb : lw;
      headline = hi + " paid +" + diff + " ms/move vs " + lo + " here";
      explain = "No per-move telemetry recorded for this replay, so this is the " +
        "aggregate p99 orchestration overhead from the event standings: " +
        lw + " " + dw + " ms vs " + lb + " " + db + " ms per move.";
    } else {
      const only = dw != null ? lw : lb, ms = dw != null ? dw : db;
      headline = only + " paid ~" + ms + " ms/move of implementation tax";
      explain = "No per-move telemetry recorded for this replay; aggregate p99 " +
        "orchestration overhead from the event standings.";
    }
    return { headline, explain };
  }

  function renderTelemetry(host, mv) {
    host.innerHTML = "";
    if (!mv) return;
    const nps = (mv.self_ms > 0 && mv.self_nodes != null) ? Math.round(mv.self_nodes / (mv.self_ms / 1000)) : null;
    const cards = [
      ["last move", mv.uci || "—"],
      ["by", mv.engine || "—"],
      ["nodes", mv.self_nodes != null ? CWC.fmt.num(mv.self_nodes) : "—"],
      ["nps", nps != null ? CWC.fmt.nps(nps) : "—"],
      ["orch ms", mv.orch_ms != null ? mv.orch_ms : "—"],
      ["tax Δ", mv.delta_ms != null ? mv.delta_ms + "ms" : "—"],
    ];
    cards.forEach(([k, v]) => {
      const c = el("div", "stat tcard");
      c.appendChild(el("div", "stat-k", k));
      c.appendChild(el("div", "stat-v", String(v)));
      host.appendChild(c);
    });
  }

  /* ================= layout ================= */

  function buildLayout(mode) {
    const root = W.el;
    root.innerHTML = "";

    const topbar = el("div", "w-topbar");
    topbar.appendChild(makeSeg());
    root.appendChild(topbar);

    const grid = el("div", "w-grid");
    root.appendChild(grid);

    // ---- board column ----
    const boardCol = el("div", "w-board-col card");
    const plateTop = el("div", "w-plate w-plate-top");
    const plateTopInfo = el("div", "w-plate-info");
    const plateTopMat = el("div", "w-plate-mat");
    plateTop.appendChild(plateTopInfo); plateTop.appendChild(plateTopMat);
    boardCol.appendChild(plateTop);

    // board + vertical eval bar side by side
    const boardWrap = el("div", "w-board-wrap");
    const evalBar = el("div", "w-eval");
    evalBar.setAttribute("role", "img");
    evalBar.setAttribute("aria-label", "material evaluation bar");
    const evalWhite = el("div", "w-eval-white");
    const evalLabel = el("span", "w-eval-label tnum", "");
    evalBar.appendChild(evalWhite);
    evalBar.appendChild(evalLabel);
    const boardEl = el("div", "w-board");
    boardWrap.appendChild(evalBar);
    boardWrap.appendChild(boardEl);
    boardCol.appendChild(boardWrap);

    const plateBot = el("div", "w-plate w-plate-bot");
    const plateBotInfo = el("div", "w-plate-info");
    const plateBotMat = el("div", "w-plate-mat");
    plateBot.appendChild(plateBotInfo); plateBot.appendChild(plateBotMat);
    boardCol.appendChild(plateBot);

    // engine analysis line (populated on the live server by cpp-analyst)
    const engineLine = el("div", "w-engine muted");
    boardCol.appendChild(engineLine);

    // transport (hidden in live)
    const transport = el("div", "w-transport");
    if (mode === "live") transport.classList.add("is-hidden");
    // Plain-glyph buttons for first/prev/last; icon buttons for play & step so the
    // two transport controls are visually distinct (was: two identical "▶").
    const gbtn = (label, aria, cls) => {
      const b = el("button", "btn btn--sm w-tbtn" + (cls ? " " + cls : ""), label);
      b.type = "button"; b.setAttribute("aria-label", aria);
      return b;
    };
    const ibtn = (icon, aria, cls) => {
      const b = el("button", "btn btn--sm w-tbtn" + (cls ? " " + cls : ""));
      b.type = "button"; b.setAttribute("aria-label", aria);
      b.innerHTML = CWC.icon(icon);
      return b;
    };
    const bFirst = gbtn("⏮", "First move");
    const bPrev = gbtn("◀", "Previous move");
    const bPlay = ibtn("play", "Play", "w-play");        // #i-play / #i-pause
    const bNext = ibtn("step", "Next move");             // #i-step (distinct glyph)
    const bLast = gbtn("⏭", "Last move");
    const scrub = el("input", "w-scrub");
    scrub.type = "range"; scrub.min = "0"; scrub.value = "0"; scrub.setAttribute("aria-label", "Scrub moves");
    const plyLabel = el("span", "w-ply mono", "0 / 0");
    const speedSel = el("div", "seg w-speed");
    speedSel.setAttribute("role", "tablist");
    speedSel.setAttribute("aria-label", "Playback speed");
    SPEEDS.forEach(sp => {
      const s = el("button", null, sp + "×");
      s.type = "button"; s.setAttribute("role", "tab");
      s.dataset.speed = String(sp);
      s.setAttribute("aria-selected", sp === W.rp.speed ? "true" : "false");
      s.tabIndex = sp === W.rp.speed ? 0 : -1;
      s.addEventListener("click", () => setSpeed(sp));
      speedSel.appendChild(s);
    });
    transport.append(bFirst, bPrev, bPlay, bNext, bLast, scrub, plyLabel, speedSel);
    boardCol.appendChild(transport);
    grid.appendChild(boardCol);

    // ---- context column ----
    const ctxCol = el("div", "w-ctx-col");
    grid.appendChild(ctxCol);

    W.dom = {
      boardCol, plateTopInfo, plateTopMat, plateBotInfo, plateBotMat,
      boardEl, evalBar, evalWhite, evalLabel, engineLine,
      transport, bFirst, bPrev, bPlay, bNext, bLast, scrub, plyLabel, speedSel,
      ctxCol,
    };

    if (mode === "replay") {
      bFirst.addEventListener("click", () => { rpStop(); rpShow(0); });
      bPrev.addEventListener("click", () => { rpStop(); rpShow(W.rp.i - 1); });
      bNext.addEventListener("click", () => { rpStop(); rpShow(W.rp.i + 1); });
      bLast.addEventListener("click", () => { rpStop(); rpShow(W.rp.positions.length - 1); });
      bPlay.addEventListener("click", rpTogglePlay);
      scrub.addEventListener("input", e => { rpStop(); rpShow(+e.target.value); });
    }
  }

  function makeSeg() {
    const items = [{ id: "replay", label: "Replay" }, { id: "live", label: "Live" }];
    const s = el("div", "seg");
    s.setAttribute("role", "tablist");
    s.setAttribute("aria-label", "Watch mode");
    items.forEach(it => {
      const b = el("button", null, it.label);
      b.type = "button"; b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", it.id === W.sub ? "true" : "false");
      b.tabIndex = it.id === W.sub ? 0 : -1;
      b.addEventListener("click", () => { location.hash = "#/watch/" + it.id; });
      b.addEventListener("keydown", e => {
        let ni = -1;
        const i = items.findIndex(x => x.id === W.sub);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") ni = (i + 1) % items.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") ni = (i - 1 + items.length) % items.length;
        if (ni >= 0) { e.preventDefault(); location.hash = "#/watch/" + items[ni].id; }
      });
      s.appendChild(b);
    });
    return s;
  }

  /* ================= REPLAY ================= */

  function buildReplayContext() {
    const ctx = W.dom.ctxCol;
    ctx.innerHTML = "";

    // pickers
    const picks = el("div", "card w-picks");
    if (W.rp.wcId) {
      const title = el("div", "w-wc-title");
      title.innerHTML = '<b>World Cup game</b> — ' + esc(W.rp.title || W.rp.wcId);
      picks.appendChild(title);
      const back = el("button", "btn btn--sm", "← back to events");
      back.type = "button";
      back.addEventListener("click", () => { location.hash = "#/watch/replay"; });
      picks.appendChild(back);
    } else {
      const data = CWC.state.data;
      if (data && data.events && data.events.length) {
        const evSel = el("select", "w-select");
        evSel.setAttribute("aria-label", "Event");
        data.events.forEach((ev, i) => {
          const o = el("option", null, ev.label + " (" + ev.mode + " " + ev.budget + ")");
          o.value = String(i); evSel.appendChild(o);
        });
        evSel.value = String(W.rp.eventIdx);
        evSel.addEventListener("change", () => { W.rp.eventIdx = +evSel.value; W.rp.gameIdx = 0; loadReplayGame(); });
        picks.appendChild(evSel);

        const gSel = el("select", "w-select");
        gSel.id = "w-game-select";
        gSel.setAttribute("aria-label", "Game");
        fillGameSelect(gSel, data.events[W.rp.eventIdx]);
        gSel.addEventListener("change", () => { W.rp.gameIdx = +gSel.value; loadReplayGame(); });
        picks.appendChild(gSel);
      }
    }
    ctx.appendChild(picks);

    // result line
    const result = el("div", "w-result mono");
    result.id = "w-result";
    ctx.appendChild(result);

    // tax meter
    const taxCard = el("div", "card w-tax"); taxCard.id = "w-tax-card";
    taxCard.appendChild(el("div", "w-tax-label", "implementation tax"));
    const track = el("div", "w-tax-track");
    const fill = el("div", "w-tax-fill"); fill.id = "w-tax-fill";
    track.appendChild(fill);
    taxCard.appendChild(track);
    const val = el("div", "w-tax-value tnum"); val.id = "w-tax-value";
    taxCard.appendChild(val);
    const agg = el("div", "w-tax-agg is-hidden"); agg.id = "w-tax-agg";
    taxCard.appendChild(agg);
    ctx.appendChild(taxCard);

    // telemetry stat grid
    const tele = el("div", "w-telemetry"); tele.id = "w-telemetry";
    ctx.appendChild(tele);

    // movelist
    const mlCard = el("div", "card w-ml-card");
    mlCard.appendChild(el("div", "w-ml-label", "moves"));
    const spark = el("div", "w-ml-spark"); spark.id = "w-ml-spark";
    mlCard.appendChild(spark);
    const ml = el("div", "w-movelist"); ml.id = "w-movelist";
    mlCard.appendChild(ml);
    ctx.appendChild(mlCard);
  }

  function fillGameSelect(sel, ev) {
    sel.innerHTML = "";
    (ev.games || []).forEach((g, idx) => {
      const label = "#" + g.id + "  " + CWC.flag(g.white_country) + " " + g.white +
        " vs " + g.black + " " + CWC.flag(g.black_country) + " · " + g.result;
      const o = el("option", null, label); o.value = String(idx);
      sel.appendChild(o);
    });
    sel.value = String(W.rp.gameIdx);
  }

  function loadReplayGame() {
    const data = CWC.state.data;
    if (!data || !data.events || !data.events.length) return;
    if (W.rp.eventIdx >= data.events.length) W.rp.eventIdx = 0;
    const ev = data.events[W.rp.eventIdx];
    if (!ev.games || !ev.games.length) { renderReplayEmpty("no games in this event"); return; }
    if (W.rp.gameIdx >= ev.games.length) W.rp.gameIdx = 0;
    const g = ev.games[W.rp.gameIdx];
    W.rp.positions = g.positions && g.positions.length ? g.positions : [START_FEN];
    W.rp.moves = g.moves || [];
    W.rp.white = g.white; W.rp.black = g.black;
    W.rp.whiteCountry = g.white_country; W.rp.blackCountry = g.black_country;
    W.rp.whiteRating = g.white_rating != null ? g.white_rating : engineRating(g.white);
    W.rp.blackRating = g.black_rating != null ? g.black_rating : engineRating(g.black);
    W.rp.whiteForm = eventForm(ev, g.white);
    W.rp.blackForm = eventForm(ev, g.black);
    W.rp.result = g.result; W.rp.reason = g.reason; W.rp.plies = g.plies;
    W.rp.taxNote = aggregateTaxNote(ev, g.white, g.black);
    W.rp.wcId = null; W.rp.title = null;
    buildReplayContext();
    W.dom.scrub.max = String(W.rp.positions.length - 1);
    rpStop();
    rpLoadPlates();
    rpShow(0);
  }

  async function loadWcGame(wcId) {
    W.rp.wcId = wcId;
    W.rp.title = wcId;
    buildReplayContext();
    CWC.ui.skeleton(W.dom.boardEl, "board");
    let g;
    try {
      const res = await CWC.api.get("/api/tournament/game?id=" + encodeURIComponent(wcId));
      g = res.game;
    } catch (e) { renderReplayEmpty("could not load game " + wcId); return; }
    if (!g || !g.positions || !g.positions.length) { renderReplayEmpty("no game recorded for " + wcId); return; }
    W.rp.positions = g.positions;
    W.rp.moves = g.moves || [];
    // derive plate names from the moves if present, else generic
    const firstW = (g.moves || []).find(m => m.color === "w");
    const firstB = (g.moves || []).find(m => m.color === "b");
    W.rp.white = firstW ? firstW.engine : null;
    W.rp.black = firstB ? firstB.engine : null;
    W.rp.whiteCountry = null; W.rp.blackCountry = null;
    W.rp.whiteRating = engineRating(W.rp.white);
    W.rp.blackRating = engineRating(W.rp.black);
    W.rp.whiteForm = null; W.rp.blackForm = null;
    W.rp.taxNote = null;
    W.rp.result = null; W.rp.reason = null; W.rp.plies = g.moves ? g.moves.length : 0;
    W.dom.scrub.max = String(W.rp.positions.length - 1);
    rpStop();
    rpLoadPlates();
    rpShow(0);
  }

  function renderReplayEmpty(msg) {
    CWC.ui.emptyState(W.dom.ctxCol, { icon: "board", msg });
    CWC.board.render(W.dom.boardEl, START_FEN, { coords: true });
  }

  function rpLoadPlates() {
    W.dom.plateTopInfo.innerHTML = plateHTML(W.rp.black, W.rp.blackCountry, "black",
      { rating: W.rp.blackRating, form: W.rp.blackForm });
    W.dom.plateBotInfo.innerHTML = plateHTML(W.rp.white, W.rp.whiteCountry, "white",
      { rating: W.rp.whiteRating, form: W.rp.whiteForm });
    const r = document.getElementById("w-result");
    if (r) {
      if (W.rp.result) {
        const rmap = { "1-0": W.rp.white + " wins", "0-1": W.rp.black + " wins", "1/2-1/2": "draw" };
        r.textContent = W.rp.result + " — " + (rmap[W.rp.result] || "") +
          (W.rp.reason ? " (" + W.rp.reason + ", " + W.rp.plies + " plies)" : "");
      } else {
        r.textContent = W.rp.plies ? W.rp.plies + " plies" : "";
      }
    }
  }

  function rpShow(i) {
    const n = W.rp.positions.length;
    W.rp.i = Math.max(0, Math.min(n - 1, i));
    const fen = W.rp.positions[W.rp.i];
    const mv = W.rp.i > 0 ? W.rp.moves[W.rp.i - 1] : null;
    CWC.board.render(W.dom.boardEl, fen, { lastMove: mv ? mv.uci : null, coords: true });
    // eval bar (material diff — always populated); engine upgrades it if live
    renderEval(fen);
    analyzeCurrent(fen);
    // material into plates
    W.dom.plateTopMat.innerHTML = materialHTML(fen, false); // black's captures
    W.dom.plateBotMat.innerHTML = materialHTML(fen, true);  // white's captures
    // telemetry
    renderTelemetry(document.getElementById("w-telemetry"), mv);
    // cumulative tax (per-move) — or aggregate note when telemetry is absent
    let cumDelta = 0, cumOrch = 0;
    for (let k = 0; k < W.rp.i; k++) {
      cumDelta += (W.rp.moves[k] && W.rp.moves[k].delta_ms) || 0;
      cumOrch += (W.rp.moves[k] && W.rp.moves[k].orch_ms) || 0;
    }
    const hasTelemetry = W.rp.moves.some(m => m.delta_ms != null || m.orch_ms != null);
    // With per-move telemetry, always show the cumulative meter (0% at ply 0).
    // Without it, fall back to the aggregate implementation-tax note.
    if (hasTelemetry) {
      renderTaxCumulative(document.getElementById("w-tax-card"), cumDelta, cumOrch);
    } else {
      renderTax(document.getElementById("w-tax-card"), 0, 0, W.rp.taxNote);
    }
    // movelist + node/time sparkline
    renderMovelist(document.getElementById("w-movelist"), W.rp.positions, W.rp.moves, W.rp.i,
      j => { rpStop(); rpShow(j); });
    renderMoveSpark(document.getElementById("w-ml-spark"), W.rp.moves, W.rp.i);
    // transport
    W.dom.scrub.value = String(W.rp.i);
    W.dom.plyLabel.textContent = W.rp.i + " / " + (n - 1);
  }

  function rpStop() {
    if (W.rp.playing) { clearInterval(W.rp.playing); W.rp.playing = null; }
    if (W.dom && W.dom.bPlay) { W.dom.bPlay.innerHTML = CWC.icon("play"); W.dom.bPlay.setAttribute("aria-label", "Play"); }
  }
  function rpTogglePlay() {
    if (W.rp.playing) { rpStop(); return; }
    if (W.rp.i >= W.rp.positions.length - 1) rpShow(0);
    if (W.rp.positions.length <= 1) return;
    W.dom.bPlay.innerHTML = CWC.icon("pause"); W.dom.bPlay.setAttribute("aria-label", "Pause");
    const period = 650 / W.rp.speed;
    W.rp.playing = setInterval(() => {
      if (W.rp.i >= W.rp.positions.length - 1) { rpStop(); return; }
      rpShow(W.rp.i + 1);
    }, period);
  }
  function setSpeed(sp) {
    W.rp.speed = sp;
    if (W.dom && W.dom.speedSel) {
      W.dom.speedSel.querySelectorAll("[role=tab]").forEach(b => {
        const sel = +b.dataset.speed === sp;
        b.setAttribute("aria-selected", sel ? "true" : "false");
        b.tabIndex = sel ? 0 : -1;
      });
    }
    if (W.rp.playing) { rpStop(); rpTogglePlay(); }
  }

  function startReplay(params) {
    buildLayout("replay");
    installKeys();
    // parse wc=<id> param
    let wcId = null;
    (params || []).forEach(p => {
      if (p.indexOf("wc=") === 0) wcId = decodeURIComponent(p.slice(3));
    });
    if (wcId) { loadWcGame(wcId); return; }
    const data = CWC.state.data;
    if (!data || !data.events || !data.events.length) {
      buildReplayContext();
      renderReplayEmpty("No replay data. Serve tournament.json (python3 ui/serve.py) or the live server.");
      return;
    }
    loadReplayGame();
  }

  /* ================= LIVE ================= */

  function liveEngineOf(name) {
    return W.lv.meta[name] || (CWC.state.data && CWC.state.data.engines && CWC.state.data.engines[name]) ||
      { lang: "?", country: "XX" };
  }

  function buildLiveContext() {
    const ctx = W.dom.ctxCol;
    ctx.innerHTML = "";

    const picks = el("div", "card w-picks w-live-picks");
    picks.innerHTML =
      '<div class="w-live-status" id="w-live-status"><span class="chip">idle</span></div>';
    const grid = el("div", "w-live-fields");
    grid.innerHTML =
      '<label class="w-field">engine 1 <select id="w-e1" class="w-select"></select></label>' +
      '<label class="w-field">engine 2 <select id="w-e2" class="w-select"></select></label>' +
      '<label class="w-field">mode <select id="w-mode" class="w-select">' +
      '<option value="movetime">movetime</option><option value="nodes">nodes</option></select></label>' +
      '<label class="w-field">budget <input id="w-budget" class="w-select mono" type="number" value="250" min="1"></label>' +
      '<label class="w-field">games <input id="w-games" class="w-select mono" type="number" value="6" min="1"></label>';
    picks.appendChild(grid);
    const start = el("button", "btn btn--primary w-live-start", "▶ Start");
    start.type = "button";
    start.id = "w-live-start";
    start.addEventListener("click", startLiveMatch);
    picks.appendChild(start);
    ctx.appendChild(picks);

    // tax meter
    const taxCard = el("div", "card w-tax"); taxCard.id = "w-tax-card";
    taxCard.appendChild(el("div", "w-tax-label", "implementation tax (this game)"));
    const track = el("div", "w-tax-track");
    const fill = el("div", "w-tax-fill"); fill.id = "w-tax-fill";
    track.appendChild(fill);
    taxCard.appendChild(track);
    const lval = el("div", "w-tax-value tnum"); lval.id = "w-tax-value";
    taxCard.appendChild(lval);
    const lagg = el("div", "w-tax-agg is-hidden"); lagg.id = "w-tax-agg";
    taxCard.appendChild(lagg);
    ctx.appendChild(taxCard);

    const tele = el("div", "w-telemetry"); tele.id = "w-telemetry";
    ctx.appendChild(tele);

    // running score strip + ticker
    const scoreCard = el("div", "card w-score-card");
    scoreCard.appendChild(el("div", "w-ml-label", "running score"));
    const score = el("div", "w-scoreline"); score.id = "w-scoreline";
    scoreCard.appendChild(score);
    const ticker = el("div", "w-movelist w-ticker"); ticker.id = "w-ticker";
    scoreCard.appendChild(ticker);
    ctx.appendChild(scoreCard);
  }

  function liveStatus(html) {
    const s = document.getElementById("w-live-status");
    if (s) s.innerHTML = html;
  }

  function fillEngineSelects(cfg) {
    const avail = cfg.available || [];
    W.lv.available = avail;
    const fill = (id, def) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = "";
      avail.forEach(n => { const o = el("option", null, n); o.value = n; sel.appendChild(o); });
      if (def) sel.value = def;
    };
    const c = cfg.cfg || {};
    fill("w-e1", c.engine1 || "cpp-alphabeta");
    fill("w-e2", c.engine2 || "py-mcts");
    if (c.mode) { const m = document.getElementById("w-mode"); if (m) m.value = c.mode; }
    if (c.budget) { const b = document.getElementById("w-budget"); if (b) b.value = c.budget; }
    if (c.games) { const g = document.getElementById("w-games"); if (g) g.value = c.games; }
  }

  function liveReset() {
    W.lv.game = { white: null, black: null, ply: 0, tax: 0, orch: 0 };
    CWC.board.render(W.dom.boardEl, START_FEN, { coords: true });
    renderEval(START_FEN);
    W.dom.plateTopInfo.innerHTML = plateHTML(null, null, "black");
    W.dom.plateBotInfo.innerHTML = plateHTML(null, null, "white");
    W.dom.plateTopMat.innerHTML = "";
    W.dom.plateBotMat.innerHTML = "";
    renderTaxCumulative(document.getElementById("w-tax-card"), 0, 0);
    const tele = document.getElementById("w-telemetry"); if (tele) tele.innerHTML = "";
    const ticker = document.getElementById("w-ticker"); if (ticker) ticker.innerHTML = "";
  }

  function liveMove(r) {
    if (!W.lv.game) liveReset();
    const g = W.lv.game;
    const meta = liveEngineOf(r.engine);
    if (r.color === "w") {
      g.white = r.engine;
      W.dom.plateBotInfo.innerHTML = plateHTML(r.engine, meta.country, "white",
        { lang: meta.lang, rating: meta.rating });
    } else {
      g.black = r.engine;
      W.dom.plateTopInfo.innerHTML = plateHTML(r.engine, meta.country, "black",
        { lang: meta.lang, rating: meta.rating });
    }
    CWC.board.render(W.dom.boardEl, r.fen, { lastMove: r.move, coords: true });
    renderEval(r.fen);
    W.dom.plateTopMat.innerHTML = materialHTML(r.fen, false);
    W.dom.plateBotMat.innerHTML = materialHTML(r.fen, true);
    g.tax += (r.delta_ms || 0); g.orch += (r.orch_ms || 0); g.ply = r.ply + 1;
    renderTaxCumulative(document.getElementById("w-tax-card"), g.tax, g.orch);
    renderTelemetry(document.getElementById("w-telemetry"),
      { uci: r.move, engine: r.engine, self_nodes: r.self_nodes, self_ms: r.self_ms,
        orch_ms: r.orch_ms, delta_ms: r.delta_ms });
    const ticker = document.getElementById("w-ticker");
    if (ticker) {
      if (r.ply % 2 === 0) ticker.appendChild(el("span", "ml-num mono", (r.ply / 2 + 1) + "."));
      ticker.appendChild(el("span", "ml-mv", r.move));
      ticker.scrollTop = ticker.scrollHeight;
    }
  }

  function liveResult(r) {
    const t = W.lv.tally;
    t[r.white] = t[r.white] || 0; t[r.black] = t[r.black] || 0;
    if (r.result === "1-0") t[r.white]++;
    else if (r.result === "0-1") t[r.black]++;
    else { t[r.white] += 0.5; t[r.black] += 0.5; }
    W.lv.results.push(r);
    const sl = document.getElementById("w-scoreline");
    if (sl) {
      const score = Object.keys(t).map(n => esc(n) + " <b class='mono'>" + t[n] + "</b>").join("  ·  ");
      sl.innerHTML = '<div class="w-score-head">' + score + "</div>" +
        W.lv.results.slice(-8).reverse().map(x =>
          '<div class="w-score-row">game ' + x.game + ": " + esc(x.white) + " vs " + esc(x.black) +
          " → <b>" + esc(x.result) + "</b> <span class='muted'>(" + esc(x.reason) + ", " + x.plies + "p)</span></div>"
        ).join("");
    }
    W.lv.game = null;
  }

  function liveConnect() {
    if (W.lv.es) W.lv.es.close();
    liveReset();
    W.lv.tally = {}; W.lv.results = [];
    const sl = document.getElementById("w-scoreline"); if (sl) sl.innerHTML = "";
    const es = new EventSource("/api/stream");
    W.lv.es = es;
    es.addEventListener("config", e => {
      const c = JSON.parse(e.data);
      if (c.engine_meta) W.lv.meta = c.engine_meta;
      if (c.engine1) liveStatus('<span class="chip"><span class="live-dot"></span> streaming ' +
        esc(c.engine1) + " vs " + esc(c.engine2) + "</span>");
    });
    es.addEventListener("move", e => liveMove(JSON.parse(e.data)));
    es.addEventListener("result", e => liveResult(JSON.parse(e.data)));
    es.addEventListener("reset", () => {
      liveReset(); W.lv.tally = {}; W.lv.results = [];
      const s2 = document.getElementById("w-scoreline"); if (s2) s2.innerHTML = "";
    });
    es.addEventListener("done", () => {
      liveStatus('<span class="chip">✓ match complete</span>');
    });
    es.onerror = () => { /* SSE auto-reconnects; server sends reset on new match */ };
  }

  async function startLiveMatch() {
    const body = {
      engine1: document.getElementById("w-e1").value,
      engine2: document.getElementById("w-e2").value,
      mode: document.getElementById("w-mode").value,
      budget: +document.getElementById("w-budget").value,
      games: +document.getElementById("w-games").value,
    };
    liveStatus('<span class="chip">starting…</span>');
    try { await CWC.api.post("/api/start", body); }
    catch (e) { liveStatus('<span class="chip">failed to start</span>'); }
  }

  async function startLive() {
    buildLayout("live");
    removeKeys(); // no scrub/step keys in live
    buildLiveContext();
    if (!CWC.state.live) {
      CWC.ui.emptyState(W.dom.ctxCol, {
        icon: "warning",
        msg: "Live matches need the live server. Run: python3 ui/live_server.py",
      });
      CWC.board.render(W.dom.boardEl, START_FEN, { coords: true });
      return;
    }
    let cfg;
    try { cfg = await CWC.api.get("/api/config"); }
    catch (e) {
      CWC.ui.emptyState(W.dom.ctxCol, { icon: "warning", msg: "Live server not reachable." });
      return;
    }
    W.lv.meta = cfg.engines || {};
    fillEngineSelects(cfg);
    liveReset();
    liveConnect();
  }

  function stopLive() {
    if (W.lv.es) { W.lv.es.close(); W.lv.es = null; }
  }

  /* ================= keyboard ================= */

  function installKeys() {
    removeKeys();
    W.keyHandler = e => {
      if (W.sub !== "replay") return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") { rpStop(); rpShow(W.rp.i - 1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { rpStop(); rpShow(W.rp.i + 1); e.preventDefault(); }
      else if (e.key === " ") { rpTogglePlay(); e.preventDefault(); }
      else if (e.key === "Home") { rpStop(); rpShow(0); e.preventDefault(); }
      else if (e.key === "End") { rpStop(); rpShow(W.rp.positions.length - 1); e.preventDefault(); }
    };
    document.addEventListener("keydown", W.keyHandler);
  }
  function removeKeys() {
    if (W.keyHandler) { document.removeEventListener("keydown", W.keyHandler); W.keyHandler = null; }
  }

  /* ================= result ticker (B6) ================= */
  // Horizontal strip of the last ~6 played results (mini flags + score), sourced
  // from tournament state. Subscribes to wc:updated to prepend new results.
  const RT = { host: null, seen: {} };

  function rtHost() {
    if (!RT.host) RT.host = document.getElementById("result-ticker");
    return RT.host;
  }

  // Map a played match to a display record. score is "captures" style W–L via
  // the match result string (1-0 / 0-1 / draw) rendered from each side's view.
  function rtRecord(m, teamsById) {
    const ta = teamsById[m.a], tb = teamsById[m.b];
    if (!ta || !tb) return null;
    let sa = "½", sb = "½";
    if (m.result === "1-0") { sa = "1"; sb = "0"; }
    else if (m.result === "0-1") { sa = "0"; sb = "1"; }
    return {
      id: m.id,
      aCode: ta.country, bCode: tb.country,
      aName: ta.country, bName: tb.country,
      sa, sb,
      aWin: m.winner === m.a, bWin: m.winner === m.b,
    };
  }

  function rtChip(rec) {
    const c = el("div", "rt-item chip chip--result");
    c.innerHTML =
      '<span class="rt-side' + (rec.aWin ? " is-win" : "") + '">' +
        '<span class="rt-flag" aria-hidden="true">' + esc(CWC.flag(rec.aCode)) + "</span>" +
        '<span class="rt-code">' + esc(rec.aName) + "</span></span>" +
      '<span class="rt-score tnum">' + esc(rec.sa) + "–" + esc(rec.sb) + "</span>" +
      '<span class="rt-side' + (rec.bWin ? " is-win" : "") + '">' +
        '<span class="rt-code">' + esc(rec.bName) + "</span>" +
        '<span class="rt-flag" aria-hidden="true">' + esc(CWC.flag(rec.bCode)) + "</span></span>";
    return c;
  }

  function collectPlayed(state) {
    const out = [];
    (state.fixtures || []).forEach(m => { if (m.played) out.push(m); });
    (state.knockout || []).forEach(r => (r.ties || []).forEach(t => { if (t.played) out.push(t); }));
    return out;
  }

  // Full (re)build from a state snapshot (last 6, newest first).
  function rebuildTicker(state) {
    const host = rtHost();
    if (!host || !state) return;
    const teamsById = state.teams || {};
    const played = collectPlayed(state);
    host.innerHTML = "";
    RT.seen = {};
    played.slice(-6).reverse().forEach(m => {
      const rec = rtRecord(m, teamsById);
      if (!rec) return;
      RT.seen[rec.id] = true;
      host.appendChild(rtChip(rec));
    });
  }

  // Prepend newly-played results on a wc:updated event.
  function updateTicker(state) {
    const host = rtHost();
    if (!host || !state) return;
    if (!host.childElementCount) { rebuildTicker(state); return; }
    const teamsById = state.teams || {};
    const played = collectPlayed(state);
    const fresh = played.filter(m => !RT.seen[m.id]);
    if (!fresh.length) return;
    fresh.forEach(m => {
      const rec = rtRecord(m, teamsById);
      if (!rec) return;
      RT.seen[rec.id] = true;
      const chip = rtChip(rec);
      if (!CWC.reducedMotion()) CWC.anim.flash(chip, "rt-new", 900);
      host.insertBefore(chip, host.firstChild);
    });
    while (host.childElementCount > 6) host.removeChild(host.lastChild);
  }

  CWC.bus.on("wc:updated", state => {
    // state may be the WC public_state (has .teams); if not, ignore.
    if (state && state.teams) updateTicker(state);
  });
  // Populate from whatever tournament data is present at load.
  CWC.bus.on("data:loaded", () => {
    const d = CWC.state.data;
    if (d && d.teams) rebuildTicker(d);
  });

  /* ================= view shell ================= */

  // On first opportunity, seed the result ticker from live tournament state.
  let rtSeeded = false;
  async function seedTicker() {
    if (rtSeeded) return;
    rtSeeded = true;
    if (CWC.state.live) {
      try { const st = await CWC.api.get("/api/tournament"); if (st && st.teams) rebuildTicker(st); }
      catch (e) { /* ignore */ }
    } else if (CWC.state.data && CWC.state.data.teams) {
      rebuildTicker(CWC.state.data);
    }
  }
  CWC.bus.on("route:change", seedTicker);

  CWC.registerView("watch", {
    init() { W.el = this._el; },
    show(params) {
      let sub = params && params[0];
      if (SUBS.indexOf(sub) < 0) sub = "replay";
      W.sub = sub;
      if (sub === "replay") { stopLive(); startReplay(params); }
      else { rpStop(); startLive(); }
    },
    hide() {
      rpStop();
      stopLive();
      removeKeys();
    },
  });
})();
