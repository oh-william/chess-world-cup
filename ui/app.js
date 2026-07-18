"use strict";

let DATA = null;
const B = { i: 0, playing: null, event: null, game: null }; // broadcast state

// ---------- helpers ----------
function codeToFlag(cc) {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return "🏴";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + cc.toUpperCase().charCodeAt(0) - 65,
                              A + cc.toUpperCase().charCodeAt(1) - 65);
}
const GLYPH = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
function engineOf(name) {
  return DATA.engines[name] || { name, lang: "?", family: "?", color: "#888", country: "XX" };
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// ---------- board rendering ----------
function fenToRows(fen) {
  const placement = fen.split(" ")[0];
  return placement.split("/"); // rank 8 first
}
function squareEls(fen, hlFrom, hlTo) {
  const rows = fenToRows(fen);
  const cells = [];
  for (let r = 7; r >= 0; r--) {
    const row = rows[7 - r];
    let file = 0;
    const expanded = [];
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) expanded.push(null); }
      else expanded.push(ch);
    }
    for (file = 0; file < 8; file++) {
      const ch = expanded[file];
      const dark = (file + r) % 2 === 0;
      const c = el("div", "sq " + (dark ? "dark" : "light"));
      const sqName = "abcdefgh"[file] + (r + 1);
      if (sqName === hlFrom || sqName === hlTo) c.classList.add("hl");
      if (ch) {
        const white = ch === ch.toUpperCase();
        c.appendChild(el("span", "pc " + (white ? "w" : "b"), GLYPH[ch.toLowerCase()]));
      }
      cells.push(c);
    }
  }
  return cells;
}
function renderBoard(fen, uci, id = "board") {
  const board = document.getElementById(id);
  board.innerHTML = "";
  const from = uci ? uci.slice(0, 2) : null, to = uci ? uci.slice(2, 4) : null;
  squareEls(fen, from, to).forEach(c => board.appendChild(c));
}

// ---------- broadcast ----------
function curGame() { return B.event.games[B.game]; }

function plate(name, side) {
  const e = engineOf(name);
  return `<span class="flag">${codeToFlag(e.country)}</span>
    <span class="dot" style="background:${e.color}"></span>
    <span class="who">${name}</span>
    <span class="lang">${e.lang}</span>
    <span class="side">${side}</span>`;
}

function renderTelemetry(mv) {
  const t = document.getElementById("telemetry");
  if (!mv) { t.innerHTML = ""; return; }
  const nps = mv.self_ms > 0 ? Math.round(mv.self_nodes / (mv.self_ms / 1000)) : null;
  const cards = [
    ["last move", mv.uci], ["by", mv.engine],
    ["nodes", mv.self_nodes.toLocaleString()],
    ["nps", nps ? (nps / 1e6).toFixed(2) + "M" : "—"],
    ["orch ms", mv.orch_ms], ["tax Δ ms", mv.delta_ms],
  ];
  t.innerHTML = cards.map(([k, v]) => `<div class="tcard"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

function renderTax(i, moves) {
  let cumDelta = 0, cumOrch = 0;
  for (let k = 0; k < i; k++) { cumDelta += moves[k].delta_ms; cumOrch += moves[k].orch_ms; }
  const pctOf = cumOrch > 0 ? (cumDelta / cumOrch) * 100 : 0;
  document.getElementById("tax-fill").style.width = Math.min(100, pctOf) + "%";
  document.getElementById("tax-value").textContent =
    `${cumDelta} ms tax over ${cumOrch} ms wall (${pctOf.toFixed(1)}%)`;
}

function renderMoveList(moves, cur) {
  const ml = document.getElementById("movelist");
  ml.innerHTML = "";
  moves.forEach((m, idx) => {
    if (idx % 2 === 0) ml.appendChild(el("span", "num", (idx / 2 + 1) + "."));
    const s = el("span", "mv" + (idx === cur - 1 ? " cur" : ""), m.uci);
    s.onclick = () => showPly(idx + 1);
    ml.appendChild(s);
  });
}

function showPly(i) {
  const g = curGame();
  const n = g.positions.length;
  B.i = Math.max(0, Math.min(n - 1, i));
  const fen = g.positions[B.i];
  const mv = B.i > 0 ? g.moves[B.i - 1] : null;
  renderBoard(fen, mv ? mv.uci : null);
  renderTelemetry(mv);
  renderTax(B.i, g.moves);
  renderMoveList(g.moves, B.i);
  document.getElementById("scrub").value = B.i;
  document.getElementById("ply-label").textContent = `${B.i} / ${n - 1}`;
}

function loadGame() {
  const g = curGame();
  document.getElementById("plate-top").innerHTML = plate(g.black, "black");
  document.getElementById("plate-bottom").innerHTML = plate(g.white, "white");
  const rmap = { "1-0": g.white + " wins", "0-1": g.black + " wins", "1/2-1/2": "draw" };
  document.getElementById("game-result").innerHTML =
    `${g.result} — ${rmap[g.result]} <span class="reason">(${g.reason}, ${g.plies} plies)</span>`;
  document.getElementById("scrub").max = g.positions.length - 1;
  stopPlay();
  showPly(0);
}

function fillGameSelect() {
  const sel = document.getElementById("sel-game");
  sel.innerHTML = "";
  B.event.games.forEach((g, idx) => {
    const label = `#${g.id}  ${codeToFlag(g.white_country)} ${g.white} vs ${g.black} ${codeToFlag(g.black_country)}  · ${g.result}`;
    sel.appendChild(el("option", null, label)).value = idx;
  });
  B.game = 0; sel.value = 0;
}

