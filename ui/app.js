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
function renderBoard(fen, uci) {
  const board = document.getElementById("board");
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

// ---------- boot ----------
function initTabs() {
  document.querySelectorAll("#tabs button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#tabs button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
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
  renderGates();
  loadMarket();
  renderMarkets();
}
boot();
