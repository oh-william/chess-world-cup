"use strict";
/* board.js — CWC.board.render, CWC.board.material, CWC.san */
(function () {
  const CWC = (window.CWC = window.CWC || {});
  const GLYPH = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  function placement(fen) { return (fen || "").split(" ")[0]; }

  // returns 8x8 array [rank8..rank1][fileA..fileH] of piece chars or null
  function grid(fen) {
    const rows = placement(fen).split("/");
    const g = [];
    for (let r = 0; r < 8; r++) {
      const row = rows[r] || "";
      const line = [];
      for (const ch of row) {
        if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) line.push(null); }
        else line.push(ch);
      }
      while (line.length < 8) line.push(null);
      g.push(line);
    }
    return g;
  }

  CWC.board = {
    render(el, fen, opts) {
      opts = opts || {};
      const lastMove = opts.lastMove || null; // uci string or {from,to}
      const coords = opts.coords !== false;
      const from = lastMove ? (lastMove.from || String(lastMove).slice(0, 2)) : null;
      const to = lastMove ? (lastMove.to || String(lastMove).slice(2, 4)) : null;
      const g = grid(fen);
      el.innerHTML = "";
      el.classList.add("cwc-board");
      const frag = document.createDocumentFragment();
      // Draw rank 8 first (top). grid[0] is rank8.
      for (let ri = 0; ri < 8; ri++) {
        const rankNum = 8 - ri;
        for (let fi = 0; fi < 8; fi++) {
          const ch = g[ri][fi];
          const dark = (ri + fi) % 2 === 1;
          const sqName = "abcdefgh"[fi] + rankNum;
          const c = CWC.el("div", "cwc-sq " + (dark ? "is-dark" : "is-light"));
          c.dataset.sq = sqName;
          if (sqName === from || sqName === to) c.classList.add("is-hl");
          if (ch) {
            const white = ch === ch.toUpperCase();
            const p = CWC.el("span", "cwc-pc " + (white ? "is-w" : "is-b"), GLYPH[ch.toLowerCase()]);
            c.appendChild(p);
          }
          if (coords) {
            if (fi === 0) { const rl = CWC.el("span", "cwc-coord cwc-coord-r", String(rankNum)); c.appendChild(rl); }
            if (ri === 7) { const fl = CWC.el("span", "cwc-coord cwc-coord-f", "abcdefgh"[fi]); c.appendChild(fl); }
          }
          frag.appendChild(c);
        }
      }
      el.appendChild(frag);
    },

    // material balance from a FEN: {white, black, diff, byPiece}
    material(fen) {
      const p = placement(fen);
      let white = 0, black = 0;
      const byPiece = { P: 0, N: 0, B: 0, R: 0, Q: 0, p: 0, n: 0, b: 0, r: 0, q: 0 };
      for (const ch of p) {
        const low = ch.toLowerCase();
        if (!(low in VAL)) continue;
        if (ch in byPiece) byPiece[ch]++;
        if (ch === ch.toUpperCase()) white += VAL[low]; else black += VAL[low];
      }
      return { white, black, diff: white - black, byPiece };
    }
  };

  /* ---------- SAN ---------- */
  // Minimal-but-correct SAN for a single move given the position *before* it.
  // Handles piece letter, captures (incl. en passant/pawn file), castling,
  // promotion, and check/mate suffix. Disambiguation is included when another
  // same-type piece could plausibly reach the target (best-effort by rank/file).
  CWC.san = function (beforeFen, uci) {
    if (!uci || uci.length < 4) return uci || "";
    const g = grid(beforeFen);
    const sideWhite = ((beforeFen || "").split(" ")[1] || "w") === "w";
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.slice(4, 5);
    const at = (sq) => {
      const fi = "abcdefgh".indexOf(sq[0]); const rankNum = +sq[1];
      const ri = 8 - rankNum;
      if (ri < 0 || ri > 7 || fi < 0 || fi > 7) return null;
      return g[ri][fi];
    };
    const piece = at(from);
    if (!piece) return uci;
    const type = piece.toLowerCase();

    // castling
    if (type === "k" && (from === "e1" || from === "e8")) {
      if (to === "g1" || to === "g8") return "O-O";
      if (to === "c1" || to === "c8") return "O-O-O";
    }

    const targetOccupied = !!at(to);
    let capture = targetOccupied;
    // en passant: pawn moving diagonally to empty square
    if (type === "p" && from[0] !== to[0] && !targetOccupied) capture = true;

    let san;
    if (type === "p") {
      san = capture ? from[0] + "x" + to : to;
      if (promo) san += "=" + promo.toUpperCase();
    } else {
      const letter = type.toUpperCase();
      // disambiguation: find other same-side pieces of same type that could move to `to`
      const others = [];
      for (let ri = 0; ri < 8; ri++) for (let fi = 0; fi < 8; fi++) {
        const c = g[ri][fi]; if (!c) continue;
        if (c === piece) {
          const sq = "abcdefgh"[fi] + (8 - ri);
          if (sq !== from && canReach(type, sq, to, g, sideWhite)) others.push(sq);
        }
      }
      let dis = "";
      if (others.length) {
        const sameFile = others.some(s => s[0] === from[0]);
        const sameRank = others.some(s => s[1] === from[1]);
        if (!sameFile) dis = from[0];
        else if (!sameRank) dis = from[1];
        else dis = from;
      }
      san = letter + dis + (capture ? "x" : "") + to;
    }
    return san;
  };

  // Very light "could this piece type reach `to` from `sq`" test for disambiguation.
  // Geometric only (does not verify blockers for sliders beyond a simple ray scan).
  function canReach(type, sq, to, g, sideWhite) {
    const f0 = "abcdefgh".indexOf(sq[0]), r0 = +sq[1];
    const f1 = "abcdefgh".indexOf(to[0]), r1 = +to[1];
    const df = f1 - f0, dr = r1 - r0, af = Math.abs(df), ar = Math.abs(dr);
    if (type === "n") return (af === 1 && ar === 2) || (af === 2 && ar === 1);
    if (type === "k") return af <= 1 && ar <= 1;
    const rayClear = (sf, sr) => {
      let cf = f0 + sf, cr = r0 + sr;
      while (cf !== f1 || cr !== r1) {
        const ri = 8 - cr, fi = cf;
        if (ri < 0 || ri > 7 || fi < 0 || fi > 7) return false;
        if (g[ri][fi]) return false;
        cf += sf; cr += sr;
      }
      return true;
    };
    if (type === "r") { if (df !== 0 && dr !== 0) return false; return rayClear(Math.sign(df), Math.sign(dr)); }
    if (type === "b") { if (af !== ar) return false; return rayClear(Math.sign(df), Math.sign(dr)); }
    if (type === "q") {
      if (df === 0 || dr === 0 || af === ar) return rayClear(Math.sign(df), Math.sign(dr));
      return false;
    }
    return false;
  }
})();