function stopPlay() {
  if (B.playing) { clearInterval(B.playing); B.playing = null; }
  document.getElementById("btn-play").textContent = "▶ Play";
}
function togglePlay() {
  if (B.playing) { stopPlay(); return; }
  const g = curGame();
  if (B.i >= g.positions.length - 1) showPly(0);
  document.getElementById("btn-play").textContent = "⏸ Pause";
  B.playing = setInterval(() => {
    const g = curGame();
    if (B.i >= g.positions.length - 1) { stopPlay(); return; }
    showPly(B.i + 1);
  }, 650);
}

function initBroadcast() {
  const evSel = document.getElementById("sel-event");
  DATA.events.forEach((ev, idx) => {
    evSel.appendChild(el("option", null, `${ev.label} (${ev.mode} ${ev.budget})`)).value = idx;
  });
  evSel.onchange = () => { B.event = DATA.events[+evSel.value]; fillGameSelect(); loadGame(); };
  document.getElementById("sel-game").onchange = e => { B.game = +e.target.value; loadGame(); };
  document.getElementById("btn-start").onclick = () => { stopPlay(); showPly(0); };
  document.getElementById("btn-prev").onclick = () => { stopPlay(); showPly(B.i - 1); };
  document.getElementById("btn-next").onclick = () => { stopPlay(); showPly(B.i + 1); };
  document.getElementById("btn-end").onclick = () => { stopPlay(); showPly(curGame().positions.length - 1); };
  document.getElementById("btn-play").onclick = togglePlay;
  document.getElementById("scrub").oninput = e => { stopPlay(); showPly(+e.target.value); };
  B.event = DATA.events[0]; fillGameSelect(); loadGame();
}

