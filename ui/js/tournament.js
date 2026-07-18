"use strict";
/* tournament.js — Workstream 2. Merges World Cup Groups + Bracket + Standings
   into ONE view with a segmented control. Renders into #view-tournament (_el).
   Vanilla JS, no build step, tokenized styles only. */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const el = CWC.el, esc = CWC.esc;

  const SUBS = ["groups", "bracket", "standings"];
  const HERO_KEY = "cwc_hero_seen";

  // shared module state
  const T = {
    el: null,
    sub: "groups",
    wc: null,          // world-cup public_state
    busy: false,
    autofill: null,    // {abort,done,count} when a Play-all is running
    stdEvent: 0,       // standings event index
    stdSort: null,     // {key, dir}
    exBk: { es: null, br: null, running: false }, // exhibition knockout SSE state
  };

  /* ---------- small shared UI helpers ---------- */

  // A team chip: flag + lang chip + country/engine. `t` is a WC team object
  // {country,lang,engine,name} OR an engine name string (falls back to engines map).
  function teamChip(t) {
    let country, lang, label;
    if (typeof t === "string") {
      const e = CWC.engineOf(t);
      country = e.country; lang = e.lang; label = t;
    } else {
      country = t.country; lang = t.lang; label = t.country + " · " + t.engine;
    }
    const key = CWC.langKey(lang);
    const chip = el("span", "team-chip");
    chip.innerHTML =
      '<span class="tc-flag" aria-hidden="true">' + esc(CWC.flag(country)) + "</span>" +
      '<span class="chip chip--lang tc-lang" data-lang="' + esc(key) + '">' + esc(lang) + "</span>" +
      '<span class="tc-name">' + esc(label) + "</span>";
    return chip;
  }

  // odds tri-band using the shared .odds component. `odds` is [W,D,L] in 0..1.
  function oddsBar(odds) {
    const [w, d, l] = odds.map(x => Math.round(x * 100));
    const bar = el("span", "odds");
    bar.title = "W " + w + "% · D " + d + "% · L " + l + "%";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", "Odds: win " + w + "%, draw " + d + "%, loss " + l + "%");
    bar.innerHTML =
      '<i class="odds-w" style="width:' + w + '%"></i>' +
      '<i class="odds-d" style="width:' + d + '%"></i>' +
      '<i class="odds-l" style="width:' + l + '%"></i>';
    return bar;
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

  /* ================= data plumbing ================= */

  async function loadWc() {
    T.wc = await CWC.api.get("/api/tournament");
    CWC.state.wc = T.wc;
    return T.wc;
  }
  function wcTeam(tid) { return T.wc.teams[tid]; }

  async function wcAction(path, body) {
    const res = await CWC.api.post(path, body || {});
    if (res.state) {
      T.wc = res.state;
      CWC.state.wc = res.state;
      CWC.bus.emit("wc:updated", res.state); // let betting settle
    }
    return res;
  }

  async function wcPlay(mid) {
    if (T.busy) return;
    T.busy = true;
    try { await wcAction("/api/tournament/play", { match_id: mid }); }
    finally { T.busy = false; }
    render();
  }
  async function wcAdvance() {
    await wcAction("/api/tournament/advance", {});
    render();
  }
  async function wcReset() {
    await wcAction("/api/tournament/reset", {});
    render();
  }

  /* ================= GROUPS ================= */

  function renderGroups(host) {
    if (!CWC.state.live) { needsLiveEmpty(host); return; }
    if (!T.wc) { CWC.ui.skeleton(host, "table"); loadWc().then(render).catch(() => {}); return; }
    const s = T.wc;
    host.innerHTML = "";

    // hero band (dismissible)
    if (localStorage.getItem(HERO_KEY) !== "1") host.appendChild(heroBand());

    // stage bar
    host.appendChild(stageBar(s));

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

    // legend (once, above the grid)
    const legend = el("div", "wc-legend");
    legend.innerHTML =
      '<span class="lg lg-q">Q</span> top 2 qualify' +
      '<span class="lg lg-3">3rd?</span> best-third playoff' +
      '<span class="lg-sub">±⚔ = piece capture differential</span>';
    host.appendChild(legend);

    // group grid
    const grid = el("div", "wc-groups");
    s.groups.forEach(g => grid.appendChild(groupCard(g)));
    host.appendChild(grid);
  }

  function heroBand() {
    const band = el("div", "wc-hero card");
    band.innerHTML =
      '<div class="wc-hero-body">' +
      '<p>48 teams. 8 engines. 4 languages.</p>' +
      '<p>Same chess knowledge — different languages. This measures the language tax.</p>' +
      '<p><a href="#/analysis">See the analysis →</a></p>' +
      "</div>";
    const x = el("button", "btn btn--ghost btn--sm wc-hero-x", "");
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.innerHTML = CWC.icon("close");
    x.addEventListener("click", () => {
      localStorage.setItem(HERO_KEY, "1");
      band.remove();
    });
    band.appendChild(x);
    return band;
  }

  function stageBar(s) {
    const bar = el("div", "wc-stage card");
    const played = s.fixtures.filter(f => f.played).length;
    const total = s.fixtures.length;
    const pct = total ? (100 * played / total) : 0;

    const head = el("div", "wc-stage-head");
    head.innerHTML =
      '<div class="wc-stage-label">Group Stage — <span class="mono">' +
      played + "/" + total + "</span> played</div>";
    bar.appendChild(head);

    const track = el("div", "wc-progress");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(total));
    track.setAttribute("aria-valuenow", String(played));
    const fill = el("div", "wc-progress-fill");
    fill.style.width = pct + "%";
    track.appendChild(fill);
    bar.appendChild(track);

    const actions = el("div", "wc-stage-actions");

    if (s.stage === "group" && !s.group_done) {
      if (T.autofill) {
        const prog = el("span", "chip wc-af-progress");
        prog.innerHTML = '<span class="live-dot"></span> <span class="mono">' +
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

  function groupCard(g) {
    const card = el("div", "group-card card");
    card.appendChild(el("div", "group-name", "Group " + String.fromCharCode(65 + g.index)));

    const tbl = el("table", "table group-table");
    tbl.innerHTML =
      "<thead><tr><th class='num'>#</th><th>Team</th><th class='num'>Pl</th>" +
      "<th class='num'>Pts</th><th class='num'>±⚔</th></tr></thead>";
    const tb = el("tbody");
    g.table.forEach((r, i) => {
      const tr = el("tr", i < 2 ? "is-qual" : (i === 2 ? "is-third" : ""));
      const posTd = el("td", "num pos-cell");
      const posNum = el("span", "pos-num", String(i + 1));
      posTd.appendChild(posNum);
      if (i < 2) posTd.appendChild(el("span", "q-badge", "Q"));
      else if (i === 2) posTd.appendChild(el("span", "q-badge q-3", "3rd?"));
      tr.appendChild(posTd);
      const teamTd = el("td");
      teamTd.appendChild(teamChip(wcTeam(r.team)));
      tr.appendChild(teamTd);
      const pl = el("td", "num"); pl.textContent = r.P; tr.appendChild(pl);
      const pts = el("td", "num"); pts.innerHTML = "<b>" + r.pts + "</b>"; tr.appendChild(pts);
      const d = r.cf - r.ca;
      const diff = el("td", "num"); diff.textContent = (d > 0 ? "+" : "") + d; tr.appendChild(diff);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);

    const fx = el("div", "group-fixtures");
    T.wc.fixtures.filter(f => f.group === g.index).forEach(m => fx.appendChild(fixtureRow(m)));
    card.appendChild(fx);
    return card;
  }

  // Two-row wrap-safe fixture layout.
  function fixtureRow(m) {
    const row = el("div", "fixture");
    if (m.played) {
      row.classList.add("is-played");
      const r1 = el("div", "fx-row fx-result");
      const res = m.result === "1/2-1/2" ? "½–½" : m.result;
      const wtxt = m.winner == null ? "draw" : (wcTeam(m.winner).country + " win");
      r1.appendChild(teamChip(wcTeam(m.a)));
      r1.appendChild(el("span", "fx-score mono", res));
      r1.appendChild(teamChip(wcTeam(m.b)));
      row.appendChild(r1);
      const r2 = el("div", "fx-row fx-actions");
      const meta = el("span", "fx-meta");
      meta.innerHTML = esc(wtxt) + (m.tiebreak ? " (" + esc(m.tiebreak) + ")" : "") +
        ' · <span class="mono">' + m.plies + "p</span> · ⚔<span class='mono'>" +
        m.capA + "-" + m.capB + "</span>";
      r2.appendChild(meta);
      if (m.hasGame) {
        const watch = el("button", "btn btn--sm", "▶ watch");
        watch.type = "button";
        watch.addEventListener("click", () => {
          location.hash = "#/watch/replay/wc=" + encodeURIComponent(m.id);
        });
        r2.appendChild(watch);
      }
      row.appendChild(r2);
    } else {
      const r1 = el("div", "fx-row fx-odds");
      r1.appendChild(teamChip(wcTeam(m.a)));
      r1.appendChild(oddsBar(CWC.betting.oddsFor(m)));
      r1.appendChild(teamChip(wcTeam(m.b)));
      row.appendChild(r1);

      const r2 = el("div", "fx-row fx-actions");
      const betGroup = el("div", "bet-split");
      const labels = { W: wcTeam(m.a).country, D: "Draw", L: wcTeam(m.b).country };
      ["W", "D", "L"].forEach(out => {
        const b = el("button", "btn btn--sm bet-" + out.toLowerCase(), labels[out]);
        b.type = "button";
        b.title = "Bet " + labels[out];
        b.addEventListener("click", () => CWC.betting.openSlip(m, out));
        betGroup.appendChild(b);
      });
      r2.appendChild(betGroup);
      const play = el("button", "btn btn--sm btn--primary fx-play", "▶ Play");
      play.type = "button";
      play.disabled = !!T.autofill;
      play.addEventListener("click", () => wcPlay(m.id));
      r2.appendChild(play);
      row.appendChild(r2);
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
    if (!s.knockout || !s.knockout.length) {
      wcWrap.appendChild(el("p", "muted",
        s.stage === "group"
          ? "Knockout begins once the group stage completes. Play the groups, then Advance."
          : "No knockout ties yet."));
    } else {
      wcWrap.appendChild(bracketBoard(s));
    }
    host.appendChild(wcWrap);

    // Exhibition knockout (8 engines) live panel
    host.appendChild(exhibitionPanel());
  }

  function bracketBoard(s) {
    const board = el("div", "bracket");
    (s.knockout || []).forEach(round => {
      const col = el("div", "bracket-round");
      col.appendChild(el("div", "round-name", round.name));
      round.ties.forEach(t => col.appendChild(koTie(t)));
      board.appendChild(col);
    });
    if (s.champion != null) {
      const champCol = el("div", "bracket-round champion-col");
      champCol.appendChild(el("div", "round-name", "Champion"));
      const c = el("div", "tie champion-card");
      const trophy = el("div", "trophy"); trophy.innerHTML = CWC.icon("trophy");
      c.appendChild(trophy);
      const side = el("div", "tie-side is-win");
      side.appendChild(teamChip(wcTeam(s.champion)));
      c.appendChild(side);
      champCol.appendChild(c);
      board.appendChild(champCol);
    }
    return board;
  }

  function koTie(t) {
    const card = el("div", "tie");
    card.appendChild(koSide(t.a, t.seedA, t.played && t.winner === t.a));
    card.appendChild(koSide(t.b, t.seedB, t.played && t.winner === t.b));
    const foot = el("div", "tie-foot");
    if (t.played) {
      const res = t.result === "1/2-1/2" ? "½–½" : t.result;
      foot.innerHTML = '<span class="mono">' + esc(res) + "</span>" +
        (t.tiebreak ? " · " + esc(t.tiebreak) : "") +
        ' · <span class="mono">' + t.plies + "p</span>";
      if (t.hasGame) {
        const w = el("button", "btn btn--sm", "▶ watch");
        w.type = "button";
        w.addEventListener("click", () => {
          location.hash = "#/watch/replay/wc=" + encodeURIComponent(t.id);
        });
        foot.appendChild(w);
      }
    } else {
      foot.appendChild(oddsBar(CWC.betting.oddsFor(t)));
      const bet = el("button", "btn btn--sm", "Bet");
      bet.type = "button";
      bet.addEventListener("click", () => CWC.betting.openSlip(t, "W"));
      foot.appendChild(bet);
      const play = el("button", "btn btn--sm btn--primary", "▶ Play");
      play.type = "button";
      play.disabled = T.busy;
      play.addEventListener("click", () => wcPlay(t.id));
      foot.appendChild(play);
    }
    card.appendChild(foot);
    return card;
  }

  function koSide(tid, seed, isWin) {
    const s = el("div", "tie-side" + (isWin ? " is-win" : ""));
    if (seed != null) s.appendChild(el("span", "seed mono", String(seed)));
    s.appendChild(teamChip(wcTeam(tid)));
    return s;
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
      '<label class="ex-field">budget <input class="ex-inp mono" id="ex-budget" type="number" ' +
      'value="12000" min="1" step="1000"></label>' +
      '<label class="ex-field">games/tie <input class="ex-inp mono" id="ex-games" type="number" ' +
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
    if (seed != null) s.appendChild(el("span", "seed mono", String(seed)));
    s.appendChild(teamChip(name));
    if (!bye && score != null) s.appendChild(el("span", "tie-score mono", String(score)));
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

    // competition rank always follows pts order, independent of display sort
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
      const rk = el("td", "num"); rk.textContent = ptsRank[r.n]; tr.appendChild(rk);
      const team = el("td"); team.appendChild(teamChip(r.n)); tr.appendChild(team);
      [r.games, r.w, r.d, r.l].forEach(v => { const c = el("td", "num"); c.textContent = v; tr.appendChild(c); });
      const pts = el("td", "num"); pts.innerHTML = "<b>" + r.pts + "</b>"; tr.appendChild(pts);
      const scoreTd = el("td", "num std-barcell");
      scoreTd.innerHTML =
        '<span class="std-bar"><span class="std-bar-fill" style="width:' +
        (100 * r.pts / maxPts).toFixed(0) + '%"></span></span>' +
        '<span class="mono">' + r.score.toFixed(0) + "%</span>";
      tr.appendChild(scoreTd);
      const nps = el("td", "num"); nps.textContent = r.nps ? CWC.fmt.nps(r.nps) : "—"; tr.appendChild(nps);
      const lat = el("td", "num");
      lat.textContent = (r.p50 != null ? r.p50 : "—") + "/" + (r.p99 != null ? r.p99 : "—") + "ms";
      tr.appendChild(lat);
      const tax = el("td", "num"); tax.textContent = (r.tax != null ? r.tax + "ms" : "—"); tr.appendChild(tax);
      if (otherRanks) {
        const dtd = el("td", "num");
        const or = otherRanks[r.n];
        if (or == null) dtd.textContent = "—";
        else {
          const delta = or - ptsRank[r.n]; // positive => better here than in the other event
          const link = el("a", "drank-link", delta === 0 ? "—" : (delta > 0 ? "▲" + delta : "▼" + Math.abs(delta)));
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
    root.innerHTML = "";

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
  }

  CWC.registerView("tournament", {
    init() { T.el = this._el; },
    show(params) {
      let sub = params && params[0];
      if (SUBS.indexOf(sub) < 0) sub = "groups";
      T.sub = sub;
      render();
    },
    hide() {},
  });
})();
