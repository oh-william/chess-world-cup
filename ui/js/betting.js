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
  // Cap at 99× so a near-impossible outcome (e.g. a draw between wildly
  // mismatched teams) reads ">99×" instead of "235608.51", and payouts stay sane.
  const DEC_CAP = 99;
  function decimalOdds(p) { return Math.min(DEC_CAP, p > 1e-9 ? 1 / p : DEC_CAP); }
  // Display form: never show a raw "99.00" at the cap — show a greyed ">99×".
  // Returns {text, capped}. Set span class "odds-capped" when capped.
  function decimalDisplay(p) {
    const raw = p > 1e-9 ? 1 / p : Infinity;
    if (raw >= DEC_CAP) return { text: ">99×", capped: true };
    return { text: raw.toFixed(2), capped: false };
  }
  // Build a decimal-odds element (tnum, greyed when capped).
  function decEl(p, extraCls) {
    const d = decimalDisplay(p);
    const s = CWC.el("b", "tnum" + (d.capped ? " odds-capped" : "") + (extraCls ? " " + extraCls : ""), d.text);
    return s;
  }

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
  const LAST_PRICE = {};      // matchId -> [pW,pD,pL] model prices at last render (for ▲▼)
  let PARLAY = [];            // pending parlay legs [{matchId, outcome, p, label}]
  const teamName = tid => {
    const t = TOURN && TOURN.teams && TOURN.teams[tid];
    return t ? (t.name || t.country) : ("#" + tid);
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
  // Actual outcome of a played match from a's perspective: "W"|"D"|"L".
  function matchOutcome(m) {
    if (m.winner == null) return "D";
    return m.winner === m.a ? "W" : "L";
  }

  function settleFixtures(state) {
    if (!state) return;
    const byId = {};
    (state.fixtures || []).forEach(m => { byId[m.id] = m; });
    (state.knockout || []).forEach(r => (r.ties || []).forEach(t => { byId[t.id] = t; }));
    let changed = false;
    const settledIds = [];
    const balanceBefore = W.balance;
    W.ledger.forEach(e => {
      if (e.status !== "open") return;
      if (e.kind === "fixture") {
        const m = byId[e.ref];
        if (!m || !m.played) return;
        if (e.outcome === matchOutcome(m)) {
          e.status = "won"; e.payout = round2(e.stake * e.decimal); W.balance += e.payout;
        } else { e.status = "lost"; e.payout = 0; }
        settledIds.push(e.id); changed = true;
      } else if (e.kind === "parlay") {
        // All-or-nothing: resolve only when EVERY leg's match is played.
        const legs = e.legs || [];
        const ms = legs.map(l => byId[l.ref]);
        if (ms.some(m => !m || !m.played)) return; // wait for all
        const allHit = legs.every((l, i) => l.outcome === matchOutcome(ms[i]));
        if (allHit) {
          e.status = "won"; e.payout = round2(e.stake * e.decimal); W.balance += e.payout;
        } else { e.status = "lost"; e.payout = 0; }
        settledIds.push(e.id); changed = true;
      }
    });
    if (changed) {
      saveWallet();
      renderIfActive();
      // settle animation: flash rows, count the wallet up/down.
      flashSettled(settledIds);
      animateWallet(balanceBefore, W.balance);
    }
  }

  // Flash newly-settled ledger rows green/red after the next render.
  function flashSettled(ids) {
    if (!ids || !ids.length) return;
    requestAnimationFrame(() => {
      ids.forEach(id => {
        const row = document.querySelector('tr[data-lid="' + id + '"]');
        if (!row) return;
        const cls = row.classList.contains("st-won") ? "flash-win"
          : row.classList.contains("st-lost") ? "flash-loss" : null;
        if (cls) CWC.anim.flash(row, cls, 900);
      });
    });
  }
  // Count the header wallet balance up/down on settlement.
  function animateWallet(from, to) {
    const balEl = document.querySelector("#wallet-chip .wc-bal");
    if (balEl) CWC.anim.countUp(balEl, from, to, { fmt: v => money2(v), ms: 700 });
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
      } else if (e.kind === "parlay") {
        mark += e.stake * e.decimal * e.p; // EV = payout * P(all legs hit)
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
    const chip = CWC.el("button", "chip wallet-chip-btn");
    chip.type = "button";
    const cls = pnl > 0.005 ? "pnl-up" : (pnl < -0.005 ? "pnl-down" : "pnl-flat");
    chip.innerHTML = CWC.icon("coin") +
      " <b class=\"wc-bal\">" + CWC.esc(money2(W.balance)) + "</b>" +
      " <span class=\"wc-pnl " + cls + "\">(" + (pnl >= 0 ? "+" : "") +
      CWC.esc(money2(pnl)) + ")</span> <span class=\"wc-caret\">▾</span>";
    chip.title = "Wallet — click to add funds or reset";
    chip.addEventListener("click", e => { e.stopPropagation(); walletMenu(chip); });
    host.appendChild(chip);
  }

  /* ---------------- wallet actions + menu ---------------- */
  function addFunds(amt) {
    W.balance = Math.round((W.balance + amt) * 100) / 100;
    saveWallet(); render();
    CWC.ui.toast("Added " + money2(amt) + " play money", "ok");
  }
  function resetWallet() {
    W = freshWallet(); saveWallet(); render();
    CWC.ui.toast("Wallet reset to " + money2(START_BALANCE), "ok");
  }

  let WM = null;
  function closeWalletMenu() {
    if (WM) { WM.remove(); WM = null; }
    document.removeEventListener("click", onWMDoc, true);
    document.removeEventListener("keydown", onWMKey, true);
  }
  function onWMDoc(e) { if (WM && !WM.contains(e.target)) closeWalletMenu(); }
  function onWMKey(e) { if (e.key === "Escape") closeWalletMenu(); }

  function walletMenu(anchor) {
    closeWalletMenu();
    const pnl = markToModel();
    WM = CWC.el("div", "wallet-menu team-pop");
    WM.innerHTML =
      '<div class="wm-row"><span class="muted">Balance</span>' +
        '<b class="tnum">' + money2(W.balance) + "</b></div>" +
      '<div class="wm-row"><span class="muted">P/L</span>' +
        '<b class="tnum ' + (pnl >= 0 ? "pnl-up" : "pnl-down") + '">' +
        (pnl >= 0 ? "+" : "") + money2(pnl) + "</b></div>";
    const acts = CWC.el("div", "wm-acts");
    [["+ $1,000", 1000], ["+ $10,000", 10000]].forEach(([lbl, amt]) => {
      const b = CWC.el("button", "btn btn--sm", lbl); b.type = "button";
      b.addEventListener("click", () => { addFunds(amt); walletMenu(anchor); });
      acts.appendChild(b);
    });
    WM.appendChild(acts);
    const rst = CWC.el("button", "btn btn--sm btn--danger wm-reset", "Reset to " + money2(START_BALANCE));
    rst.type = "button";
    rst.addEventListener("click", () => { resetWallet(); closeWalletMenu(); });
    WM.appendChild(rst);
    document.body.appendChild(WM);
    const r = anchor.getBoundingClientRect();
    WM.style.position = "fixed";
    WM.style.top = (r.bottom + 6) + "px";
    WM.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    setTimeout(() => {
      document.addEventListener("click", onWMDoc, true);
      document.addEventListener("keydown", onWMKey, true);
    }, 0);
  }

  /* ---------------- bet slip drawer (fixture) ---------------- */
  // A persistent right-side drawer. openSlip() loads a fixture leg into it and
  // opens it. It also hosts the parlay builder (multiple legs → combined decimal).
  let SLIP = null; // {match, outcome, p, stake}

  function ensureDrawer() {
    let dr = document.getElementById("bet-drawer");
    if (dr) return dr;
    dr = CWC.el("aside", "bet-drawer");
    dr.id = "bet-drawer";
    dr.setAttribute("role", "dialog");
    dr.setAttribute("aria-label", "Bet slip");
    dr.setAttribute("aria-hidden", "true");
    const scrim = CWC.el("div", "bet-drawer-scrim");
    scrim.addEventListener("click", closeSlip);
    document.body.appendChild(scrim);
    document.body.appendChild(dr);
    dr._scrim = scrim;
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && dr.classList.contains("is-open")) closeSlip();
    });
    return dr;
  }

  function openDrawer() {
    const dr = ensureDrawer();
    dr.classList.add("is-open");
    dr.setAttribute("aria-hidden", "false");
    dr._scrim.classList.add("is-open");
    renderDrawer();
  }
  function closeSlip() {
    const dr = document.getElementById("bet-drawer");
    if (dr) { dr.classList.remove("is-open"); dr.setAttribute("aria-hidden", "true");
      if (dr._scrim) dr._scrim.classList.remove("is-open"); }
    SLIP = null;
  }

  function openSlip(match, outcome) {
    if (!CWC.state.live) { CWC.ui.toast("Betting is live-only. Run the live server.", "err"); return; }
    outcome = OUTCOME_IDX[outcome] != null ? outcome : "W";
    const odds = oddsFor(match);
    const p = odds[OUTCOME_IDX[outcome]];
    SLIP = { match, outcome, p, stake: STAKES[1] };
    openDrawer();
  }

  function outcomeLabel(match, outcome) {
    return outcome === "W" ? (teamName(match.a) + " to win")
      : outcome === "L" ? (teamName(match.b) + " to win") : "Draw";
  }

  function renderDrawer() {
    const dr = document.getElementById("bet-drawer");
    if (!dr) return;
    dr.innerHTML = "";

    const head = CWC.el("div", "slip-head");
    head.innerHTML = "<strong>Bet slip</strong>";
    const x = CWC.el("button", "icon-btn"); x.type = "button";
    x.innerHTML = CWC.icon("close"); x.setAttribute("aria-label", "Close bet slip");
    x.addEventListener("click", closeSlip);
    head.appendChild(x);
    dr.appendChild(head);

    dr.appendChild(singleSlipSection());
    dr.appendChild(parlaySection());
  }

  // ---- single bet section ----
  function singleSlipSection() {
    const sec = CWC.el("div", "slip-section");
    sec.appendChild(CWC.el("div", "slip-section-title", "Single bet"));
    if (!SLIP) {
      sec.appendChild(CWC.el("p", "muted", "Pick an outcome in the fixture book to load a single bet."));
      return sec;
    }
    const m = SLIP.match, p = SLIP.p;

    const sub = CWC.el("div", "slip-sub");
    sub.innerHTML = "<span>" + CWC.esc(teamName(m.a)) + " vs " +
      CWC.esc(teamName(m.b)) + "</span>";
    const pick = CWC.el("span", "slip-pick", outcomeLabel(m, SLIP.outcome));
    sub.appendChild(pick);
    sec.appendChild(sub);

    const meta = CWC.el("div", "slip-meta");
    meta.appendChild(document.createTextNode("Model prob "));
    meta.appendChild(CWC.el("b", "tnum", (p * 100).toFixed(1) + "%"));
    meta.appendChild(document.createTextNode(" · decimal "));
    meta.appendChild(decEl(p));
    meta.appendChild(document.createTextNode(" (no vig)"));
    sec.appendChild(meta);

    // stake presets + custom
    const chips = CWC.el("div", "stake-chips");
    STAKES.forEach(s => {
      const b = CWC.el("button", "stake-chip", "$" + s); b.type = "button";
      b.addEventListener("click", () => { SLIP.stake = s; renderDrawer(); });
      chips.appendChild(b);
    });
    const custom = CWC.el("input", "stake-custom");
    custom.type = "number"; custom.min = "1"; custom.placeholder = "custom";
    if (STAKES.indexOf(SLIP.stake) < 0) custom.value = String(SLIP.stake);
    custom.addEventListener("input", () => {
      const v = Number(custom.value); if (v > 0) { SLIP.stake = v; syncSingle(sec); }
    });
    chips.appendChild(custom);
    sec.appendChild(chips);

    // readouts: payout / to win / balance after
    const reads = CWC.el("div", "slip-reads");
    reads.innerHTML =
      '<div class="slip-read"><span>Payout</span><b class="tnum" data-r="payout"></b></div>' +
      '<div class="slip-read"><span>To win</span><b class="tnum" data-r="towin"></b></div>' +
      '<div class="slip-read"><span>Balance after</span><b class="tnum" data-r="after"></b></div>';
    sec.appendChild(reads);

    const addP = CWC.el("button", "btn btn--accent-ghost slip-addparlay", "+ Add to parlay");
    addP.type = "button";
    addP.addEventListener("click", () => {
      addParlayLeg(m, SLIP.outcome, SLIP.p);
      renderDrawer();
    });
    sec.appendChild(addP);

    const place = CWC.el("button", "btn btn--primary slip-place");
    place.type = "button";
    place.addEventListener("click", placeSlip);
    sec.appendChild(place);

    // mark chips + fill readouts
    syncSingle(sec);
    return sec;
  }

  function syncSingle(sec) {
    if (!SLIP) return;
    const dec = decimalOdds(SLIP.p);
    const payout = SLIP.stake * dec;
    const towin = payout - SLIP.stake;
    const after = W.balance - SLIP.stake;
    const set = (k, v) => { const e = sec.querySelector('[data-r="' + k + '"]'); if (e) e.textContent = money2(v); };
    set("payout", payout); set("towin", towin); set("after", after);
    sec.querySelectorAll(".stake-chip").forEach(c => {
      c.classList.toggle("is-on", c.textContent === "$" + SLIP.stake);
    });
    const place = sec.querySelector(".slip-place");
    const afford = SLIP.stake <= W.balance && SLIP.stake > 0;
    if (place) {
      place.disabled = !afford;
      place.textContent = afford ? ("Place " + money2(SLIP.stake)) : "Insufficient balance";
    }
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
    SLIP = null;
    renderDrawer();
    renderIfActive();
  }

  // ---- parlay builder ----
  function addParlayLeg(match, outcome, p) {
    // one leg per fixture — replace if the fixture is already in the slip
    PARLAY = PARLAY.filter(l => l.matchId !== match.id);
    PARLAY.push({ matchId: match.id, outcome, p,
      label: teamName(match.a) + " v " + teamName(match.b),
      pick: outcomeLabel(match, outcome) });
    CWC.ui.toast("Added to parlay (" + PARLAY.length + " legs)", "ok");
  }
  function parlayDecimal() {
    // combined decimal = product of legs' decimals (client combinatorics).
    return PARLAY.reduce((acc, l) => acc * decimalOdds(l.p), 1);
  }
  function parlayProb() { return PARLAY.reduce((acc, l) => acc * l.p, 1); }

  const PARLAY_STATE = { stake: STAKES[1] };
  function parlaySection() {
    const sec = CWC.el("div", "slip-section");
    const title = CWC.el("div", "slip-section-title", "Parlay");
    if (PARLAY.length) {
      const clr = CWC.el("button", "icon-btn slip-clear", "clear"); clr.type = "button";
      clr.addEventListener("click", () => { PARLAY = []; renderDrawer(); });
      title.appendChild(clr);
    }
    sec.appendChild(title);
    if (!PARLAY.length) {
      sec.appendChild(CWC.el("p", "muted", "Add legs from any fixtures to build an all-or-nothing parlay."));
      return sec;
    }
    const legs = CWC.el("div", "parlay-legs");
    PARLAY.forEach(l => {
      const leg = CWC.el("div", "parlay-leg");
      const info = CWC.el("span", "parlay-leg-info");
      info.innerHTML = "<b>" + CWC.esc(l.pick) + "</b><span class=\"muted\">" +
        CWC.esc(l.label) + "</span>";
      leg.appendChild(info);
      leg.appendChild(decEl(l.p, "parlay-leg-odds"));
      const rm = CWC.el("button", "icon-btn"); rm.type = "button";
      rm.innerHTML = CWC.icon("close"); rm.setAttribute("aria-label", "Remove leg");
      rm.addEventListener("click", () => { PARLAY = PARLAY.filter(x => x !== l); renderDrawer(); });
      leg.appendChild(rm);
      legs.appendChild(leg);
    });
    sec.appendChild(legs);

    const combo = CWC.el("div", "parlay-combo");
    combo.appendChild(document.createTextNode(PARLAY.length + " legs · combined "));
    combo.appendChild(decEl(parlayProb()));
    sec.appendChild(combo);

    // stake presets
    const chips = CWC.el("div", "stake-chips");
    STAKES.forEach(s => {
      const b = CWC.el("button", "stake-chip", "$" + s); b.type = "button";
      b.addEventListener("click", () => { PARLAY_STATE.stake = s; renderDrawer(); });
      chips.appendChild(b);
    });
    const custom = CWC.el("input", "stake-custom");
    custom.type = "number"; custom.min = "1"; custom.placeholder = "custom";
    if (STAKES.indexOf(PARLAY_STATE.stake) < 0) custom.value = String(PARLAY_STATE.stake);
    custom.addEventListener("input", () => {
      const v = Number(custom.value); if (v > 0) { PARLAY_STATE.stake = v; syncParlay(sec); }
    });
    chips.appendChild(custom);
    sec.appendChild(chips);

    const reads = CWC.el("div", "slip-reads");
    reads.innerHTML =
      '<div class="slip-read"><span>Payout</span><b class="tnum" data-r="ppayout"></b></div>' +
      '<div class="slip-read"><span>To win</span><b class="tnum" data-r="ptowin"></b></div>' +
      '<div class="slip-read"><span>Balance after</span><b class="tnum" data-r="pafter"></b></div>';
    sec.appendChild(reads);

    const place = CWC.el("button", "btn btn--primary slip-place");
    place.type = "button";
    place.addEventListener("click", placeParlay);
    sec.appendChild(place);
    sec._place = place;

    syncParlay(sec);
    return sec;
  }

  function syncParlay(sec) {
    const dec = parlayDecimal();
    const stake = PARLAY_STATE.stake;
    const payout = stake * dec;
    const set = (k, v) => { const e = sec.querySelector('[data-r="' + k + '"]'); if (e) e.textContent = money2(v); };
    set("ppayout", payout); set("ptowin", payout - stake); set("pafter", W.balance - stake);
    sec.querySelectorAll(".stake-chip").forEach(c => {
      c.classList.toggle("is-on", c.textContent === "$" + stake);
    });
    const place = sec.querySelector(".slip-place");
    const afford = stake <= W.balance && stake > 0 && PARLAY.length >= 2;
    if (place) {
      place.disabled = !afford;
      place.textContent = PARLAY.length < 2 ? "Add 2+ legs"
        : (afford ? ("Place parlay " + money2(stake)) : "Insufficient balance");
    }
  }

  function placeParlay() {
    const stake = PARLAY_STATE.stake;
    if (PARLAY.length < 2 || stake <= 0 || stake > W.balance) return;
    W.balance -= stake;
    W.ledger.unshift({
      id: nextId(), ts: Date.now(), kind: "parlay",
      legs: PARLAY.map(l => ({ ref: l.matchId, outcome: l.outcome, p: l.p, label: l.label, pick: l.pick })),
      stake: round2(stake), p: parlayProb(), decimal: parlayDecimal(),
      status: "open", payout: 0,
      label: PARLAY.length + "-leg parlay"
    });
    saveWallet();
    CWC.ui.toast("Parlay placed: " + money2(stake) + " · " + PARLAY.length + " legs", "ok");
    PARLAY = [];
    renderDrawer();
    renderIfActive();
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

  // Cash out an OPEN contract position by selling its shares back into the LMSR
  // at the current price. Only LMSR contracts are sellable — fixed-odds fixtures
  // are NOT (there is no live counterparty; cashing out would be fake).
  function cashOutContract(entry) {
    if (entry.kind !== "contract" || entry.status !== "open") return;
    const q = W.lmsr.q[entry.ref];
    if (!q) { CWC.ui.toast("No open market for this position.", "err"); return; }
    const isYes = entry.side === "YES";
    // selling `shares` of the held side: revert the quantity and refund the
    // cost delta the AMM returns.
    const before = lmsrCost(q);
    const nq = { yes: q.yes - (isYes ? entry.shares : 0), no: q.no - (isYes ? 0 : entry.shares) };
    const refund = round2(before - lmsrCost(nq)); // $ returned for selling the lot
    W.lmsr.q[entry.ref] = nq;
    (W.lmsr.hist[entry.ref] || (W.lmsr.hist[entry.ref] = [])).push(lmsrPrice(nq));
    W.balance += Math.max(0, refund);
    entry.status = "cashed";
    entry.payout = Math.max(0, refund);
    saveWallet();
    CWC.ui.toast("Cashed out " + entry.shares + " " + entry.side + " for " + money2(entry.payout), "ok");
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
    ROOT.appendChild(positionsPanel());
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
    const prev = LAST_PRICE[m.id];
    const row = CWC.el("div", "fx-row");
    row.dataset.fxid = m.id;
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
      const idx = OUTCOME_IDX[o];
      const p = odds[idx];
      const btn = CWC.el("button", "bet-btn");
      btn.type = "button";
      btn.dataset.o = o;
      const span = CWC.el("span", null, lab);
      btn.appendChild(span);
      // movement arrow vs the previously-rendered model price for this outcome.
      if (prev && Math.abs(prev[idx] - p) > 1e-4) {
        const up = p > prev[idx]; // higher prob → shorter (lower) odds; arrow reflects prob move
        const arr = CWC.el("span", "odds-move " + (up ? "is-up" : "is-down"), up ? "▲" : "▼");
        arr.setAttribute("aria-label", up ? "shortening" : "drifting");
        btn.appendChild(arr);
      }
      const db = decEl(p);
      btn.appendChild(db);
      if (prev && Math.abs(prev[idx] - p) > 1e-4) {
        const up = p > prev[idx];
        CWC.anim.flash(db, up ? "flash-up" : "flash-down", 900);
      }
      btn.addEventListener("click", () => openSlip(m, o));
      btns.appendChild(btn);
    });
    row.appendChild(btns);
    // remember this render's model prices for the next ▲▼ comparison.
    LAST_PRICE[m.id] = odds.slice();
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
      label: CWC.flag(t.country) + " " + (t.name || t.country),
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

  /* --- my positions (open exposure, mark-to-model P&L) --- */
  function positionMark(e) {
    // current mark value of one open position (what it's worth now).
    if (e.kind === "fixture" || e.kind === "parlay") return e.stake * e.decimal * e.p;
    if (e.kind === "contract") {
      const q = W.lmsr.q[e.ref];
      const price = q ? (e.side === "YES" ? lmsrPrice(q) : 1 - lmsrPrice(q)) : e.p;
      return e.shares * price;
    }
    return 0;
  }

  function positionsPanel() {
    const p = panel("My positions");
    const open = W.ledger.filter(e => e.status === "open");
    if (!open.length) {
      p.appendChild(CWC.el("p", "muted", "No open positions. Place a fixture bet, parlay, or contract to build exposure."));
      return p;
    }
    const list = CWC.el("div", "pos-list");
    open.forEach(e => list.appendChild(positionRow(e)));
    p.appendChild(list);
    p.appendChild(CWC.el("p", "muted", "P&L marked to the model. Cash-out is only offered on LMSR contracts (sellable at the current price); fixed-odds fixtures & parlays settle at match time."));
    return p;
  }

  function positionRow(e) {
    const row = CWC.el("div", "pos-row pos-" + e.kind);
    const head = CWC.el("div", "pos-head");
    const kindLbl = e.kind === "fixture" ? "Fixture" : e.kind === "parlay" ? "Parlay" : "Contract";
    head.appendChild(CWC.el("span", "pos-kind chip", kindLbl));
    const side = e.kind === "contract" ? e.side : e.kind === "fixture" ? e.outcome : (e.legs.length + " legs");
    head.appendChild(CWC.el("span", "pos-label", (e.label || e.ref) + " · " + side));
    row.appendChild(head);

    if (e.kind === "parlay") {
      const legs = CWC.el("div", "pos-legs muted");
      legs.textContent = e.legs.map(l => l.pick).join("  +  ");
      row.appendChild(legs);
    }

    const mark = positionMark(e);
    const pnl = mark - e.stake;
    const stats = CWC.el("div", "pos-stats");
    const stat = (k, v, cls) => {
      const s = CWC.el("span", "pos-stat");
      s.appendChild(CWC.el("span", "pos-stat-k", k));
      s.appendChild(CWC.el("span", "pos-stat-v tnum" + (cls ? " " + cls : ""), v));
      return s;
    };
    stats.appendChild(stat("stake", money2(e.stake)));
    stats.appendChild(stat("mark", money2(mark)));
    stats.appendChild(stat("P&L", (pnl >= 0 ? "+" : "") + money2(pnl),
      pnl > 0.005 ? "pnl-up" : pnl < -0.005 ? "pnl-down" : "pnl-flat"));
    row.appendChild(stats);

    if (e.kind === "contract") {
      const co = CWC.el("button", "btn btn--sm btn--accent-ghost pos-cashout", "Cash out " + money2(mark));
      co.type = "button";
      co.addEventListener("click", () => cashOutContract(e));
      row.appendChild(co);
    } else {
      const note = CWC.el("div", "pos-note muted", "settles at match time — no cash-out on fixed odds");
      row.appendChild(note);
    }
    return row;
  }

  /* --- ledger --- */
  function ledgerPanel() {
    const controls = CWC.el("div", "ledger-controls");
    const add = CWC.el("button", "btn btn--sm", "+ $1,000");
    add.type = "button";
    add.addEventListener("click", () => addFunds(1000));
    const reset = CWC.el("button", "btn btn--sm btn--danger", "Reset wallet");
    reset.type = "button";
    reset.addEventListener("click", resetWallet);
    controls.append(add, reset);
    const p = panel("Ledger", controls);
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
      tr.dataset.lid = e.id;
      const side = e.kind === "fixture" ? e.outcome
        : e.kind === "parlay" ? (e.legs.length + " legs") : e.side;
      const price = (e.kind === "fixture" || e.kind === "parlay")
        ? (e.decimal ? decimalDisplay(e.p).text : "-")
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
        let cls = null;
        if (i === 5) cls = "st-cell";
        else if (i === 3 || i === 6) cls = "tnum";
        else if (i === 4) cls = "tnum" + (price === ">99×" ? " odds-capped" : "");
        const td = CWC.el("td", cls, v);
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