// ---------- standings ----------
function renderStandings() {
  const root = document.getElementById("standings-content");
  root.innerHTML = "";
  for (const ev of DATA.events) {
    const wrap = el("div", "event-standings");
    wrap.appendChild(el("h2", null, `🏆 ${ev.label}`));
    wrap.appendChild(el("div", "sub", `${ev.games.length} games · ${ev.mode} budget ${ev.budget} · alternating colors from the forced book`));
    const rows = ev.engines.map(n => ({ n, ...ev.standings[n], st: ev.stats[n] || {} }))
      .sort((a, b) => b.pts - a.pts);
    const maxPts = Math.max(...rows.map(r => r.pts), 1);
    const t = el("table");
    t.innerHTML = `<thead><tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th>
      <th class="num">D</th><th class="num">L</th><th class="num">Pts</th>
      <th class="num">Score%</th><th class="num">NPS</th><th class="num">Lat p50/p99</th>
      <th class="num">Tax p99</th></tr></thead>`;
    const tb = el("tbody");
    rows.forEach((r, idx) => {
      const e = engineOf(r.n);
      const score = r.games ? (100 * r.pts / r.games).toFixed(0) : 0;
      const nps = r.st.nps_mean ? (r.st.nps_mean / 1e6).toFixed(2) + "M" : "—";
      const tr = el("tr");
      tr.innerHTML = `<td>${idx + 1}</td>
        <td><div class="team"><span class="flag">${codeToFlag(e.country)}</span>
          <span class="nm">${r.n}</span><span class="lang">${e.lang}</span></div></td>
        <td class="num">${r.games}</td><td class="num">${r.w}</td><td class="num">${r.d}</td>
        <td class="num">${r.l}</td><td class="num"><b>${r.pts}</b></td>
        <td class="num barcell"><div class="fill" style="width:${100 * r.pts / maxPts}%"></div><span>${score}%</span></td>
        <td class="num">${nps}</td>
        <td class="num">${r.st.lat_p50 ?? "—"}/${r.st.lat_p99 ?? "—"}ms</td>
        <td class="num">${r.st.delta_p99 ?? "—"}ms</td>`;
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    root.appendChild(wrap);
  }
}

// ---------- bracket ----------
function renderBracket() { renderBracketObj(DATA.bracket); }

function renderBracketObj(br) {
  const root = document.getElementById("bracket-content");
  root.innerHTML = "";
  if (!br) { root.innerHTML = `<p class="section-intro">No knockout yet — run
    <code>analysis/run_bracket.py</code> and rebuild the site data, or hit
    <em>Run knockout live</em> above.</p>`; return; }

  (br.rounds || []).forEach(round => {
    const col = el("div", "bracket-round");
    col.appendChild(el("div", "round-name", round.name));
    round.ties.forEach(tie => {
      const card = el("div", "tie");
      card.appendChild(tieSide(tie.a, tie.seedA, tie.scoreA, tie.winner === tie.a, tie.bye));
      card.appendChild(tieSide(tie.b, tie.seedB, tie.scoreB, tie.winner === tie.b, tie.bye));
      col.appendChild(card);
    });
    root.appendChild(col);
  });

  if (br.champion) {
    const champ = el("div", "bracket-round champion-col");
    champ.appendChild(el("div", "round-name", "Champion"));
    const c = engineOf(br.champion);
    const trophy = el("div", "tie champion-card");
    trophy.innerHTML = `<div class="trophy">🏆</div>
      <div class="tie-side win"><span class="flag">${codeToFlag(c.country)}</span>
        <span class="dot" style="background:${c.color}"></span>
        <span class="nm">${br.champion}</span><span class="lang">${c.lang}</span></div>
      <div class="champ-sub">${br.mode || ""} ${br.budget || ""} · best of ${br.games_per_tie || ""}</div>`;
    champ.appendChild(trophy);
    root.appendChild(champ);
  }
}

// Live knockout streaming.
const LIVEBK = { es: null, br: null };
function bkRound(name) {
  let r = LIVEBK.br.rounds.find(x => x.name === name);
  if (!r) { r = { name, ties: [] }; LIVEBK.br.rounds.push(r); }
  return r;
}
async function runKnockoutLive() {
  const budget = +id("bk-budget").value, games = +id("bk-games").value;
  id("bk-status").textContent = "seeding & starting…";
  await fetch("/api/bracket-start", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget, games }) });
  if (LIVEBK.es) LIVEBK.es.close();
  LIVEBK.br = { seeds: [], rounds: [], champion: null, mode: "nodes", budget, games_per_tie: games };
  renderBracketObj(LIVEBK.br);
  const es = new EventSource("/api/bracket-stream"); LIVEBK.es = es;
  es.addEventListener("seeds", e => {
    const d = JSON.parse(e.data);
    LIVEBK.br.seeds = d.seeds; LIVEBK.br.mode = d.mode; LIVEBK.br.budget = d.budget;
    LIVEBK.br.games_per_tie = d.games_per_tie;
    id("bk-status").textContent = "🔴 bracket live — seeded, playing…";
  });
  es.addEventListener("tie_start", e => {
    const d = JSON.parse(e.data);
    id("bk-status").textContent = `🔴 ${d.round}: ${d.a} vs ${d.b} …`;
  });
  es.addEventListener("tie_result", e => {
    bkRound(JSON.parse(e.data).round).ties.push(JSON.parse(e.data));
    renderBracketObj(LIVEBK.br);
  });
  es.addEventListener("champion", e => {
    LIVEBK.br.champion = JSON.parse(e.data).engine;
    renderBracketObj(LIVEBK.br);
    id("bk-status").textContent = `🏆 champion: ${LIVEBK.br.champion}`;
  });
  es.addEventListener("reset", () => {
    LIVEBK.br = { seeds: [], rounds: [], champion: null };
    renderBracketObj(LIVEBK.br);
  });
}
function tieSide(name, seed, score, isWin, bye) {
  if (name === "BYE" || name == null)
    return el("div", "tie-side bye", `<span class="nm">— bye —</span>`);
  const e = engineOf(name);
  const s = el("div", "tie-side" + (isWin ? " win" : ""));
  s.innerHTML = `<span class="seed">${seed || ""}</span>
    <span class="flag">${codeToFlag(e.country)}</span>
    <span class="dot" style="background:${e.color}"></span>
    <span class="nm">${name}</span><span class="lang">${e.lang}</span>
    <span class="tie-score">${bye ? "" : (score != null ? score : "")}</span>`;
  return s;
}

// ---------- gates ----------
function renderGates() {
  const root = document.getElementById("gates-content");
  root.innerHTML = "";
  for (const g of DATA.gates) {
    const c = el("div", "gate");
    c.innerHTML = `<div class="top"><div class="n">${g.n}</div>
      <div><h3>Gate ${g.n} — ${g.name}</h3></div>
      <div class="status ${g.status}">${g.status}</div></div>
      <p>${g.detail}</p>`;
    root.appendChild(c);
  }
}

// ---------- markets (LMSR) ----------
const MKT_KEY = "cwc_market_v2";
const START_BAL = 1000, LOT = 10, LIQ = 40;
let M = null;

