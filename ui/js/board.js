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

  const SVGNS = "http://www.w3.org/2000/svg";
  const XLINK = "http://www.w3.org/1999/xlink";
  const FILES = "abcdefgh";

  // sprite id for a piece char, e.g. "P" -> "#pc-wP", "n" -> "#pc-bN"
  function spriteId(ch) {
    const white = ch === ch.toUpperCase();
    return "#pc-" + (white ? "w" : "b") + ch.toUpperCase();
  }

  // square name -> {ri, fi} in grid coords (grid[0] == rank8)
  function sqToGrid(sq) {
    const fi = FILES.indexOf(sq[0]);
    const ri = 8 - (+sq[1]);
    return { ri, fi };
  }

  // build a piece node for a char. Uses SVG sprite when available, else glyph span.
  function pieceNode(ch) {
    if (CWC.board._hasSprite) {
      const svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("viewBox", "0 0 45 45");
      svg.setAttribute("class", "cwc-pc");
      const use = document.createElementNS(SVGNS, "use");
      const id = spriteId(ch);
      use.setAttributeNS(XLINK, "href", id);
      use.setAttribute("href", id);
      svg.appendChild(use);
      return svg;
    }
    const white = ch === ch.toUpperCase();
    return CWC.el("span", "cwc-pc cwc-pc-glyph " + (white ? "is-w" : "is-b"), GLYPH[ch.toLowerCase()]);
  }

  // find the king square for a color char ("w"/"b") in a grid
  function findKing(g, white) {
    const target = white ? "K" : "k";
    for (let ri = 0; ri < 8; ri++) for (let fi = 0; fi < 8; fi++) {
      if (g[ri][fi] === target) return FILES[fi] + (8 - ri);
    }
    return null;
  }

  CWC.board = {
    _hasSprite: !!document.getElementById("pc-wK"),

    render(el, fen, opts) {
      opts = opts || {};
      const lastMove = opts.lastMove || null; // uci string or {from,to}
      const coords = opts.coords !== false;
      const orientation = opts.orientation === "black" ? "black" : "white";
      const selected = opts.selected || null;
      const check = opts.check || null;
      const legalTargets = opts.legalTargets || [];
      const legalSet = Object.create(null);
      for (const s of legalTargets) legalSet[s] = true;
      const from = lastMove ? (lastMove.from || String(lastMove).slice(0, 2)) : null;
      const to = lastMove ? (lastMove.to || String(lastMove).slice(2, 4)) : null;
      const g = grid(fen);

      // capture previous FEN for animation decisions before overwriting
      const prevFen = el._cwcPrevFen || null;
      const wantAnim = opts.animate !== false && !CWC.reducedMotion() && prevFen && prevFen !== fen;

      el.innerHTML = "";
      el.classList.add("cwc-board");
      el.classList.toggle("is-flipped", orientation === "black");
      const frag = document.createDocumentFragment();
      const nodeBySq = Object.create(null); // sq -> piece node (for animation)

      // Draw order: white orientation shows rank8 top. Black reverses draw order only;
      // coordinates/highlights stay keyed to true squares.
      const black = orientation === "black";
      for (let dr = 0; dr < 8; dr++) {
        const ri = black ? 7 - dr : dr;      // grid row index actually drawn this step
        const rankNum = 8 - ri;
        for (let dc = 0; dc < 8; dc++) {
          const fi = black ? 7 - dc : dc;
          const ch = g[ri][fi];
          const dark = (ri + fi) % 2 === 1;
          const sqName = FILES[fi] + rankNum;
          const c = CWC.el("div", "cwc-sq " + (dark ? "is-dark" : "is-light"));
          c.dataset.sq = sqName;
          if (sqName === from || sqName === to) c.classList.add("is-hl");
          if (selected && sqName === selected) c.classList.add("is-selected");
          if (check && sqName === check) c.classList.add("is-check");
          if (ch) {
            const p = pieceNode(ch);
            c.appendChild(p);
            nodeBySq[sqName] = p;
          }
          if (legalSet[sqName]) {
            const dot = CWC.el("div", "cwc-target" + (ch ? " is-capture" : ""));
            c.appendChild(dot);
          }
          if (coords) {
            // files on the bottom drawn row, ranks on the left drawn column
            if (dc === 0) { const rl = CWC.el("span", "cwc-coord cwc-coord-r", String(rankNum)); c.appendChild(rl); }
            if (dr === 7) { const fl = CWC.el("span", "cwc-coord cwc-coord-f", FILES[fi]); c.appendChild(fl); }
          }
          frag.appendChild(c);
        }
      }
      el.appendChild(frag);
      el._cwcPrevFen = fen;

      if (wantAnim) {
        try { animateMove(el, prevFen, fen, nodeBySq); }
        catch (e) { /* animation is best-effort; never break the board */ }
      }
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

  /* ---------- move glide animation (FLIP via transient overlay clone) ---------- */
  // Diff prevFen vs newFen to find piece movements/captures, then glide a clone of
  // the moved piece from its old square to its new one. The real destination piece
  // is hidden until the glide's transitionend. Handles capture, castling, promotion,
  // en passant. Best-effort; any exception is swallowed by the caller.
  function animateMove(el, prevFen, newFen, nodeBySq) {
    const before = grid(prevFen);
    const after = grid(newFen);

    // classify every square: what was there before, what is there now
    const beforeMap = Object.create(null); // sq -> char
    const afterMap = Object.create(null);
    for (let ri = 0; ri < 8; ri++) for (let fi = 0; fi < 8; fi++) {
      const sq = FILES[fi] + (8 - ri);
      if (before[ri][fi]) beforeMap[sq] = before[ri][fi];
      if (after[ri][fi]) afterMap[sq] = after[ri][fi];
    }

    // squares that emptied (piece left) and squares that gained/changed a piece
    const vacated = [];   // {sq, ch}
    const arrived = [];   // {sq, ch}
    for (const sq in beforeMap) {
      if (afterMap[sq] !== beforeMap[sq]) vacated.push({ sq, ch: beforeMap[sq] });
    }
    for (const sq in afterMap) {
      if (beforeMap[sq] !== afterMap[sq]) arrived.push({ sq, ch: afterMap[sq] });
    }
    if (!arrived.length) return;

    const rect = el.getBoundingClientRect();
    const cell = rect.width / 8; // square size (board is 1:1)

    // pair each arrival with the best-matching vacated source of a compatible piece.
    // Promotion: a pawn vacates, a non-pawn (or same-color piece) arrives on last rank.
    const usedVacated = Object.create(null);
    const glides = []; // {fromSq, toSq, ch}
    for (const a of arrived) {
      const arrColor = a.ch === a.ch.toUpperCase();
      // prefer a vacated square of the same color; for promotion match a vacated pawn.
      let best = null, bestDist = Infinity;
      for (let i = 0; i < vacated.length; i++) {
        if (usedVacated[i]) continue;
        const v = vacated[i];
        const vColor = v.ch === v.ch.toUpperCase();
        if (vColor !== arrColor) continue; // captures handled as fades, not glides
        const isSame = v.ch === a.ch;
        const isPromo = v.ch.toUpperCase() === "P" && a.ch.toUpperCase() !== "P";
        if (!isSame && !isPromo) continue;
        const va = sqToGrid(v.sq), ab = sqToGrid(a.sq);
        const dist = Math.abs(va.ri - ab.ri) + Math.abs(va.fi - ab.fi);
        // prefer exact-piece matches, then nearest
        const score = dist + (isSame ? 0 : 0.5);
        if (score < bestDist) { bestDist = score; best = i; }
      }
      if (best != null) {
        usedVacated[best] = true;
        glides.push({ fromSq: vacated[best].sq, toSq: a.sq, ch: a.ch });
      }
    }
    if (!glides.length) return;

    // any vacated square not consumed by a glide and now empty = captured/en-passant pawn.
    // Fade those out under the glide.
    for (let i = 0; i < vacated.length; i++) {
      if (usedVacated[i]) continue;
      const v = vacated[i];
      if (afterMap[v.sq]) continue; // still occupied (already animated as destination)
      const node = nodeBySq[v.sq];
      // the captured piece is gone from the new grid; recreate a ghost to fade
      const ghost = pieceNode(v.ch);
      ghost.classList.add("cwc-fade-out");
      const g = sqToGrid(v.sq);
      placeOverlay(el, ghost, g, cell, orientationOf(el));
      requestAnimationFrame(() => { ghost.style.opacity = "0"; });
      ghost.addEventListener("transitionend", () => ghost.remove(), { once: true });
      setTimeout(() => { if (ghost.parentNode) ghost.remove(); }, 400);
    }

    const orient = orientationOf(el);
    for (const mv of glides) {
      const destNode = nodeBySq[mv.toSq];
      const fg = sqToGrid(mv.fromSq), tg = sqToGrid(mv.toSq);
      const clone = pieceNode(mv.ch);
      clone.classList.add("cwc-glide");
      placeOverlay(el, clone, fg, cell, orient);
      if (destNode) destNode.style.visibility = "hidden";
      // start position set; on next frame translate to destination
      const dx = (orient === "black" ? (fg.fi - tg.fi) : (tg.fi - fg.fi)) * cell;
      const dy = (orient === "black" ? (fg.ri - tg.ri) : (tg.ri - fg.ri)) * cell;
      // note: overlay is placed at the FROM square; we translate by delta to the TO square
      requestAnimationFrame(() => {
        clone.style.transform = "translate(" + dx + "px," + dy + "px)";
      });
      const done = () => {
        if (destNode) destNode.style.visibility = "";
        if (clone.parentNode) clone.remove();
      };
      clone.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 400); // safety net
    }
  }

  function orientationOf(el) {
    return el.classList.contains("is-flipped") ? "black" : "white";
  }

  // absolutely position an overlay node over the board square at grid coords {ri,fi}
  function placeOverlay(el, node, gcoord, cell, orient) {
    // visual column/row depend on orientation (draw order reversal)
    const vc = orient === "black" ? 7 - gcoord.fi : gcoord.fi;
    const vr = orient === "black" ? 7 - gcoord.ri : gcoord.ri;
    node.classList.add("cwc-overlay");
    node.style.position = "absolute";
    node.style.left = (vc * cell) + "px";
    node.style.top = (vr * cell) + "px";
    node.style.width = cell + "px";
    node.style.height = cell + "px";
    el.appendChild(node);
  }

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
