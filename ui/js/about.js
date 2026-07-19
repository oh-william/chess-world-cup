"use strict";
/* about.js — the "Engines" page: how each country's bot actually thinks.
   Renders rich profiles (language, algorithm, techniques, strength, flair) from
   /api/engines (live) or the baked `engine_info` block (static). */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const el = CWC.el, esc = CWC.esc;

  CWC.registerView("about", {
    init() {},
    show() { render(this._el); },
    hide() {},
  });

  const FAMILY_NOTE = [
    ["Alpha-Beta", "Minimax search that <em>prunes</em>: once a branch is proven worse than " +
      "one already found, it stops looking. The workhorse of classical chess engines — same " +
      "move as full minimax, a fraction of the nodes."],
    ["Minimax (naïve)", "The same idea <em>without</em> pruning — it visits every branch. Kept " +
      "here on purpose to show what pruning buys you."],
    ["Monte-Carlo Tree Search", "A different paradigm entirely: don't search exhaustively, " +
      "<em>sample</em>. Grow a tree by repeatedly playing promising lines (UCT) and averaging " +
      "the outcomes. (This is the family AlphaGo made famous.)"],
    ["Greedy / Random", "The baselines. Greedy takes the best move one ply deep; random just " +
      "plays legally. They anchor the Elo scale."],
  ];

  function strengthDots(n) {
    const wrap = el("span", "eng-strength");
    for (let i = 0; i < 5; i++) wrap.appendChild(el("i", i < n ? "on" : ""));
    return wrap;
  }

  function engineCard(e) {
    const card = el("div", "eng-card" + (e.role === "analysis" ? " eng-card--oracle" : ""));
    const key = CWC.langKey(e.lang);
    const teams = (e.teams || []).slice(0, 8)
      .map(t => CWC.flag(t.code) + " " + esc(t.name)).join(" · ");
    const techs = (e.techniques || [])
      .map(t => '<span class="eng-tech">' + esc(t) + "</span>").join("");
    card.innerHTML =
      '<div class="eng-head">' +
        '<div class="eng-title"><span class="eng-nick">' + esc(e.nick || "") + "</span>" +
          '<span class="eng-name mono">' + esc(e.name) + "</span></div>" +
        '<span class="chip chip--lang" data-lang="' + esc(key) + '">' + esc(e.lang) + "</span>" +
      "</div>" +
      '<div class="eng-algo"><b>' + esc(e.algorithm || "") + "</b>" +
        (e.reuse ? ' <span class="muted">· ' + esc(e.reuse) + "</span>" : "") + "</div>" +
      '<p class="eng-blurb">' + esc(e.blurb || "") + "</p>" +
      '<div class="eng-techs">' + techs + "</div>";
    const foot = el("div", "eng-foot");
    foot.appendChild(el("span", "muted", e.role === "analysis" ? "reference analyst" : "strength"));
    foot.appendChild(strengthDots(e.strength || 0));
    card.appendChild(foot);
    if (teams) {
      const trow = el("div", "eng-teams muted");
      trow.innerHTML = (e.role === "analysis" ? "" : "backs " + e.team_count + " teams: ") + teams
        + (e.team_count > 8 ? " …" : "");
      if (e.role !== "analysis") card.appendChild(trow);
    }
    return card;
  }

  async function render(host) {
    host.innerHTML = "";
    const intro = el("div", "about-intro");
    intro.innerHTML =
      "<h1>How the nations think</h1>" +
      "<p>Every team plays the same game on the same board — the only thing that differs is the " +
      "<b>engine</b> behind it, and each engine is a different program in a different language. " +
      "This is the whole point of the tournament: hold the chess constant, vary the code, and " +
      "measure what the <span class=\"accent\">implementation</span> costs.</p>";
    const fam = el("div", "about-families");
    FAMILY_NOTE.forEach(([name, desc]) => {
      const f = el("div", "fam-note");
      f.innerHTML = "<h3>" + esc(name) + "</h3><p>" + desc + "</p>";
      fam.appendChild(f);
    });
    intro.appendChild(fam);
    host.appendChild(intro);

    let engines = (CWC.state.data && CWC.state.data.engine_info) || null;
    if (CWC.state.live) {
      try { engines = (await CWC.api.get("/api/engines")).engines; } catch (e) { /* keep baked */ }
    }
    if (!engines || !engines.length) {
      CWC.ui.emptyState(el("div", null), {});
      const em = el("div"); CWC.ui.emptyState(em, { icon: "warning",
        msg: "Engine profiles unavailable. Rebuild the site data or run the live server." });
      host.appendChild(em);
      return;
    }
    engines = engines.slice().sort((a, b) => (b.strength || 0) - (a.strength || 0));
    const grid = el("div", "eng-grid");
    engines.forEach(e => grid.appendChild(engineCard(e)));
    host.appendChild(grid);
  }
})();