function loadMarket() {
  try { M = JSON.parse(localStorage.getItem(MKT_KEY)); } catch (e) { M = null; }
  if (!M) M = { balance: START_BAL, pos: {}, q: {}, hist: {}, resolved: {} };
  for (const mk of DATA.markets) {
    if (!M.q[mk.id]) M.q[mk.id] = { yes: 0, no: 0 };
    if (!M.pos[mk.id]) M.pos[mk.id] = { yes: 0, no: 0 };
    if (!M.hist[mk.id]) M.hist[mk.id] = [priceYes(mk.id)];
  }
}
function saveMarket() { localStorage.setItem(MKT_KEY, JSON.stringify(M)); }
function priceYes(id) {
  const q = M ? M.q[id] : { yes: 0, no: 0 };
  const ey = Math.exp(q.yes / LIQ), en = Math.exp(q.no / LIQ);
  return ey / (ey + en);
}
function cost(id, side, k) {
  const q = M.q[id];
  const C = qy => LIQ * Math.log(Math.exp(qy.yes / LIQ) + Math.exp(qy.no / LIQ));
  const before = C(q);
  const after = C(side === "yes" ? { yes: q.yes + k, no: q.no } : { yes: q.yes, no: q.no + k });
  return after - before;
}
function buy(id, side) {
  if (M.resolved[id]) return;
  const c = cost(id, side, LOT);
  if (c > M.balance) { flash(id, "insufficient balance"); return; }
  M.balance -= c;
  M.q[id][side] += LOT;
  M.pos[id][side] += LOT;
  M.hist[id].push(priceYes(id));
  if (M.hist[id].length > 60) M.hist[id].shift();
  saveMarket(); renderMarkets();
}
function resolve(id) {
  const mk = DATA.markets.find(m => m.id === id);
  const win = mk.outcome === "YES" ? "yes" : "no";
  M.balance += M.pos[id][win] * 1.0; // each winning share pays 1
  M.resolved[id] = true;
  saveMarket(); renderMarkets();
}
function equity() {
  let eq = M.balance;
  for (const mk of DATA.markets) {
    if (M.resolved[mk.id]) continue;
    const py = priceYes(mk.id);
    eq += M.pos[mk.id].yes * py + M.pos[mk.id].no * (1 - py);
  }
  return eq;
}
function flash(id, msg) {
  const e = document.getElementById("pos-" + id);
  if (e) { e.textContent = msg; e.style.color = "var(--red)"; setTimeout(() => renderMarkets(), 1200); }
}
function spark(hist) {
  const w = 120, h = 34, n = hist.length;
  if (n < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const pts = hist.map((p, i) => `${(i / (n - 1)) * w},${h - p * h}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
}
function renderMarkets() {
  document.getElementById("balance").textContent = "$" + M.balance.toFixed(2);
  const pnl = equity() - START_BAL;
  const pnlEl = document.getElementById("pnl");
  pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2);
  pnlEl.style.color = pnl >= 0 ? "var(--green)" : "var(--red)";

  const root = document.getElementById("markets-content");
  root.innerHTML = "";
  for (const mk of DATA.markets) {
    const py = priceYes(mk.id);
    const pos = M.pos[mk.id], resolved = M.resolved[mk.id];
    const card = el("div", "market" + (resolved ? " resolved" : ""));
    let posLine = "";
    if (pos.yes || pos.no) posLine = `you hold ${pos.yes ? pos.yes + " YES" : ""}${pos.yes && pos.no ? " · " : ""}${pos.no ? pos.no + " NO" : ""}`;
    card.innerHTML = `<div class="evt">${mk.event}</div>
      <h3>${mk.label}</h3>
      <div class="desc">${mk.desc}</div>
      <div class="price-row"><div class="price-big">${Math.round(py * 100)}¢</div>${spark(M.hist[mk.id])}</div>`;
    if (resolved) {
      card.appendChild(el("div", null,
        `<div class="position">Resolved <span class="outcome ${mk.outcome.toLowerCase()}">${mk.outcome}</span> · payout $${(pos[mk.outcome === "YES" ? "yes" : "no"]).toFixed(2)}</div>`));
    } else {
      const btns = el("div", "btns");
      const by = el("button", "buy-yes", `Buy YES · ${Math.round(py * 100)}¢`);
      const bn = el("button", "buy-no", `Buy NO · ${Math.round((1 - py) * 100)}¢`);
      by.onclick = () => buy(mk.id, "yes"); bn.onclick = () => buy(mk.id, "no");
      btns.append(by, bn); card.appendChild(btns);
      const pl = el("div", "position"); pl.id = "pos-" + mk.id; pl.textContent = posLine;
      card.appendChild(pl);
      const rb = el("button", "resolve", "🔓 Resolve (reveal real outcome)");
      rb.onclick = () => resolve(mk.id); card.appendChild(rb);
    }
    root.appendChild(card);
  }
}

// ---------- live streaming ----------
const LIVE = { es: null, meta: {}, init: false, game: null, tally: {}, results: [] };
function liveEngineOf(name) {
  return LIVE.meta[name] || (DATA && DATA.engines[name]) || { lang: "?", country: "XX", color: "#888" };
}
function livePlate(name, side) {
  const e = liveEngineOf(name);
  return `<span class="flag">${codeToFlag(e.country)}</span>
    <span class="dot" style="background:${e.color}"></span>
    <span class="who">${name || "—"}</span><span class="lang">${e.lang}</span>
    <span class="side">${side}</span>`;
}
function id(x) { return document.getElementById(x); }
function liveReset() {
  LIVE.game = { white: null, black: null, ply: 0, tax: 0, orch: 0 };
  id("live-board").innerHTML = ""; id("live-ticker").innerHTML = "";
  id("live-telemetry").innerHTML = "";
  id("live-plate-top").innerHTML = livePlate(null, "black");
  id("live-plate-bottom").innerHTML = livePlate(null, "white");
  id("live-nowline").textContent = ""; id("live-tax-fill").style.width = "0%";
  id("live-tax-value").textContent = "";
}
function liveMove(r) {
  if (!LIVE.game) liveReset();
  const g = LIVE.game;
  if (r.color === "w") { g.white = r.engine; id("live-plate-bottom").innerHTML = livePlate(r.engine, "white"); }
  else { g.black = r.engine; id("live-plate-top").innerHTML = livePlate(r.engine, "black"); }
  renderBoard(r.fen, r.move, "live-board");
  g.tax += r.delta_ms; g.orch += r.orch_ms; g.ply = r.ply + 1;
  const pctOf = g.orch > 0 ? g.tax / g.orch * 100 : 0;
  id("live-tax-fill").style.width = Math.min(100, pctOf) + "%";
  id("live-tax-value").textContent = `${g.tax} ms tax over ${g.orch} ms wall (${pctOf.toFixed(1)}%)`;
  const nps = r.self_ms > 0 ? Math.round(r.self_nodes / (r.self_ms / 1000)) : null;
  id("live-telemetry").innerHTML = [["move", r.move], ["by", r.engine],
    ["nodes", r.self_nodes.toLocaleString()], ["nps", nps ? (nps / 1e6).toFixed(2) + "M" : "—"],
    ["orch ms", r.orch_ms], ["tax Δ ms", r.delta_ms]]
    .map(([k, v]) => `<div class="tcard"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  const ml = id("live-ticker");
  if (r.ply % 2 === 0) ml.appendChild(el("span", "num", (r.ply / 2 + 1) + "."));
  ml.appendChild(el("span", "mv", r.move));
  ml.scrollTop = ml.scrollHeight;
  id("live-nowline").textContent = `${g.white || "—"} (W) vs ${g.black || "—"} (B) · ply ${g.ply}`;
}
function liveResult(r) {
  const t = LIVE.tally;
  t[r.white] = t[r.white] || 0; t[r.black] = t[r.black] || 0;
  if (r.result === "1-0") t[r.white]++; else if (r.result === "0-1") t[r.black]++;
  else { t[r.white] += 0.5; t[r.black] += 0.5; }
  LIVE.results.push(r);
  const score = Object.keys(t).map(n => `${n} <b>${t[n]}</b>`).join("  ·  ");
  id("live-scoreline").innerHTML = `<div class="score-head">running score — ${score}</div>` +
    LIVE.results.slice(-8).reverse().map(x =>
      `<div class="score-row">game ${x.game}: ${x.white} vs ${x.black} → <b>${x.result}</b>
       <span class="reason">(${x.reason}, ${x.plies}p)</span></div>`).join("");
  LIVE.game = null;
}
function liveConnect() {
  if (LIVE.es) LIVE.es.close();
  liveReset(); LIVE.tally = {}; LIVE.results = []; id("live-scoreline").innerHTML = "";
  const es = new EventSource("/api/stream"); LIVE.es = es;
  es.addEventListener("config", e => {
    const c = JSON.parse(e.data);
    if (c.engine_meta) LIVE.meta = c.engine_meta;
    if (c.engine1) id("live-status").textContent = `🔴 streaming ${c.engine1} vs ${c.engine2}`;
  });
  es.addEventListener("move", e => liveMove(JSON.parse(e.data)));
  es.addEventListener("result", e => liveResult(JSON.parse(e.data)));
  es.addEventListener("reset", () => { liveReset(); LIVE.tally = {}; LIVE.results = []; id("live-scoreline").innerHTML = ""; });
  es.addEventListener("done", () => { id("live-status").textContent = "✓ match complete"; });
}
async function startLiveMatch() {
  const body = {
    engine1: id("live-e1").value, engine2: id("live-e2").value,
    mode: id("live-mode").value, budget: +id("live-budget").value, games: +id("live-games").value,
  };
  id("live-status").textContent = "starting…";
  await fetch("/api/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function initLive() {
  if (LIVE.init) return; LIVE.init = true;
  let cfg;
  try { cfg = await (await fetch("/api/config")).json(); }
  catch (e) { id("live-unavailable").style.display = "block"; return; }
  id("live-main").style.display = "block";
  LIVE.meta = cfg.engines || {};
  const fill = (elId, sel) => {
    const s = id(elId); s.innerHTML = "";
    cfg.available.forEach(n => { const o = el("option", null, n); o.value = n; s.appendChild(o); });
    if (sel) s.value = sel;
  };
  fill("live-e1", (cfg.cfg || {}).engine1 || "cpp-alphabeta");
  fill("live-e2", (cfg.cfg || {}).engine2 || "py-mcts");
  if (cfg.cfg && cfg.cfg.mode) id("live-mode").value = cfg.cfg.mode;
  if (cfg.cfg && cfg.cfg.budget) id("live-budget").value = cfg.cfg.budget;
  if (cfg.cfg && cfg.cfg.games) id("live-games").value = cfg.cfg.games;
  id("live-start").onclick = startLiveMatch;
  liveConnect();
}

// ---------- world cup ----------
const WC = { data: null, init: false, wallet: null, viewer: null, busy: false };
const LANG_COLOR = { "C++": "#e63946", Rust: "#dea584", JavaScript: "#f7df1e", Python: "#f4a261" };
const WC_KEY = "cwc_worldcup_v1", WC_START = 1000, WC_STAKE = 25;

function wcTeam(tid) { return WC.data.teams[tid]; }
function wcChip(tid) {
  const t = wcTeam(tid), col = LANG_COLOR[t.lang] || "#888";
  return `<span class="team-chip"><span class="flag">${codeToFlag(t.country)}</span>
    <span class="dot" style="background:${col}"></span><b>${t.country}</b>
    <span class="eng">${t.engine}</span></span>`;
}
function wcStatus(msg) { id("wc-status").textContent = msg || ""; }

function wcLoadWallet() {
  try { WC.wallet = JSON.parse(localStorage.getItem(WC_KEY)); } catch (e) { WC.wallet = null; }
  if (!WC.wallet || WC.wallet.tid !== WC.data.id) {
    WC.wallet = { tid: WC.data.id, balance: WC_START, bets: {} };
    wcSaveWallet();
  }
}
function wcSaveWallet() { localStorage.setItem(WC_KEY, JSON.stringify(WC.wallet)); }
const OUT_IDX = { W: 0, D: 1, L: 2 };
function wcBet(mid, outcome, odds) {
  const w = WC.wallet;
  if (w.bets[mid] || w.balance < WC_STAKE) { wcStatus(w.bets[mid] ? "already bet on this match" : "insufficient balance"); return; }
  w.balance -= WC_STAKE;
  w.bets[mid] = { outcome, stake: WC_STAKE, prob: odds[OUT_IDX[outcome]], settled: false };
  wcSaveWallet(); renderWC();
}
function wcSettle(match) {
  const bet = WC.wallet.bets[match.id];
  if (!bet || bet.settled) return;
  const actual = match.winner == null ? "D" : (match.winner === match.a ? "W" : "L");
  const won = bet.outcome === actual;
  bet.won = won; bet.payout = won ? bet.stake / bet.prob : 0;
  WC.wallet.balance += bet.payout; bet.settled = true;
  wcSaveWallet();
}

async function wcApi(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  return (await fetch(path, opt)).json();
}
async function wcPlay(mid) {
  if (WC.busy) return;
  WC.busy = true; wcStatus("▶ playing " + mid + " …");
  const res = await wcApi("/api/tournament/play", { match_id: mid });
  if (res.match) wcSettle(res.match);
  WC.data = res.state; WC.busy = false; wcStatus("");
  renderWC();
}
async function wcAdvance() { WC.data = (await wcApi("/api/tournament/advance", {})).state; renderWC(); }
async function wcReset() {
  wcStatus("drawing…");
  WC.data = (await wcApi("/api/tournament/reset", {})).state;
  wcLoadWallet(); wcStatus(""); renderWC();
}
async function wcAutofill() {
  if (WC.busy) return;
  const pending = WC.data.fixtures.filter(f => !f.played).map(f => f.id);
  for (let k = 0; k < pending.length; k++) {
    WC.busy = true; wcStatus(`▶ auto-playing group games… ${k + 1}/${pending.length}`);
    const res = await wcApi("/api/tournament/play", { match_id: pending[k] });
    if (res.match) wcSettle(res.match);
    WC.data = res.state; renderWC();
  }
  WC.busy = false; wcStatus("group stage complete"); renderWC();
}

function wcStageLabel(s) {
  if (s.stage === "group") return `Group Stage — ${s.fixtures.filter(f => f.played).length}/${s.fixtures.length} played`;
  if (s.stage === "done") return `🏆 Champion: ${s.champion != null ? wcTeam(s.champion).country + " (" + wcTeam(s.champion).engine + ")" : ""}`;
  const last = s.knockout[s.knockout.length - 1];
  return "Knockout — " + last.name;
}

function oddsBar(odds) {
  const [w, d, l] = odds.map(x => Math.round(x * 100));
  return `<div class="odds-bar" title="W ${w}% · D ${d}% · L ${l}%">
    <span style="width:${w}%" class="ow"></span><span style="width:${d}%" class="od"></span>
    <span style="width:${l}%" class="ol"></span></div>`;
}
function betButtons(m) {
  const bet = WC.wallet.bets[m.id];
  if (bet) {
    const lab = { W: wcTeam(m.a).country, D: "Draw", L: wcTeam(m.b).country }[bet.outcome];
    const st = bet.settled ? (bet.won ? `<span class="won">WON +$${bet.payout.toFixed(0)}</span>` : `<span class="lost">lost</span>`) : "pending";
    return `<div class="bet-line">bet $${bet.stake} on <b>${lab}</b> @ ${(1 / bet.prob).toFixed(2)} — ${st}</div>`;
  }
  return `<div class="bet-row" data-mid="${m.id}">
    ${betBtn(m, "W", wcTeam(m.a).country)}${betBtn(m, "D", "Draw")}${betBtn(m, "L", wcTeam(m.b).country)}</div>`;
}
function betBtn(m, out, lab) {
  return `<button class="betb betb-${out}">${lab} <em>${(1 / m.odds[OUT_IDX[out]]).toFixed(2)}</em></button>`;
}

function matchRow(m) {
  const row = el("div", "match");
  if (m.played) {
    const res = m.result === "1/2-1/2" ? "½–½" : m.result;
    const wtxt = m.winner == null ? "draw" : wcTeam(m.winner).country + " win";
    row.innerHTML = `${wcChip(m.a)}<span class="score">${res}</span>${wcChip(m.b)}
      <span class="mreason">${wtxt}${m.tiebreak ? " (" + m.tiebreak + ")" : ""} · ${m.plies}p · ⚔${m.capA}-${m.capB}</span>`;
    if (m.hasGame) {
      const v = el("button", "mini viewbtn", "▶ watch");
      v.onclick = () => wcOpenGame(m.id, `${wcTeam(m.a).country} vs ${wcTeam(m.b).country}`);
      row.appendChild(v);
    }
  } else {
    row.innerHTML = `${wcChip(m.a)} ${oddsBar(m.odds)} ${wcChip(m.b)}`;
    const controls = el("div", "match-controls");
    controls.innerHTML = betButtons(m);
    const play = el("button", "mini playbtn", "▶ Play");
    play.onclick = () => wcPlay(m.id);
    controls.appendChild(play);
    row.appendChild(controls);
    // wire bet buttons
    controls.querySelectorAll(".betb").forEach((btn, i) => {
      const out = ["W", "D", "L"][i];
      btn.onclick = () => wcBet(m.id, out, m.odds);
    });
  }
  return row;
}

function renderWC() {
  const s = WC.data;
  id("wc-stage").textContent = wcStageLabel(s);
  id("wc-balance").textContent = "$" + WC.wallet.balance.toFixed(0);
  const pnl = WC.wallet.balance - WC_START;
  const pe = id("wc-pnl"); pe.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(0);
  pe.style.color = pnl >= 0 ? "var(--green)" : "var(--red)";
  id("wc-advance").style.display = (s.stage === "group" && s.group_done) ? "inline-block" : "none";
  id("wc-autofill").style.display = (s.stage === "group" && !s.group_done) ? "inline-block" : "none";

  const groups = id("wc-groups"), ko = id("wc-knockout");
  groups.innerHTML = ""; ko.innerHTML = "";
  if (s.stage === "group") {
    groups.style.display = "grid";
    s.groups.forEach(g => groups.appendChild(groupCard(g)));
  } else {
    groups.style.display = "none";
    renderWCKnockout(ko, s);
  }
}

function groupCard(g) {
  const card = el("div", "group-card");
  card.appendChild(el("div", "group-name", "Group " + String.fromCharCode(65 + g.index)));
  const tbl = el("table", "group-table");
  tbl.innerHTML = `<thead><tr><th></th><th>Team</th><th class="num">Pl</th><th class="num">Pts</th><th class="num">±⚔</th></tr></thead>`;
  const tb = el("tbody");
  g.table.forEach((r, i) => {
    const cls = i < 2 ? "qual" : (i === 2 ? "third" : "");
    const tr = el("tr", cls);
    tr.innerHTML = `<td>${i + 1}</td><td>${wcChip(r.team)}</td><td class="num">${r.P}</td>
      <td class="num"><b>${r.pts}</b></td><td class="num">${r.cf - r.ca}</td>`;
    tb.appendChild(tr);
  });
  tbl.appendChild(tb); card.appendChild(tbl);
  const fx = el("div", "group-fixtures");
  WC.data.fixtures.filter(f => f.group === g.index).forEach(m => fx.appendChild(matchRow(m)));
  card.appendChild(fx);
  return card;
}

function renderWCKnockout(root, s) {
  (s.knockout || []).forEach(round => {
    const col = el("div", "bracket-round");
    col.appendChild(el("div", "round-name", round.name));
    round.ties.forEach(t => {
      const card = el("div", "tie ko-tie");
      if (t.played) {
        card.appendChild(koSide(t, t.a, t.seedA, t.winner === t.a));
        card.appendChild(koSide(t, t.b, t.seedB, t.winner === t.b));
        const foot = el("div", "ko-foot");
        foot.innerHTML = `${t.result === "1/2-1/2" ? "½–½" : t.result}${t.tiebreak ? " · " + t.tiebreak : ""} · ${t.plies}p`;
        if (t.hasGame) { const v = el("button", "mini viewbtn", "▶"); v.onclick = () => wcOpenGame(t.id, round.name); foot.appendChild(v); }
        card.appendChild(foot);
      } else {
        card.appendChild(koSide(t, t.a, t.seedA, false));
        card.appendChild(koSide(t, t.b, t.seedB, false));
        const ctr = el("div", "ko-foot");
        ctr.innerHTML = oddsBar(t.odds);
        const play = el("button", "mini playbtn", "▶ Play"); play.onclick = () => wcPlay(t.id);
        ctr.appendChild(play);
        card.appendChild(ctr);
      }
      col.appendChild(card);
    });
    root.appendChild(col);
  });
  if (s.champion != null) {
    const champ = el("div", "bracket-round champion-col");
    champ.appendChild(el("div", "round-name", "Champion"));
    const t = wcTeam(s.champion);
    const c = el("div", "tie champion-card");
    c.innerHTML = `<div class="trophy">🏆</div><div class="tie-side win">
      <span class="flag">${codeToFlag(t.country)}</span>
      <span class="dot" style="background:${LANG_COLOR[t.lang] || "#888"}"></span>
      <span class="nm">${t.country}</span><span class="lang">${t.engine}</span></div>`;
    champ.appendChild(c); root.appendChild(champ);
  }
}
function koSide(t, tid, seed, isWin) {
  const team = wcTeam(tid);
  const s = el("div", "tie-side" + (isWin ? " win" : ""));
  s.innerHTML = `<span class="seed">${seed || ""}</span><span class="flag">${codeToFlag(team.country)}</span>
    <span class="dot" style="background:${LANG_COLOR[team.lang] || "#888"}"></span>
    <span class="nm">${team.country}</span><span class="lang">${team.engine}</span>`;
  return s;
}

// game viewer modal
async function wcOpenGame(mid, title) {
  const g = (await wcApi("/api/tournament/game?id=" + encodeURIComponent(mid))).game;
  if (!g) return;
  WC.viewer = { positions: g.positions, moves: g.moves, i: 0, title, play: null };
  id("wc-viewer-title").textContent = title;
  id("wc-viewer").style.display = "flex";
  id("wcv-scrub").max = g.positions.length - 1;
  wcvShow(0);
}
function wcvShow(i) {
  const v = WC.viewer; if (!v) return;
  v.i = Math.max(0, Math.min(v.positions.length - 1, i));
  const mv = v.i > 0 ? v.moves[v.i - 1] : null;
  renderBoard(v.positions[v.i], mv ? mv.uci : null, "wc-viewer-board");
  id("wcv-scrub").value = v.i;
  id("wcv-label").textContent = `${v.i} / ${v.positions.length - 1}`;
}
function wcvStop() { if (WC.viewer && WC.viewer.play) { clearInterval(WC.viewer.play); WC.viewer.play = null; } id("wcv-play").textContent = "▶ Play"; }
function wcvTogglePlay() {
  const v = WC.viewer; if (!v) return;
  if (v.play) { wcvStop(); return; }
  if (v.i >= v.positions.length - 1) wcvShow(0);
  id("wcv-play").textContent = "⏸ Pause";
  v.play = setInterval(() => { if (v.i >= v.positions.length - 1) wcvStop(); else wcvShow(v.i + 1); }, 600);
}

async function initWC() {
  if (WC.init) return; WC.init = true;
  try {
    WC.data = await (await fetch("/api/tournament")).json();
  } catch (e) { id("wc-unavailable").style.display = "block"; return; }
  id("wc-main").style.display = "block";
  wcLoadWallet();
  id("wc-advance").onclick = wcAdvance;
  id("wc-reset").onclick = wcReset;
  id("wc-autofill").onclick = wcAutofill;
  id("wc-viewer-close").onclick = () => { wcvStop(); id("wc-viewer").style.display = "none"; };
  id("wcv-start").onclick = () => { wcvStop(); wcvShow(0); };
  id("wcv-prev").onclick = () => { wcvStop(); wcvShow(WC.viewer.i - 1); };
  id("wcv-next").onclick = () => { wcvStop(); wcvShow(WC.viewer.i + 1); };
  id("wcv-end").onclick = () => { wcvStop(); wcvShow(WC.viewer.positions.length - 1); };
  id("wcv-play").onclick = wcvTogglePlay;
  id("wcv-scrub").oninput = e => { wcvStop(); wcvShow(+e.target.value); };
  renderWC();
}

// ---------- boot ----------
function initTabs() {
  document.querySelectorAll("#tabs button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#tabs button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "live") initLive();
      if (btn.dataset.tab === "worldcup") initWC();
    };
  });
}

async function boot() {
  initTabs();
  try {
    DATA = await (await fetch("data/tournament.json")).json();
  } catch (e) {
    document.querySelector("main").innerHTML =
      `<p style="color:var(--red)">Could not load <code>data/tournament.json</code>. Generate it with
      <code>python3 analysis/build_site_data.py ...</code> and serve from the <code>ui/</code> dir.</p>`;
    return;
  }
  document.getElementById("generated").textContent = "data generated " + DATA.generated;
  document.getElementById("reset-wallet").onclick = () => {
    localStorage.removeItem(MKT_KEY); loadMarket(); renderMarkets();
  };
  initBroadcast();
  renderStandings();
  renderBracket();
  renderGates();
  loadMarket();
  renderMarkets();
  initWC();

  // If the live server is up, enable the "Run knockout live" controls.
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg && cfg.available) {
      if (cfg.engines) LIVE.meta = cfg.engines;
      document.getElementById("bracket-live-controls").style.display = "flex";
      document.getElementById("bk-run").onclick = runKnockoutLive;
    }
  } catch (e) { /* static server — no live controls */ }
}
boot();
