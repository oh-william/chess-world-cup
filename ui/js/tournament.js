"use strict";
/* tournament.js — Workstream 3 (Tournament experience). Broadcast-grade
   World Cup view: Groups (hero + sticky group navigator + compact fixtures),
   Bracket (SVG elbow connectors, ghost bracket, champion moment), Standings.
   Sub-routes #/tournament/{groups,bracket,standings}. Renders into
   #view-tournament (_el). Vanilla JS, no build, inline SVG only, tokenized. */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const el = CWC.el, esc = CWC.esc;

  const SUBS = ["groups", "bracket", "standings"];

  // shared module state
  const T = {
    el: null,
    sub: "groups",
    wc: null,          // world-cup public_state
    busy: false,
    autofill: null,    // {abort,done,count} when a Play-all is running
    focusGroup: 0,     // which group index is focused in the Groups view
    betOpen: null,     // fixture id whose inline W/D/L strip is expanded
    stdEvent: 0,       // standings event index
    stdSort: null,     // {key, dir}
    champShown: null,  // last champion id we ran the moment for
    exBk: { es: null, br: null, running: false }, // exhibition knockout SSE state
    _ro: null,         // bracket ResizeObserver
    _delegated: false, // team-popover delegation installed
  };

  /* ================= data plumbing ================= */

  async function loadWc() {
    T.wc = await CWC.api.get("/api/tournament");
    CWC.state.wc = T.wc;
    return T.wc;
  }
  function wcTeam(tid) { return T.wc && T.wc.teams ? T.wc.teams[tid] : null; }

  async function wcAction(path, body) {
    const res = await CWC.api.post(path, body || {});
    if (res.state) {
      T.wc = res.state;
      CWC.state.wc = res.state;
      CWC.bus.emit("wc:updated", res.state); // let betting settle
    }
    return res;
  }

  async function wcPlay(mid, rowEl) {
    if (T.busy) return;
    T.busy = true;
    try { await wcAction("/api/tournament/play", { match_id: mid }); }
    finally { T.busy = false; }
    T._flashMatch = mid; // score reveal after re-render
    render();
  }
  async function wcAdvance() { await wcAction("/api/tournament/advance", {}); render(); }
  async function wcReset() {
    T.champShown = null;
    await wcAction("/api/tournament/reset", {});
    render();
  }

  /* ================= small shared UI helpers ================= */

  const GLET = i => String.fromCharCode(65 + i);

  // Team chip: flag + lang chip + label. `t` is a WC team object OR an engine
  // name string (falls back to the engines map). Carries data-team for the
  // delegated popover.
  function teamChip(t, opts) {
    opts = opts || {};
    let country, lang, label, tid = null, engine;
    if (typeof t === "string") {
      const e = CWC.engineOf(t);
      country = e.country; lang = e.lang; label = t; engine = t;
    } else if (t) {
      country = t.country; lang = t.lang; engine = t.engine; tid = t.id;
      label = opts.label || t.name || t.code || t.country;
    } else {
      country = "XX"; lang = "?"; label = "?"; engine = "?";
    }
    const key = CWC.langKey(lang);
    const chip = el("span", "team-chip");
    if (tid != null) { chip.dataset.team = String(tid); chip.tabIndex = 0; chip.setAttribute("role", "button"); }
    chip.innerHTML =
      '<span class="tc-flag" aria-hidden="true">' + esc(CWC.flag(country)) + "</span>" +
      '<span class="chip chip--lang tc-lang" data-lang="' + esc(key) + '">' + esc(lang) + "</span>" +
      '<span class="tc-name">' + esc(label) + "</span>";
    return chip;
  }

  // Compact 3-segment micro odds bar + a single dominant label.
  // Near-certain outcomes render the grey ">99%" .odds-cap, never a raw decimal.
  function microOdds(oddsArr) {
    const [w, d, l] = oddsArr.map(x => Math.max(0, Math.min(1, x)));
    const pc = x => Math.round(x * 100);
    const wrap = el("span", "odds--micro-wrap");
    const bar = el("span", "odds--micro");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label",
      "Odds: win " + pc(w) + "%, draw " + pc(d) + "%, loss " + pc(l) + "%");
    bar.innerHTML =
      '<i class="odds-w" style="width:' + pc(w) + '%"></i>' +
      '<i class="odds-d" style="width:' + pc(d) + '%"></i>' +
      '<i class="odds-l" style="width:' + pc(l) + '%"></i>';
    wrap.appendChild(bar);

    // dominant outcome label
    const idx = w >= d && w >= l ? 0 : (l >= d ? 2 : 1);
    const p = [w, d, l][idx];
    const tag = ["1", "X", "2"][idx];
    const lbl = el("span", "odds--micro-lbl tnum");
    if (p >= 0.99) {
      lbl.className = "odds-cap tnum";
      lbl.textContent = tag + " >99%";
    } else {
      lbl.textContent = tag + " " + Math.round(p * 100) + "%";
    }
    wrap.appendChild(lbl);
    return wrap;
  }

  function seg(items, active, onPick, label) {
    const s = el("div", "seg");
    s.setAttribute("role", "tablist");
    if (label) s.setAttribute("aria-label", label);
    items.forEach(it => {
      const b = el("button", null, it.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", it.id === active ? "true" : "false");
      b.tabIndex = it.id === active ? 0 : -1;
      b.addEventListener("click", () => onPick(it.id));
      b.addEventListener("keydown", e => {
        const i = items.findIndex(x => x.id === active);
        let ni = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") ni = (i + 1) % items.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") ni = (i - 1 + items.length) % items.length;
        else if (e.key === "Home") ni = 0;
        else if (e.key === "End") ni = items.length - 1;
        if (ni >= 0) { e.preventDefault(); onPick(items[ni].id); }
      });
      s.appendChild(b);
    });
    return s;
  }

  function needsLiveEmpty(host) {
    CWC.ui.emptyState(host, {
      icon: "warning",
      msg: "This section needs the live server. Run: python3 ui/live_server.py",
    });
  }

  /* ================= team popover (event-delegated) ================= */

  function ensureDelegation(root) {
    if (T._delegated) return;
    T._delegated = true;
    const handler = ev => {
      const chip = ev.target.closest ? ev.target.closest("[data-team]") : null;
      if (!chip || !root.contains(chip)) return;
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
      if (ev.type === "keydown") ev.preventDefault();
      const tid = +chip.dataset.team;
      const t = wcTeam(tid);
      if (!t) return;
      CWC.teamPopover(chip, teamPopHtml(t));
    };
    root.addEventListener("click", handler);
    root.addEventListener("keydown", handler);
  }

  function teamPopHtml(t) {
    const lang = t.lang || "?";
    const rows = [];
    const num = (v, suf) => '<span class="tnum">' + esc(String(v)) + (suf || "") + "</span>";
    if (t.fifa_points != null || t.pot != null) {
      const bits = [];
      if (t.pot != null) bits.push("Pot " + num(t.pot));
      if (t.fifa_points != null) bits.push(num(t.fifa_points) + " pts");
      rows.push(["FIFA", bits.join(" · ")]);
    }
    rows.push(["Engine", esc(t.engine || "?")]);
    rows.push(["Language", esc(lang)]);
    if (t.rating != null) rows.push(["Chess rating", num(Math.round(t.rating))]);
    if (t.nodes != null) rows.push(["Nodes", num(CWC.fmt.num(t.nodes))]);
    // title odds: from live sim if available on the team, else derived rank hint
    const to = t.champion_pct != null ? (t.champion_pct * 100)
      : (t.title_pct != null ? t.title_pct : null);
    if (to != null) rows.push(["Title odds", num(to.toFixed(1), "%")]);

    const body = rows.map(r =>
      '<div class="tp-row"><span class="tp-k">' + r[0] +
      '</span><span class="tp-v">' + r[1] + "</span></div>").join("");
    return (
      '<div class="tp-head">' +
      '<span class="tp-flag" aria-hidden="true">' + esc(CWC.flag(t.country)) + "</span>" +
      '<span class="tp-name">' + esc(t.name || t.code || t.country) + "</span>" +
      '<span class="chip chip--lang" data-lang="' + esc(CWC.langKey(lang)) +
      '">' + esc(lang) + "</span></div>" +
      '<div class="tp-body">' + body + "</div>"
    );
  }

  /* ================= GROUPS ================= */

  function renderGroups(host) {
    if (!CWC.state.live) { needsLiveEmpty(host); return; }
    if (!T.wc) { CWC.ui.skeleton(host, "table"); loadWc().then(render).catch(() => {}); return; }
    const s = T.wc;
    host.innerHTML = "";

    host.appendChild(broadcastHero(s));

    if (s.stage !== "group") {
      const note = el("div", "card wc-note");
      note.innerHTML = "Group stage complete. See the <b>Bracket</b> tab for the knockout.";
      const go = el("button", "btn btn--primary", "Go to Bracket");
      go.type = "button";
      go.addEventListener("click", () => go2("bracket"));
      note.appendChild(go);
      host.appendChild(note);
      return;
    }

    host.appendChild(stageBar(s));

    // sticky group navigator (A…L) — focuses ONE group at a time
    const ng = s.groups.length;
    if (T.focusGroup >= ng) T.focusGroup = 0;
    host.appendChild(groupNav(s));

    const focus = el("div", "wc-focus");
    focus.appendChild(groupCard(s.groups[T.focusGroup]));
    host.appendChild(focus);
  }

  // Salience score for choosing "Match of the Day": strong+strong unplayed.
  function salience(m) {
    const a = wcTeam(m.a), b = wcTeam(m.b);
    if (!a || !b) return -1;
    const ra = a.rating || (a.fifa_points || 0), rb = b.rating || (b.fifa_points || 0);
    // reward two strong sides, penalise mismatch (want a genuine contest)
    return (ra + rb) - Math.abs(ra - rb) * 0.5;
  }

  function broadcastHero(s) {
    const hero = el("section", "wc-broadcast card");
    hero.setAttribute("aria-label", "Chess World Cup 2026");

    const played = s.fixtures.filter(f => f.played).length;
    const total = s.fixtures.length;

    const head = el("div", "bc-head");
    head.innerHTML =
      '<div class="bc-title">CHESS WORLD CUP <span class="bc-year tnum">2026</span></div>' +
      '<div class="bc-count"><span class="bc-count-n tnum">0</span>' +
      '<span class="bc-count-tot tnum">/' + total + '</span> matches</div>';
    hero.appendChild(head);
    const nEl = head.querySelector(".bc-count-n");
    CWC.anim.countUp(nEl, 0, played, { fmt: v => String(Math.round(v)), ms: 700 });

    // Match of the Day: highest-salience unplayed fixture.
    const upcoming = s.fixtures.filter(f => !f.played);
    if (upcoming.length) {
      let best = upcoming[0], bestS = salience(best);
      upcoming.forEach(m => { const sc = salience(m); if (sc > bestS) { best = m; bestS = sc; } });
      hero.appendChild(motdCard(best));
    } else {
      const done = el("div", "bc-motd bc-motd--done");
      done.innerHTML = '<div class="bc-motd-tag">Group stage</div>' +
        '<div class="bc-motd-vs">All group fixtures played</div>';
      hero.appendChild(done);
    }

    const thesis = el("p", "bc-thesis");
    thesis.innerHTML =
      "48 real nations. 8 engines. 4 languages. One question: " +
      '<a href="#/analysis">what does the language cost?</a>';
    hero.appendChild(thesis);
    return hero;
  }

  function motdCard(m) {
    const a = wcTeam(m.a), b = wcTeam(m.b);
    const card = el("div", "bc-motd");
    card.innerHTML = '<div class="bc-motd-tag">★ Match of the Day · Group ' +
      GLET(m.group) + "</div>";
    const vs = el("div", "bc-motd-vs");
    vs.appendChild(teamChip(a, { label: a ? (a.name || a.code) : "?" }));
    const mid = el("span", "bc-motd-mid");
    mid.appendChild(microOdds(CWC.betting.oddsFor(m)));
    vs.appendChild(mid);
    vs.appendChild(teamChip(b, { label: b ? (b.name || b.code) : "?" }));
    card.appendChild(vs);
    const play = el("button", "btn btn--sm btn--primary bc-motd-play", "");
    play.type = "button";
    play.innerHTML = CWC.icon("play") + " Play";
    play.disabled = !!T.autofill;
    play.addEventListener("click", () => wcPlay(m.id));
    card.appendChild(play);
    return card;
  }

  function stageBar(s) {
    const bar = el("div", "wc-stage card");
    const played = s.fixtures.filter(f => f.played).length;
    const total = s.fixtures.length;
    const pct = total ? (100 * played / total) : 0;

    const head = el("div", "wc-stage-head");
    head.innerHTML =
      '<div class="wc-stage-label">Group Stage — <span class="tnum">' +
      played + "/" + total + "</span> played</div>";
    bar.appendChild(head);

    const track = el("div", "wc-progress");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(total));
    track.setAttribute("aria-valuenow", String(T.autofill ? T.autofill.done : played));
    const fill = el("div", "wc-progress-fill");
    // during Play-all, show determinate progress of the batch
    fill.style.width = (T.autofill
      ? (100 * (played) / total)
      : pct) + "%";
    track.appendChild(fill);
    bar.appendChild(track);

    const actions = el("div", "wc-stage-actions");

    if (s.stage === "group" && !s.group_done) {
      if (T.autofill) {
        const prog = el("span", "chip wc-af-progress");
        prog.innerHTML = '<span class="live-dot"></span> <span class="tnum">' +
          T.autofill.done + "/" + T.autofill.count + "</span> playing…";
        actions.appendChild(prog);
        const cancel = el("button", "btn btn--danger", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => { if (T.autofill) T.autofill.abort = true; });
        actions.appendChild(cancel);
      } else {
        const playAll = el("button", "btn btn--primary", "Play all remaining");
        playAll.type = "button";
        playAll.addEventListener("click", playAllRemaining);
        actions.appendChild(playAll);
      }
    }

    if (s.stage === "group" && s.group_done) {
      const adv = el("button", "btn btn--primary", "Advance to Knockout");
      adv.type = "button";
      adv.disabled = !!T.autofill;
      adv.addEventListener("click", wcAdvance);
      actions.appendChild(adv);
    }

    const draw = el("button", "btn", "New draw");
    draw.type = "button";
    draw.disabled = !!T.autofill;
    draw.addEventListener("click", () => { if (!T.autofill) wcReset(); });
    actions.appendChild(draw);

    bar.appendChild(actions);
    return bar;
  }

  async function playAllRemaining() {
    if (T.autofill || T.busy) return;
    const pending = T.wc.fixtures.filter(f => !f.played).map(f => f.id);
    if (!pending.length) return;
    T.autofill = { abort: false, done: 0, count: pending.length };
    render();
    for (let k = 0; k < pending.length; k++) {
      if (T.autofill.abort) break;
      try { await wcAction("/api/tournament/play", { match_id: pending[k] }); }
      catch (e) { break; }
      T.autofill.done = k + 1;
      render();
    }
    T.autofill = null;
    render();
  }

  // Sticky A…L pill row — focuses one group; badges qualified progress.
  function groupNav(s) {
    const nav = el("div", "wc-groupnav");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Groups");
    s.groups.forEach(g => {
      const done = T.wc.fixtures.filter(f => f.group === g.index).every(f => f.played);
      const any = T.wc.fixtures.some(f => f.group === g.index && f.played);
      const b = el("button", "gn-pill" + (g.index === T.focusGroup ? " is-on" : "") +
        (done ? " is-done" : any ? " is-live" : ""), GLET(g.index));
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", g.index === T.focusGroup ? "true" : "false");
      b.tabIndex = g.index === T.focusGroup ? 0 : -1;
      b.title = "Group " + GLET(g.index);
      b.addEventListener("click", () => { T.focusGroup = g.index; render(); });
      b.addEventListener("keydown", e => {
        let ni = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") ni = (T.focusGroup + 1) % s.groups.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") ni = (T.focusGroup - 1 + s.groups.length) % s.groups.length;
        else if (e.key === "Home") ni = 0;
        else if (e.key === "End") ni = s.groups.length - 1;
        if (ni >= 0) { e.preventDefault(); T.focusGroup = ni; render(); }
      });
      nav.appendChild(b);
    });
    return nav;
  }

  function groupCard(g) {
    const card = el("div", "group-card card");
    const head = el("div", "group-head");
    head.appendChild(el("div", "group-name", "Group " + GLET(g.index)));
    const legend = el("div", "group-legend");
    legend.innerHTML = '<span class="lg lg-q">Q</span> top 2 qualify';
    head.appendChild(legend);
    card.appendChild(head);

    // compact standings table
    const tbl = el("table", "table group-table");
    tbl.innerHTML =
      "<thead><tr><th class='num'>#</th><th>Team</th><th class='num'>Pl</th>" +
      "<th class='num'>Pts</th><th class='num'>±⚔</th></tr></thead>";
    const tb = el("tbody");
    g.table.forEach((r, i) => {
      const tr = el("tr", i < 2 ? "is-qual" : "");
      const posTd = el("td", "num pos-cell");
      posTd.appendChild(el("span", "pos-num tnum", String(i + 1)));
      if (i < 2) posTd.appendChild(el("span", "q-badge", "Q"));
      tr.appendChild(posTd);
      const teamTd = el("td");
      teamTd.appendChild(teamChip(wcTeam(r.team)));
      tr.appendChild(teamTd);
      const pl = el("td", "num tnum"); pl.textContent = r.P; tr.appendChild(pl);
      const pts = el("td", "num tnum"); pts.innerHTML = "<b>" + r.pts + "</b>"; tr.appendChild(pts);
      const d = r.cf - r.ca;
      const diff = el("td", "num tnum"); diff.textContent = (d > 0 ? "+" : "") + d; tr.appendChild(diff);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);

    // compact ~40px fixture rows
    const fx = el("div", "group-fixtures");
    T.wc.fixtures.filter(f => f.group === g.index).forEach(m => fx.appendChild(fixtureRow(m)));
    card.appendChild(fx);
    return card;
  }

  // Compact single-row fixture: flag·team — micro-odds/score — team·flag
  function fixtureRow(m) {
    const row = el("div", "fx");
    const a = wcTeam(m.a), b = wcTeam(m.b);
    const left = el("span", "fx-side fx-a");
    left.appendChild(teamChip(a));
    const right = el("span", "fx-side fx-b");
    right.appendChild(teamChip(b));

    if (m.played) {
      row.classList.add("is-played");
      row.appendChild(left);
      const mid = el("span", "fx-mid");
      const res = m.result === "1/2-1/2" ? "½–½" : m.result;
      const score = el("span", "chip chip--result fx-scorechip tnum", res);
      // team-color underlines: winner side tinted
      if (m.winner === m.a) score.classList.add("win-a");
      else if (m.winner === m.b) score.classList.add("win-b");
      else score.classList.add("win-d");
      if (T._flashMatch === m.id) { CWC.anim.flash(score, "is-flash"); }
      mid.appendChild(score);
      row.appendChild(mid);
      row.appendChild(right);
      if (m.hasGame) {
        const watch = el("button", "btn btn--sm fx-watch", "");
        watch.type = "button";
        watch.setAttribute("aria-label", "Watch replay");
        watch.innerHTML = CWC.icon("play");
        watch.addEventListener("click", () => {
          location.hash = "#/watch/replay/wc=" + encodeURIComponent(m.id);
        });
        row.appendChild(watch);
      }
    } else {
      row.appendChild(left);
      const mid = el("span", "fx-mid");
      mid.appendChild(microOdds(CWC.betting.oddsFor(m)));
      row.appendChild(mid);
      row.appendChild(right);

      const actions = el("span", "fx-act");
      const bet = el("button", "btn btn--sm fx-bet" + (T.betOpen === m.id ? " is-on" : ""), "Bet");
      bet.type = "button";
      bet.setAttribute("aria-expanded", T.betOpen === m.id ? "true" : "false");
      bet.addEventListener("click", () => {
        T.betOpen = T.betOpen === m.id ? null : m.id;
        render();
      });
      actions.appendChild(bet);
      const play = el("button", "btn btn--sm btn--primary fx-play", "");
      play.type = "button";
      play.innerHTML = CWC.icon("play");
      play.setAttribute("aria-label", "Play match");
      play.disabled = !!T.autofill;
      play.addEventListener("click", () => wcPlay(m.id));
      actions.appendChild(play);
      row.appendChild(actions);

      if (T.betOpen === m.id) {
        const strip = el("div", "fx-betstrip");
        const labels = {
          W: a ? (a.code || a.country) : "1",
          D: "Draw",
          L: b ? (b.code || b.country) : "2",
        };
        ["W", "D", "L"].forEach(out => {
          const bb = el("button", "btn btn--sm bet-" + out.toLowerCase(), labels[out]);
          bb.type = "button";
          bb.title = "Bet " + labels[out];
          bb.addEventListener("click", () => CWC.betting.openSlip(m, out));
          strip.appendChild(bb);
        });
        row.appendChild(strip);
      }
    }
    return row;
  }

  /* ================= BRACKET ================= */

  function renderBracket(host) {
    if (!CWC.state.live) { needsLiveEmpty(host); return; }
    if (!T.wc) { CWC.ui.skeleton(host, "table"); loadWc().then(render).catch(() => {}); return; }
    host.innerHTML = "";

    const s = T.wc;
    const wcWrap = el("div", "card bracket-panel");
    wcWrap.appendChild(el("h2", "panel-title", "World Cup Knockout"));

    const board = (s.knockout && s.knockout.length)
      ? bracketBoard(s)
      : ghostBracket();
    wcWrap.appendChild(board);
    host.appendChild(wcWrap);

    // wire elbow connectors + resize recompute
    installConnectors(board);

    // champion moment (one-shot per champion)
    if (s.champion != null && T.champShown !== s.champion) {
      T.champShown = s.champion;
      requestAnimationFrame(() => championMoment(board, s.champion));
    }

    host.appendChild(exhibitionPanel());
  }

  // Dimmed ghost bracket: 32 seeded slots across rounds, before knockout exists.
  function ghostBracket() {
    const board = el("div", "bracket bracket--ghost");
    board.setAttribute("aria-hidden", "true");
    const rounds = [
      { name: "Round of 32", n: 16 },
      { name: "Round of 16", n: 8 },
      { name: "Quarter-finals", n: 4 },
      { name: "Semi-finals", n: 2 },
      { name: "Final", n: 1 },
    ];
    let seed = 1;
    rounds.forEach((r, ri) => {
      const col = el("div", "bracket-round");
      col.appendChild(el("div", "round-name", r.name));
      for (let i = 0; i < r.n; i++) {
        const tie = el("div", "tie tie--ghost");
        tie.appendChild(ghostSide(ri === 0 ? seed++ : null));
        tie.appendChild(ghostSide(ri === 0 ? seed++ : null));
        col.appendChild(tie);
      }
      board.appendChild(col);
    });
    const cap = el("div", "bracket-ghostcap muted",
      "Knockout seeds populate once the group stage completes.");
    const shell = el("div", "bracket-ghostwrap");
    shell.appendChild(board);
    shell.appendChild(cap);
    return shell;
  }
  function ghostSide(seed) {
    const s = el("div", "tie-side is-ghost");
    if (seed != null) s.appendChild(el("span", "seed tnum", String(seed)));
    s.appendChild(el("span", "gh-bar"));
    return s;
  }

  function bracketBoard(s) {
    const wrap = el("div", "bracket-wrap");
    const board = el("div", "bracket");
    // champion path: winner ids for gold glow
    const champId = s.champion;
    (s.knockout || []).forEach(round => {
      const col = el("div", "bracket-round");
      col.appendChild(el("div", "round-name", round.name));
      round.ties.forEach(t => col.appendChild(koTie(t, champId)));
      board.appendChild(col);
    });
    if (s.champion != null) {
      const champCol = el("div", "bracket-round champion-col");
      champCol.appendChild(el("div", "round-name", "Champion"));
      const c = el("div", "tie champion-card");
      c.dataset.champCard = "1";
      const trophy = el("div", "trophy"); trophy.innerHTML = CWC.icon("trophy");
      c.appendChild(trophy);
      const bigFlag = el("div", "champ-flag", CWC.flag(wcTeam(s.champion) ? wcTeam(s.champion).country : ""));
      c.appendChild(bigFlag);
      const side = el("div", "tie-side is-win");
      side.appendChild(teamChip(wcTeam(s.champion)));
      c.appendChild(side);
      champCol.appendChild(c);
      board.appendChild(champCol);
    }
    wrap.appendChild(board);
    return wrap;
  }

  function koTie(t, champId) {
    const card = el("div", "tie");
    card.dataset.tie = t.id;
    const onPath = t.played && (t.winner === champId);
    if (onPath) card.classList.add("on-champ-path");
    card.appendChild(koSide(t.a, t.seedA, t.played && t.winner === t.a));
    card.appendChild(koSide(t.b, t.seedB, t.played && t.winner === t.b));
    const foot = el("div", "tie-foot");
    if (t.played) {
      const res = t.result === "1/2-1/2" ? "½–½" : t.result;
      foot.innerHTML = '<span class="tnum">' + esc(res) + "</span>" +
        (t.tiebreak ? " · " + esc(t.tiebreak) : "") +
        ' · <span class="tnum">' + t.plies + "p</span>";
      if (t.hasGame) {
        const w = el("button", "btn btn--sm", "");
        w.type = "button";
        w.innerHTML = CWC.icon("play") + " watch";
        w.addEventListener("click", () => {
          location.hash = "#/watch/replay/wc=" + encodeURIComponent(t.id);
        });
        foot.appendChild(w);
      }
    } else {
      foot.appendChild(microOdds(CWC.betting.oddsFor(t)));
      const bet = el("button", "btn btn--sm", "Bet");
      bet.type = "button";
      bet.addEventListener("click", () => CWC.betting.openSlip(t, "W"));
      foot.appendChild(bet);
      const play = el("button", "btn btn--sm btn--primary", "");
      play.type = "button";
      play.innerHTML = CWC.icon("play");
      play.setAttribute("aria-label", "Play tie");
      play.disabled = T.busy;
      play.addEventListener("click", () => wcPlay(t.id));
      foot.appendChild(play);
    }
    card.appendChild(foot);
    return card;
  }

  function koSide(tid, seed, isWin) {
    const s = el("div", "tie-side" + (isWin ? " is-win" : ""));
    if (seed != null) s.appendChild(el("span", "seed tnum", String(seed)));
    s.appendChild(teamChip(wcTeam(tid)));
    return s;
  }

  /* ---- inline-SVG elbow connectors between adjacent bracket columns ---- */

  function installConnectors(boardWrap) {
    const board = boardWrap.querySelector(".bracket");
    if (!board) return;
    if (T._ro) { try { T._ro.disconnect(); } catch (e) {} T._ro = null; }
    const draw = () => drawConnectors(board);
    // draw now and on resize of the board
    requestAnimationFrame(draw);
    if (typeof ResizeObserver !== "undefined") {
      T._ro = new ResizeObserver(() => requestAnimationFrame(draw));
      T._ro.observe(board);
    } else {
      window.addEventListener("resize", draw);
    }
  }

  function drawConnectors(board) {
    if (!board || !board.isConnected) return;
    let svg = board.querySelector("svg.bracket-links");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "bracket-links");
      svg.setAttribute("aria-hidden", "true");
      board.insertBefore(svg, board.firstChild);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const brect = board.getBoundingClientRect();
    svg.setAttribute("width", String(board.scrollWidth));
    svg.setAttribute("height", String(board.scrollHeight));
    svg.setAttribute("viewBox", "0 0 " + board.scrollWidth + " " + board.scrollHeight);

    const cols = Array.prototype.filter.call(board.children, c => c.classList && c.classList.contains("bracket-round"));
    const NS = "http://www.w3.org/2000/svg";
    const mk = (d, cls) => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); if (cls) p.setAttribute("class", cls); return p; };

    for (let ci = 0; ci < cols.length - 1; ci++) {
      const cur = Array.prototype.filter.call(cols[ci].children, c => c.classList && c.classList.contains("tie"));
      const nxt = Array.prototype.filter.call(cols[ci + 1].children, c => c.classList && c.classList.contains("tie"));
      if (!nxt.length) continue;
      cur.forEach((tie, i) => {
        const target = nxt[Math.floor(i / 2)];
        if (!target) return;
        const r1 = tie.getBoundingClientRect();
        const r2 = target.getBoundingClientRect();
        const x1 = r1.right - brect.left + board.scrollLeft;
        const y1 = r1.top + r1.height / 2 - brect.top + board.scrollTop;
        const x2 = r2.left - brect.left + board.scrollLeft;
        const y2 = r2.top + r2.height / 2 - brect.top + board.scrollTop;
        const mx = x1 + (x2 - x1) / 2;
        const d = "M" + x1 + " " + y1 + " H" + mx + " V" + y2 + " H" + x2;
        const gold = tie.classList.contains("on-champ-path") && target.classList.contains("on-champ-path");
        svg.appendChild(mk(d, gold ? "link link--champ" : "link"));
      });
    }
    // final column -> champion card
    const champ = board.querySelector('[data-champ-card]');
    if (champ && cols.length >= 2) {
      const finals = Array.prototype.filter.call(cols[cols.length - 2].children, c => c.classList && c.classList.contains("tie"));
      const fin = finals[0];
      if (fin) {
        const r1 = fin.getBoundingClientRect(), r2 = champ.getBoundingClientRect();
        const x1 = r1.right - brect.left + board.scrollLeft;
        const y1 = r1.top + r1.height / 2 - brect.top + board.scrollTop;
        const x2 = r2.left - brect.left + board.scrollLeft;
        const y2 = r2.top + r2.height / 2 - brect.top + board.scrollTop;
        const mx = x1 + (x2 - x1) / 2;
        svg.appendChild(mk("M" + x1 + " " + y1 + " H" + mx + " V" + y2 + " H" + x2, "link link--champ"));
      }
    }
  }

  /* ---- champion moment: confetti burst + toast ---- */

  function championMoment(boardWrap, champId) {
    const card = boardWrap.querySelector('[data-champ-card]');
    const t = wcTeam(champId);
    const name = t ? (t.name || t.code || t.country) : "Champion";
    if (card) {
      if (CWC.reducedMotion()) {
        card.classList.add("champ-in-rm");
      } else {
        card.classList.add("champ-in");
        confettiBurst(card);
      }
    }
    CWC.ui.toast("🏆 " + name + " win the Chess World Cup!", "ok");
  }

  function confettiBurst(anchor) {
    const NS = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(NS, "svg");
    layer.setAttribute("class", "confetti");
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("viewBox", "0 0 200 200");
    const colors = ["--accent", "--green", "--blue", "--red", "--ink-2"];
    for (let i = 0; i < 28; i++) {
      const r = document.createElementNS(NS, "rect");
      const ang = (Math.PI * 2 * i) / 28 + Math.random() * 0.4;
      const dist = 60 + Math.random() * 40;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 10;
      r.setAttribute("x", "98"); r.setAttribute("y", "98");
      r.setAttribute("width", String(3 + Math.random() * 3));
      r.setAttribute("height", String(5 + Math.random() * 4));
      r.setAttribute("fill", "var(" + colors[i % colors.length] + ")");
      r.style.setProperty("--dx", dx + "px");
      r.style.setProperty("--dy", dy + "px");
      r.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
      r.style.animationDelay = (Math.random() * 0.08) + "s";
      layer.appendChild(r);
    }
    anchor.appendChild(layer);
    setTimeout(() => { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 1400);
  }

  /* ---------- Exhibition knockout (8 engines) SSE ---------- */

  function exhibitionPanel() {
    const wrap = el("div", "card bracket-panel exhibition");
    const head = el("div", "ex-head");
    head.appendChild(el("h2", "panel-title", "Exhibition knockout (8 engines)"));
    const status = el("span", "chip ex-status", T.exBk.br && T.exBk.br.champion
      ? "🏆 champion: " + T.exBk.br.champion
      : (T.exBk.running ? "● live" : "idle"));
    status.id = "ex-status";
    head.appendChild(status);
    wrap.appendChild(head);

    const controls = el("div", "ex-controls");
    controls.innerHTML =
      '<label class="ex-field">budget <input class="ex-inp tnum" id="ex-budget" type="number" ' +
      'value="12000" min="1" step="1000"></label>' +
      '<label class="ex-field">games/tie <input class="ex-inp tnum" id="ex-games" type="number" ' +
      'value="4" min="1" max="8"></label>';
    const run = el("button", "btn btn--primary", "Run exhibition knockout");
    run.type = "button";
    run.addEventListener("click", () => startExhibition(wrap));
    controls.appendChild(run);
    wrap.appendChild(controls);

    const holder = el("div", "ex-bracket");
    holder.id = "ex-bracket";
    wrap.appendChild(holder);

    if (T.exBk.br) renderExBracket(holder, T.exBk.br);
    else renderExBracket(holder, null);
    return wrap;
  }

  function exStatus(msg) {
    const s = document.getElementById("ex-status");
    if (s) s.textContent = msg;
  }

  function exRound(name) {
    let r = T.exBk.br.rounds.find(x => x.name === name);
    if (!r) { r = { name, ties: [] }; T.exBk.br.rounds.push(r); }
    return r;
  }

  async function startExhibition(wrap) {
    const budget = +wrap.querySelector("#ex-budget").value || 12000;
    const games = +wrap.querySelector("#ex-games").value || 4;
    exStatus("seeding & starting…");
    try {
      await CWC.api.post("/api/bracket-start", { budget, games });
    } catch (e) { exStatus("failed to start"); return; }
    if (T.exBk.es) T.exBk.es.close();
    T.exBk.br = { seeds: [], rounds: [], champion: null, mode: "nodes", budget, games_per_tie: games };
    renderExBracket(document.getElementById("ex-bracket"), T.exBk.br);
    const es = new EventSource("/api/bracket-stream");
    T.exBk.es = es; T.exBk.running = true;

    es.addEventListener("seeds", e => {
      const d = JSON.parse(e.data);
      T.exBk.br.seeds = d.seeds; T.exBk.br.mode = d.mode; T.exBk.br.budget = d.budget;
      T.exBk.br.games_per_tie = d.games_per_tie;
      exStatus("● live — seeded, playing…");
    });
    es.addEventListener("tie_start", e => {
      const d = JSON.parse(e.data);
      exStatus("● " + d.round + ": " + d.a + " vs " + d.b + " …");
    });
    es.addEventListener("tie_result", e => {
      const d = JSON.parse(e.data);
      exRound(d.round).ties.push(d);
      renderExBracket(document.getElementById("ex-bracket"), T.exBk.br);
    });
    es.addEventListener("champion", e => {
      T.exBk.br.champion = JSON.parse(e.data).engine;
      renderExBracket(document.getElementById("ex-bracket"), T.exBk.br);
      exStatus("🏆 champion: " + T.exBk.br.champion);
    });
    es.addEventListener("reset", () => {
      T.exBk.br = { seeds: [], rounds: [], champion: null, mode: "nodes", budget, games_per_tie: games };
      renderExBracket(document.getElementById("ex-bracket"), T.exBk.br);
    });
    es.addEventListener("done", () => {
      T.exBk.running = false;
      if (!T.exBk.br.champion) exStatus("done");
    });
    es.onerror = () => { /* keep-alive gaps; the browser auto-reconnects */ };
  }

  function renderExBracket(root, br) {
    if (!root) return;
    root.innerHTML = "";
    if (!br || (!br.rounds.length && !br.champion)) {
      root.appendChild(el("p", "muted", "Press Run to seed the 8 top engines and stream the bracket round-by-round."));
      return;
    }
    const board = el("div", "bracket");
    br.rounds.forEach(round => {
      const col = el("div", "bracket-round");
      col.appendChild(el("div", "round-name", round.name));
      round.ties.forEach(tie => {
        const card = el("div", "tie");
        card.appendChild(exSide(tie.a, tie.seedA, tie.scoreA, tie.winner === tie.a, tie.bye));
        card.appendChild(exSide(tie.b, tie.seedB, tie.scoreB, tie.winner === tie.b, tie.bye));
        col.appendChild(card);
      });
      board.appendChild(col);
    });
    if (br.champion) {
      const champCol = el("div", "bracket-round champion-col");
      champCol.appendChild(el("div", "round-name", "Champion"));
      const c = el("div", "tie champion-card");
      const trophy = el("div", "trophy"); trophy.innerHTML = CWC.icon("trophy");
      c.appendChild(trophy);
      const side = el("div", "tie-side is-win");
      side.appendChild(teamChip(br.champion));
      c.appendChild(side);
      champCol.appendChild(c);
      board.appendChild(champCol);
    }
    root.appendChild(board);
  }

  function exSide(name, seed, score, isWin, bye) {
    if (name === "BYE" || name == null) {
      const b = el("div", "tie-side is-bye");
      b.innerHTML = '<span class="tc-name">— bye —</span>';
      return b;
    }
    const s = el("div", "tie-side" + (isWin ? " is-win" : ""));
    if (seed != null) s.appendChild(el("span", "seed tnum", String(seed)));
    s.appendChild(teamChip(name));
    if (!bye && score != null) s.appendChild(el("span", "tie-score tnum", String(score)));
    return s;
  }

  /* ================= STANDINGS ================= */

  function renderStandings(host) {
    const data = CWC.state.data;
    host.innerHTML = "";
    if (!data || !data.events || !data.events.length) {
      CWC.ui.emptyState(host, { icon: "chart", msg: "No standings data (tournament.json missing)." });
      return;
    }
    const events = data.events;
    if (T.stdEvent >= events.length) T.stdEvent = 0;

    const picker = seg(
      events.map((ev, i) => ({ id: String(i), label: ev.label })),
      String(T.stdEvent),
      id => { T.stdEvent = +id; T.stdSort = null; renderStandings(host); },
      "Event"
    );
    const pickWrap = el("div", "std-picker");
    pickWrap.appendChild(picker);
    host.appendChild(pickWrap);

    host.appendChild(standingsTable(events[T.stdEvent], events, host));
  }

  // engine name -> rank (by pts desc) for an event
  function rankMap(ev) {
    const rows = ev.engines.map(n => ({ n, pts: (ev.standings[n] || {}).pts || 0 }))
      .sort((a, b) => b.pts - a.pts);
    const m = {};
    rows.forEach((r, i) => { m[r.n] = i + 1; });
    return m;
  }

  function standingsTable(ev, events, host) {
    const wrap = el("div", "card std-card");
    const sub = el("div", "std-sub muted");
    sub.textContent = ev.games.length + " games · " + ev.mode + " budget " + ev.budget;
    wrap.appendChild(sub);

    const fixed = events.find(e => /fixed[- ]?node/i.test(e.label));
    const wall = events.find(e => /wall[- ]?clock/i.test(e.label));
    const showDelta = !!(fixed && wall);
    const otherRanks = showDelta
      ? (ev === fixed ? rankMap(wall) : (ev === wall ? rankMap(fixed) : null))
      : null;

    const rows = ev.engines.map(n => {
      const st = ev.standings[n] || {};
      const stat = ev.stats[n] || {};
      return {
        n, games: st.games || 0, w: st.w || 0, d: st.d || 0, l: st.l || 0,
        pts: st.pts || 0, score: st.games ? (100 * st.pts / st.games) : 0,
        nps: stat.nps_mean || 0, p50: stat.lat_p50, p99: stat.lat_p99, tax: stat.delta_p99,
      };
    });

    const cols = [
      { key: "rank", label: "#", num: true },
      { key: "team", label: "Team", sortKey: "n" },
      { key: "games", label: "GP", num: true },
      { key: "w", label: "W", num: true },
      { key: "d", label: "D", num: true },
      { key: "l", label: "L", num: true },
      { key: "pts", label: "Pts", num: true },
      { key: "score", label: "Score%", num: true },
      { key: "nps", label: "NPS", num: true },
      { key: "lat", label: "Lat p50/p99", num: true },
      { key: "tax", label: "Tax p99", num: true },
    ];
    if (otherRanks) cols.push({ key: "drank", label: "Δ rank", num: true });

    const sort = T.stdSort || { key: "pts", dir: "desc" };
    const cmp = (a, b) => {
      let av, bv;
      if (sort.key === "n") { av = a.n; bv = b.n; }
      else if (sort.key === "lat") { av = a.p99 || 0; bv = b.p99 || 0; }
      else { av = a[sort.key]; bv = b[sort.key]; }
      if (typeof av === "string") return sort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sort.dir === "asc" ? (av - bv) : (bv - av);
    };
    const sorted = rows.slice().sort(cmp);

    const ptsRank = {};
    rows.slice().sort((a, b) => b.pts - a.pts).forEach((r, i) => { ptsRank[r.n] = i + 1; });
    const maxPts = Math.max.apply(null, rows.map(r => r.pts).concat([1]));

    const table = el("table", "table std-table");
    const thead = el("thead");
    const htr = el("tr");
    cols.forEach(c => {
      const th = el("th", c.num ? "num" : null, c.label);
      const sk = c.key === "lat" ? "lat" : (c.sortKey || c.key);
      if (c.key !== "rank" && c.key !== "drank") {
        th.setAttribute("aria-sort",
          sort.key === sk ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
        th.tabIndex = 0;
        const doSort = () => {
          const dir = (sort.key === sk && sort.dir === "desc") ? "asc" : "desc";
          T.stdSort = { key: sk, dir };
          renderStandings(host);
        };
        th.addEventListener("click", doSort);
        th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doSort(); } });
      }
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tb = el("tbody");
    sorted.forEach(r => {
      const tr = el("tr");
      const rk = el("td", "num tnum"); rk.textContent = ptsRank[r.n]; tr.appendChild(rk);
      const team = el("td"); team.appendChild(teamChip(r.n)); tr.appendChild(team);
      [r.games, r.w, r.d, r.l].forEach(v => { const c = el("td", "num tnum"); c.textContent = v; tr.appendChild(c); });
      const pts = el("td", "num tnum"); pts.innerHTML = "<b>" + r.pts + "</b>"; tr.appendChild(pts);
      const scoreTd = el("td", "num std-barcell");
      scoreTd.innerHTML =
        '<span class="std-bar"><span class="std-bar-fill" style="width:' +
        (100 * r.pts / maxPts).toFixed(0) + '%"></span></span>' +
        '<span class="tnum">' + r.score.toFixed(0) + "%</span>";
      tr.appendChild(scoreTd);
      const nps = el("td", "num tnum"); nps.textContent = r.nps ? CWC.fmt.nps(r.nps) : "—"; tr.appendChild(nps);
      const lat = el("td", "num tnum");
      lat.textContent = (r.p50 != null ? r.p50 : "—") + "/" + (r.p99 != null ? r.p99 : "—") + "ms";
      tr.appendChild(lat);
      const tax = el("td", "num tnum"); tax.textContent = (r.tax != null ? r.tax + "ms" : "—"); tr.appendChild(tax);
      if (otherRanks) {
        const dtd = el("td", "num");
        const or = otherRanks[r.n];
        if (or == null) dtd.textContent = "—";
        else {
          const delta = or - ptsRank[r.n]; // positive => better here than in the other event
          const link = el("a", "drank-link tnum", delta === 0 ? "—" : (delta > 0 ? "▲" + delta : "▼" + Math.abs(delta)));
          link.href = "#/analysis";
          link.title = "Rank in the other event: " + or + " → here: " + ptsRank[r.n];
          if (delta > 0) link.classList.add("up"); else if (delta < 0) link.classList.add("down");
          dtd.appendChild(link);
        }
        tr.appendChild(dtd);
      }
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    return wrap;
  }

  /* ================= view shell / routing ================= */

  function go2(sub) { location.hash = "#/tournament/" + sub; }

  function render() {
    const root = T.el;
    if (!root) return;
    CWC.closeTeamPopover();
    root.innerHTML = "";
    ensureDelegation(root);

    const bar = el("div", "t-topbar");
    bar.appendChild(seg(
      [{ id: "groups", label: "Groups" }, { id: "bracket", label: "Bracket" },
       { id: "standings", label: "Standings" }],
      T.sub, go2, "Tournament section"
    ));
    root.appendChild(bar);

    const body = el("div", "t-body");
    root.appendChild(body);

    if (T.sub === "groups") renderGroups(body);
    else if (T.sub === "bracket") renderBracket(body);
    else renderStandings(body);

    T._flashMatch = null; // consume one-shot flag
  }

  CWC.registerView("tournament", {
    init() { T.el = this._el; },
    show(params) {
      let sub = params && params[0];
      if (SUBS.indexOf(sub) < 0) sub = "groups";
      T.sub = sub;
      render();
    },
    hide() {
      CWC.closeTeamPopover();
      if (T._ro) { try { T._ro.disconnect(); } catch (e) {} T._ro = null; }
    },
  });
})();
