"use strict";
/* betting.js — WS3 unified betting: ONE model, ONE wallet.
   Fixture book (3-outcome fixed odds) + Event contracts (YES/NO LMSR seeded to
   the model) + Title odds + ledger. All probabilities flow from the single
   WorldCup.odds() model, surfaced via CWC.betting.oddsFor / the server.

   Public surface (FROZEN — do not change signatures):
     CWC.betting = { oddsFor, openSlip, settleFixtures, wallet, ledger,
                     renderHeaderChip }
*/
(function () {
  const CWC = (window.CWC = window.CWC || {});

  const START_BALANCE = 1000;
  const WKEY = "cwc_wallet_v3";
  const LIQ = 40;   // LMSR liquidity
  const LOT = 10;   // shares per YES/NO click
  const STAKES = [5, 25, 100];

  /* ---------------- wallet persistence ---------------- */
  function freshWallet() {
    return { balance: START_BALANCE, ledger: [], lmsr: { q: {}, hist: {} } };
  }
  function loadWallet() {
    let w;
    try { w = JSON.parse(localStorage.getItem(WKEY)); } catch (e) { w = null; }
    if (!w || typeof w.balance !== "number" || !Array.isArray(w.ledger)) w = freshWallet();
    if (!w.lmsr) w.lmsr = { q: {}, hist: {} };
    if (!w.lmsr.q) w.lmsr.q = {};
    if (!w.lmsr.hist) w.lmsr.hist = {};
    return w;
  }
  let W = loadWallet();
  function saveWallet() {
    try { localStorage.setItem(WKEY, JSON.stringify(W)); } catch (e) { /* quota */ }
    CWC.betting.renderHeaderChip();
    CWC.bus.emit("wallet:updated", null);
  }
  function nextId() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------------- odds model helpers ---------------- */
  // Return [W,D,L] for a match. Prefer baked match.odds; else uniform fallback.
  // (The server /api/odds path is the same model; oddsFor reads what the
  // tournament state already carries so bars/slips/contracts share one number.)
  function oddsFor(match) {
    if (match && Array.isArray(match.odds) && match.odds.length === 3) {
      const s = match.odds.map(Number);
      const tot = s[0] + s[1] + s[2] || 1;
      return [s[0] / tot, s[1] / tot, s[2] / tot];
    }
    return [1 / 3, 1 / 3, 1 / 3];
  }
  const OUTCOME_IDX = { W: 0, D: 1, L: 2 };
  function decimalOdds(p) { return p > 1e-9 ? 1 / p : 999; }

  /* ---------------- LMSR (client-local price discovery) ---------------- */
  function lmsrPrice(q) {
    // price of YES = e^{qy/LIQ} / (e^{qy/LIQ}+e^{qn/LIQ})
    const ey = Math.exp(q.yes / LIQ), en = Math.exp(q.no / LIQ);
    return ey / (ey + en);
  }
  function lmsrCost(q) {
    return LIQ * Math.log(Math.exp(q.yes / LIQ) + Math.exp(q.no / LIQ));
  }
  function seedLmsr(cid, p0) {
    if (W.lmsr.q[cid]) return W.lmsr.q[cid];
    const p = Math.min(0.995, Math.max(0.005, Number(p0) || 0.5));
    const q = { yes: LIQ * Math.log(p / (1 - p)), no: 0 };
    W.lmsr.q[cid] = q;
    W.lmsr.hist[cid] = [lmsrPrice(q)];
    return q;
  }

  /* ---------------- state ---------------- */
  let TOURN = null;           // last known live tournament state
  let CONTRACTS = [];         // last /api/contracts payload
  let SIM = null;             // last /api/tournament/simulate payload
  let contractsTimer = null;
  const teamName = tid => {
    const t = TOURN && TOURN.teams && TOURN.teams[tid];
    return t ? t.country : ("#" + tid);
  };
  const teamEngine = tid => {
    const t = TOURN && TOURN.teams && TOURN.teams[tid];
    return t ? t.engine : "?";
  };
  const teamLang = tid => {
    const e = teamEngine(tid);
    const em = CWC.state.data && CWC.state.data.engines && CWC.state.data.engines[e];
    return em ? em.lang : (e || "?");
  };

  /* ---------------- fixture settlement ---------------- */
  // Resolve every OPEN fixture bet whose match is now played.
  function settleFixtures(state) {
    if (!state) return;
    const byId = {};
    (state.fixtures || []).forEach(m => { byId[m.id] = m; });
    (state.knockout || []).forEach(r => (r.ties || []).forEach(t => { byId[t.id] = t; }));
    let changed = false;
    W.ledger.forEach(e => {
      if (e.kind !== "fixture" || e.status !== "open") return;
      const m = byId[e.ref];
      if (!m || !m.played) return;
      // determine actual outcome from a's perspective
      let actual;
      if (m.winner == null) actual = "D";
      else if (m.winner === m.a) actual = "W";
      else actual = "L";
      if (e.outcome === actual) {
        e.status = "won";
        e.payout = round2(e.stake * e.decimal);
        W.balance += e.payout;
      } else {
        e.status = "lost";
        e.payout = 0;
      }
      changed = true;
    });
    if (changed) { saveWallet(); renderIfActive(); }
  }

  /* ---------------- contract settlement (from poll) ---------------- */
  function settleContracts(list) {
    let changed = false;
    const byId = {};
    (list || []).forEach(c => { byId[c.id] = c; });
    W.ledger.forEach(e => {
      if (e.kind !== "contract" || e.status !== "open") return;
      const c = byId[e.ref];
      if (!c || c.status !== "resolved" || !c.outcome) return;
      const won = e.side === c.outcome;
      e.status = won ? "won" : "lost";
      e.payout = won ? round2(e.shares) : 0; // each winning share pays $1
      if (won) W.balance += e.payout;
      changed = true;
      CWC.ui.toast((won ? "Won " : "Lost ") + "“" + c.label + "” → " +
        c.outcome + (won ? " (+" + CWC.fmt.money(e.payout) + ")" : ""),
        won ? "ok" : "err");
    });
    if (changed) saveWallet();
  }

  function round2(n) { return Math.round(Number(n) * 100) / 100; }
  function money2(n) {
    const v = Number(n) || 0;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  }

  /* ---------------- mark-to-model P/L ---------------- */
  function markToModel() {
    // balance + open-position mark − START. Fixture open bets marked at model p;
    // contract open positions marked at current LMSR price.
    let mark = 0;
    W.ledger.forEach(e => {
      if (e.status !== "open") return;
      if (e.kind === "fixture") {
        mark += e.stake * e.decimal * e.p; // EV of the open bet
      } else if (e.kind === "contract") {
        const q = W.lmsr.q[e.ref];
        const price = q ? (e.side === "YES" ? lmsrPrice(q) : 1 - lmsrPrice(q)) : e.p;
        mark += e.shares * price;
      }
    });
    return W.balance + mark - START_BALANCE;
  }

  /* ---------------- header chip ---------------- */
  function renderHeaderChip() {
    const host = document.getElementById("wallet-chip");
    if (!host) return;
    host.innerHTML = "";
    const pnl = markToModel();
    const chip = CWC.el("span", "chip");
    const cls = pnl > 0.005 ? "pnl-up" : (pnl < -0.005 ? "pnl-down" : "pnl-flat");
    chip.innerHTML = CWC.icon("coin") +
      " <b class=\"wc-bal\">" + CWC.esc(money2(W.balance)) + "</b>" +
      " <span class=\"wc-pnl " + cls + "\">(" + (pnl >= 0 ? "+" : "") +
      CWC.esc(money2(pnl)) + ")</span>";
    chip.title = "Wallet (play money) · P/L marked to the model";
    host.appendChild(chip);
  }

  /* ---------------- bet slip (fixture) ---------------- */
  let SLIP = null;
  function openSlip(match, outcome) {
    if (!CWC.state.live) { CWC.ui.toast("Betting is live-only. Run the live server.", "err"); return; }
    outcome = OUTCOME_IDX[outcome] != null ? outcome : "W";
    const odds = oddsFor(match);
    const p = odds[OUTCOME_IDX[outcome]];
    closeSlip();
    const dlg = document.createElement("dialog");
    dlg.className = "bet-slip";
    SLIP = { dlg, match, outcome, p, stake: STAKES[1] };

    const head = CWC.el("div", "slip-head");
    head.innerHTML = "<strong>Bet slip</strong>";
    const x = CWC.el("button", "icon-btn"); x.type = "button";
    x.innerHTML = CWC.icon("close"); x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeSlip);
    head.appendChild(x);
    dlg.appendChild(head);

    const lbl = outcome === "W" ? (teamName(match.a) + " to win")
      : outcome === "L" ? (teamName(match.b) + " to win") : "Draw";
    const sub = CWC.el("div", "slip-sub");
    sub.innerHTML = "<span>" + CWC.esc(teamName(match.a)) + " vs " +
      CWC.esc(teamName(match.b)) + "</span><span class=\"slip-pick\">" +
      CWC.esc(lbl) + "</span>";
    dlg.appendChild(sub);

    const meta = CWC.el("div", "slip-meta");
    meta.innerHTML = "Model prob <b>" + (p * 100).toFixed(1) + "%</b> · decimal <b>" +
      decimalOdds(p).toFixed(2) + "</b> (no vig)";
    dlg.appendChild(meta);

    // stake chips
    const chips = CWC.el("div", "stake-chips");
    STAKES.forEach(s => {
      const b = CWC.el("button", "stake-chip", "$" + s); b.type = "button";
      b.addEventListener("click", () => { SLIP.stake = s; syncSlip(); });
      chips.appendChild(b);
    });
    const custom = CWC.el("input", "stake-custom");
    custom.type = "number"; custom.min = "1"; custom.placeholder = "custom";
    custom.addEventListener("input", () => {
      const v = Number(custom.value); if (v > 0) { SLIP.stake = v; syncSlip(true); }
    });
    chips.appendChild(custom);
    dlg.appendChild(chips);

    const ret = CWC.el("div", "slip-return");
    dlg.appendChild(ret);
    SLIP.retEl = ret; SLIP.chipsEl = chips;

    const place = CWC.el("button", "btn btn--primary slip-place");
    place.type = "button";
    place.addEventListener("click", placeSlip);
    SLIP.placeEl = place;
    dlg.appendChild(place);

    document.body.appendChild(dlg);
    dlg.addEventListener("cancel", closeSlip);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    syncSlip();
  }
  function syncSlip() {
    if (!SLIP) return;
    const retn = SLIP.stake * decimalOdds(SLIP.p);
    SLIP.retEl.innerHTML = "Stake <b>" + money2(SLIP.stake) + "</b> → returns <b>" +
      money2(retn) + "</b>";
    SLIP.chipsEl.querySelectorAll(".stake-chip").forEach(c => {
      c.classList.toggle("is-on", c.textContent === "$" + SLIP.stake);
    });
    const afford = SLIP.stake <= W.balance && SLIP.stake > 0;
    SLIP.placeEl.disabled = !afford;
    SLIP.placeEl.textContent = afford ? ("Place " + money2(SLIP.stake))
      : "Insufficient balance";
  }
  function placeSlip() {
    if (!SLIP || SLIP.stake <= 0 || SLIP.stake > W.balance) return;
    const m = SLIP.match;
    W.balance -= SLIP.stake;
    W.ledger.unshift({
      id: nextId(), ts: Date.now(), kind: "fixture", ref: m.id,
      outcome: SLIP.outcome, stake: round2(SLIP.stake), p: SLIP.p,
      decimal: decimalOdds(SLIP.p), status: "open", payout: 0,
      label: teamName(m.a) + " v " + teamName(m.b)
    });
    saveWallet();
    CWC.ui.toast("Bet placed: " + money2(SLIP.stake) + " on " + SLIP.outcome, "ok");
    closeSlip();
    renderIfActive();
  }
  function closeSlip() {
    if (SLIP && SLIP.dlg) { try { SLIP.dlg.close(); } catch (e) {} SLIP.dlg.remove(); }
    SLIP = null;
  }

  /* ---------------- contract trading (client-local) ---------------- */
  function tradeContract(c, side) {
    if (!CWC.state.live) { CWC.ui.toast("Trading is live-only.", "err"); return; }
    if (c.status === "resolved") { CWC.ui.toast("Contract resolved.", "err"); return; }
    const q = seedLmsr(c.id, c.p0);
    const before = lmsrCost(q);
    const nq = { yes: q.yes + (side === "YES" ? LOT : 0), no: q.no + (side === "NO" ? LOT : 0) };
    const cost = round2(lmsrCost(nq) - before); // $ to buy LOT shares
    if (cost > W.balance) { CWC.ui.toast("Insufficient balance for this lot.", "err"); return; }
    W.lmsr.q[c.id] = nq;
    (W.lmsr.hist[c.id] || (W.lmsr.hist[c.id] = [])).push(lmsrPrice(nq));
    W.balance -= cost;
    const price = round2(cost / LOT);
    W.ledger.unshift({
      id: nextId(), ts: Date.now(), kind: "contract", ref: c.id,
      side: side, stake: cost, shares: LOT, p: side === "YES" ? lmsrPrice(nq) : 1 - lmsrPrice(nq),
      status: "open", payout: 0, label: c.label
    });
    saveWallet();
    CWC.ui.toast("Bought " + LOT + " " + side + " @ " + Math.round(price * 100) + "¢", "ok");
    renderIfActive();
  }

  /* =================================================================
     VIEW
     ================================================================= */
  let ROOT = null, filter = "all";

  function renderIfActive() {
    if (ROOT && ROOT.classList.contains("is-active")) render();
  }

  function collectFixtures() {
    if (!TOURN) return [];
    const out = [];
    (TOURN.fixtures || []).forEach(m => { if (!m.played) out.push(m); });
    (TOURN.knockout || []).forEach(r => (r.ties || []).forEach(t => {
      if (!t.played) out.push(Object.assign({ round: r.name }, t));
    }));
    return out;
  }

  function render() {
    if (!ROOT) return;
    ROOT.innerHTML = "";
    if (!CWC.state.live) return renderReview();

    const grid = CWC.el("div", "bet-grid");
    grid.appendChild(fixturePanel());
    grid.appendChild(contractPanel());
    grid.appendChild(titlePanel());
    ROOT.appendChild(grid);
    ROOT.appendChild(ledgerPanel());
  }

  function panel(title, extra) {
    const p = CWC.el("section", "bet-panel");
    const h = CWC.el("div", "bet-panel-head");
    h.appendChild(CWC.el("h3", null, title));
    if (extra) h.appendChild(extra);
    p.appendChild(h);
    return p;
  }

  function langDot(lang) {
    const s = CWC.el("span", "lang-dot");
    s.style.background = CWC.langColor(lang);
    return s;
  }

  /* --- fixture book --- */
  function fixturePanel() {
    const filt = CWC.el("div", "seg");
    [["all", "All"], ["knockout", "Knockout"]].forEach(([k, lab]) => {
      const b = CWC.el("button", "seg-btn" + (filter === k ? " is-on" : ""), lab);
      b.type = "button";
      b.addEventListener("click", () => { filter = k; render(); });
      filt.appendChild(b);
    });
    const p = panel("Fixture book", filt);
    let fx = collectFixtures();
    if (filter === "knockout") fx = fx.filter(m => m.stage === "knockout");
    if (!fx.length) {
      p.appendChild(CWC.el("p", "muted", "No open fixtures. Advance the tournament to price more."));
      return p;
    }
    const list = CWC.el("div", "fx-list");
    fx.slice(0, 40).forEach(m => list.appendChild(fixtureRow(m)));
    p.appendChild(list);
    return p;
  }

  function fixtureRow(m) {
    const odds = oddsFor(m);
    const row = CWC.el("div", "fx-row");
    const info = CWC.el("div", "fx-info");
    const a = CWC.el("span", "fx-team");
    a.appendChild(langDot(teamLang(m.a)));
    a.appendChild(document.createTextNode(CWC.flag(teamName(m.a)) + " " + teamName(m.a)));
    const b = CWC.el("span", "fx-team");
    b.appendChild(langDot(teamLang(m.b)));
    b.appendChild(document.createTextNode(CWC.flag(teamName(m.b)) + " " + teamName(m.b)));
    info.appendChild(a);
    info.appendChild(CWC.el("span", "fx-vs", "v"));
    info.appendChild(b);
    if (m.round) info.appendChild(CWC.el("span", "fx-tag", m.round));
    else info.appendChild(CWC.el("span", "fx-tag", "Group"));
    row.appendChild(info);

    // odds bar
    const bar = CWC.el("div", "odds-bar");
    ["W", "D", "L"].forEach((o, i) => {
      const seg = CWC.el("div", "odds-seg odds-" + o.toLowerCase());
      seg.style.width = (odds[i] * 100).toFixed(1) + "%";
      seg.title = o + " " + (odds[i] * 100).toFixed(1) + "%";
      bar.appendChild(seg);
    });
    row.appendChild(bar);

    const btns = CWC.el("div", "fx-btns");
    [["W", teamName(m.a)], ["D", "Draw"], ["L", teamName(m.b)]].forEach(([o, lab]) => {
      const btn = CWC.el("button", "bet-btn");
      btn.type = "button";
      btn.innerHTML = "<span>" + CWC.esc(lab) + "</span><b>" +
        decimalOdds(odds[OUTCOME_IDX[o]]).toFixed(2) + "</b>";
      btn.addEventListener("click", () => openSlip(m, o));
      btns.appendChild(btn);
    });
    row.appendChild(btns);
    return row;
  }

  /* --- event contracts --- */
  function contractPanel() {
    const p = panel("Event contracts");
    if (!CONTRACTS.length) {
      p.appendChild(CWC.el("p", "muted", "Loading contracts…"));
      return p;
    }
    const wrap = CWC.el("div", "ct-list");
    CONTRACTS.forEach(c => wrap.appendChild(contractCard(c)));
    p.appendChild(wrap);
    return p;
  }

  function contractCard(c) {
    const card = CWC.el("div", "ct-card" + (c.status === "resolved" ? " is-resolved" : ""));
    card.appendChild(CWC.el("div", "ct-label", c.label));
    card.appendChild(CWC.el("div", "ct-desc", c.desc));

    const q = c.status === "resolved" ? null : seedLmsr(c.id, c.p0);
    const price = q ? lmsrPrice(q) : c.p0;
    const openP = (W.lmsr.hist[c.id] && W.lmsr.hist[c.id][0]) != null
      ? W.lmsr.hist[c.id][0] : c.p0;

    const priceRow = CWC.el("div", "ct-price");
    priceRow.innerHTML = "YES <b>" + Math.round(price * 100) + "¢</b>" +
      " <span class=\"muted\">open " + Math.round(openP * 100) + "¢</span>";
    card.appendChild(priceRow);

    // sparkline
    const sparkHost = CWC.el("div", "ct-spark");
    CWC.charts.spark(sparkHost, {
      values: (W.lmsr.hist[c.id] || [c.p0]).slice(-40), w: 160, h: 28,
      color: "--accent"
    });
    card.appendChild(sparkHost);

    if (c.status === "resolved") {
      const r = CWC.el("div", "ct-resolved");
      r.innerHTML = "Resolved <b>" + CWC.esc(c.outcome) + "</b>";
      card.appendChild(r);
    } else {
      const btns = CWC.el("div", "ct-btns");
      const yes = CWC.el("button", "bet-btn ct-yes", "Buy YES");
      yes.type = "button";
      yes.addEventListener("click", () => tradeContract(c, "YES"));
      const no = CWC.el("button", "bet-btn ct-no", "Buy NO");
      no.type = "button";
      no.addEventListener("click", () => tradeContract(c, "NO"));
      btns.appendChild(yes); btns.appendChild(no);
      card.appendChild(btns);
    }
    return card;
  }

  /* --- title odds --- */
  function titlePanel() {
    const p = panel("Title odds");
    if (!SIM || !SIM.teams) {
      p.appendChild(CWC.el("p", "muted", "Simulating…"));
      return p;
    }
    const rows = SIM.teams.filter(t => t.champion_pct > 0).slice(0, 10).map(t => ({
      label: CWC.flag(t.country) + " " + t.country,
      value: t.champion_pct * 100,
      annot: (t.champion_pct * 100).toFixed(1) + "%",
      color: CWC.langColor(langForEngine(t.engine))
    }));
    const host = CWC.el("div", "title-chart");
    if (rows.length) CWC.charts.barH(host, { rows, w: 320, fmt: v => v.toFixed(1) + "%" });
    else host.appendChild(CWC.el("p", "muted", "No projection yet."));
    p.appendChild(host);
    const note = CWC.el("p", "muted", "Monte-Carlo over the model, n=" + SIM.n + ".");
    p.appendChild(note);
    return p;
  }
  function langForEngine(e) {
    const em = CWC.state.data && CWC.state.data.engines && CWC.state.data.engines[e];
    if (em) return em.lang;
    if (/cpp/.test(e)) return "C++";
    if (/^rs/.test(e)) return "Rust";
    if (/^js/.test(e)) return "JavaScript";
    if (/^py/.test(e)) return "Python";
    return "none";
  }

  /* --- ledger --- */
  function ledgerPanel() {
    const reset = CWC.el("button", "btn btn--ghost", "Reset wallet");
    reset.type = "button";
    reset.addEventListener("click", () => {
      if (confirm("Reset wallet to " + money2(START_BALANCE) + "? This clears all bets.")) {
        W = freshWallet(); saveWallet(); render();
        CWC.ui.toast("Wallet reset.", "ok");
      }
    });
    const p = panel("Ledger", reset);
    if (!W.ledger.length) {
      p.appendChild(CWC.el("p", "muted", "No bets yet."));
      return p;
    }
    const tbl = CWC.el("table", "ledger");
    tbl.innerHTML = "<thead><tr><th>Time</th><th>Market</th><th>Side</th>" +
      "<th>Stake</th><th>Price</th><th>Status</th><th>Payout</th></tr></thead>";
    const tb = CWC.el("tbody");
    W.ledger.forEach(e => {
      const tr = CWC.el("tr", "st-" + e.status);
      const side = e.kind === "fixture" ? e.outcome : e.side;
      const price = e.kind === "fixture"
        ? (e.decimal ? e.decimal.toFixed(2) : "-")
        : (Math.round((e.p || 0) * 100) + "¢");
      [
        new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        e.label || e.ref,
        side,
        money2(e.stake),
        price,
        e.status,
        e.status === "open" ? "—" : money2(e.payout)
      ].forEach((v, i) => {
        const td = CWC.el("td", i === 5 ? "st-cell" : null, v);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    const wrap = CWC.el("div", "ledger-wrap");
    wrap.appendChild(tbl);
    p.appendChild(wrap);
    return p;
  }

  /* --- review (static) mode --- */
  function renderReview() {
    const d = CWC.state.data || {};
    if (!d.odds && !d.contracts) {
      CWC.ui.emptyState(ROOT, {
        icon: "coin",
        msg: "Betting runs against the live server. Start it with " +
          "“python3 ui/live_server.py” and open the live app to place bets."
      });
      return;
    }
    const grid = CWC.el("div", "bet-grid");
    const p = panel("Event contracts (review)");
    (d.contracts || []).forEach(c => {
      const card = CWC.el("div", "ct-card is-resolved");
      card.appendChild(CWC.el("div", "ct-label", c.label));
      card.appendChild(CWC.el("div", "ct-desc", c.desc || ""));
      const openP = c.p0 != null ? Math.round(c.p0 * 100) : "?";
      const info = CWC.el("div", "ct-resolved");
      const wouldRet = c.outcome === "YES" && c.p0 ? (25 / c.p0).toFixed(2) : "0.00";
      info.innerHTML = "Open " + openP + "¢ · outcome <b>" +
        CWC.esc(c.outcome || "?") + "</b><br><span class=\"muted\">a $25 YES at open " +
        "would have returned $" + wouldRet + "</span>";
      card.appendChild(info);
      p.appendChild(card);
    });
    grid.appendChild(p);
    ROOT.appendChild(grid);
  }

  /* ---------------- polling / lifecycle ---------------- */
  async function refreshContracts() {
    if (!CWC.state.live) return;
    try {
      const list = await CWC.api.get("/api/contracts");
      CONTRACTS = list || [];
      settleContracts(CONTRACTS);
      renderIfActive();
    } catch (e) { /* toast already shown */ }
  }
  async function refreshSim() {
    if (!CWC.state.live) return;
    try { SIM = await CWC.api.post("/api/tournament/simulate", { n: 2000 }); renderIfActive(); }
    catch (e) { /* ignore */ }
  }
  async function refreshTournament() {
    if (!CWC.state.live) { TOURN = CWC.state.data; return; }
    try { TOURN = await CWC.api.get("/api/tournament"); }
    catch (e) { TOURN = CWC.state.wc || CWC.state.data; }
  }

  // React to a played match / advance: settle fixtures, re-poll contracts+sim.
  CWC.bus.on("wc:updated", async (state) => {
    if (state && state.teams) TOURN = state;
    else await refreshTournament();
    settleFixtures(TOURN);
    await refreshContracts();
    refreshSim();
  });

  CWC.registerView("betting", {
    init() {
      ROOT = document.getElementById("view-betting");
      renderHeaderChip();
    },
    async show() {
      if (!ROOT) ROOT = document.getElementById("view-betting");
      await refreshTournament();
      if (CWC.state.live) settleFixtures(TOURN);
      render();
      // kick async loads
      refreshContracts();
      refreshSim();
      if (contractsTimer) clearInterval(contractsTimer);
      contractsTimer = setInterval(refreshContracts, 15000);
    },
    hide() {
      if (contractsTimer) { clearInterval(contractsTimer); contractsTimer = null; }
      closeSlip();
    }
  });

  /* ---------------- public surface ---------------- */
  CWC.betting = {
    oddsFor,
    openSlip,
    settleFixtures,
    wallet() { return { balance: W.balance, pnl: markToModel(), ledger: W.ledger.slice() }; },
    ledger() { return W.ledger.slice(); },
    renderHeaderChip
  };

  renderHeaderChip();
})();
