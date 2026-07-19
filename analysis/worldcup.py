#!/usr/bin/env python3
"""World Cup tournament engine — 48 engine-backed teams, played on demand.

Format (2026 World Cup): 12 groups of 4; win 3 / draw 1 / loss 0; top two of each
group plus the 8 best third-placed teams advance to a Round of 32 knockout.
Tiebreakers: points, then piece-difference (captured − lost), pieces captured,
wins, then fewer moves. Matches are single games at a fixed node budget and are
run one at a time when the user asks — nothing auto-plays.

Used by ui/live_server.py; state persists to runs/worldcup.json.
"""
import json
import math
import os
import subprocess
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import sys
sys.path.insert(0, os.path.join(ROOT, "shim", "py"))
from libchess_ffi import Board  # noqa: E402

STATE_FILE = os.path.join(ROOT, "runs", "worldcup.json")
DATA_FILE = os.path.join(ROOT, "analysis", "data", "wc2026.json")
GROUP_BUDGET = 6000
KO_BUDGET = 10000

# --- FIFA-strength model ---------------------------------------------------
# A team's chess strength (Elo-like rating) is derived from its FIFA ranking
# points; node budget is derived from rating. Engine/language is only a
# cosmetic "flavour" assigned by pot — it does NOT drive strength.
RATING_A = 1650.0     # rating of a 1550-point FIFA side
RATING_B = 0.44       # rating gained per FIFA point over 1550 (tuned so the most
                      # extreme mismatch, e.g. Spain vs Haiti, is ~75-80%, not ~88%)
NODE_ANCHOR = 1770    # rating that maps to NODE_BASE nodes
NODE_BASE = 6000
NODE_SLOPE = 120      # rating points per doubling of node budget
STATE_VERSION = 2     # bump to force a clean rebuild of persisted state

GROUP_LETTERS = "ABCDEFGHIJKL"

# Per-stage "think time": a multiplier on each team's FIFA-derived base node
# budget. Later rounds think longer -> deeper, higher-quality games. Runtime-
# configurable via get_config()/set_config() and the UI settings panel.
STAGE_ORDER = ["group", "Round of 32", "Round of 16", "Quarterfinals",
               "Semifinals", "Final"]
STAGE_MULT = {"group": 1.0, "Round of 32": 1.5, "Round of 16": 2.0,
              "Quarterfinals": 2.5, "Semifinals": 3.0, "Final": 4.0}

# language "flavour" by pot (cycles deterministically; rating is independent
# of engine). Pot 1 gets the strongest search engines, pot 4 the weakest.
POT_ENGINES = {
    1: ["cpp-alphabeta", "rs-alphabeta", "js-alphabeta", "py-alphabeta"],
    2: ["cpp-alphabeta", "rs-alphabeta", "js-alphabeta", "py-mcts"],
    3: ["js-alphabeta", "py-mcts", "py-minimax", "cpp-greedy"],
    4: ["py-minimax", "cpp-greedy", "py-greedy", "random"],
}


def _rating_of(fifa):
    return RATING_A + RATING_B * (fifa - 1550)


def _nodes_of(rating):
    return max(1500, min(60000,
                         round(NODE_BASE * 2 ** ((rating - NODE_ANCHOR) / NODE_SLOPE) / 500) * 500))

ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "js-alphabeta":  [os.path.join(ROOT, "bots", "js-alphabeta", "js-alphabeta")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
    "py-minimax":    [os.path.join(ROOT, "bots", "py-minimax", "py-minimax")],
}
ENGINE_LANG = {"cpp-alphabeta": "C++", "rs-alphabeta": "Rust", "js-alphabeta": "JavaScript",
               "py-alphabeta": "Python", "py-mcts": "Python", "cpp-greedy": "C++",
               "py-greedy": "Python", "random": "C++", "py-minimax": "Python"}
ENGINE_RATING = {"cpp-alphabeta": 1820, "rs-alphabeta": 1810, "js-alphabeta": 1800,
                 "py-alphabeta": 1790, "py-mcts": 1450, "py-minimax": 1300,
                 "random": 1150, "cpp-greedy": 1080, "py-greedy": 1070}

# Rich profiles for the About page — each engine's language, algorithm, the
# techniques it uses, an honest strength note, and a bit of flair.
ENGINE_INFO = {
    "cpp-alphabeta": {"nick": "The Machine", "lang": "C++", "algorithm": "Alpha-Beta",
        "reuse": "native", "strength": 4,
        "techniques": ["iterative deepening", "quiescence search", "MVV-LVA ordering",
                       "handcrafted eval (material + piece-square tables)"],
        "blurb": "Classical alpha-beta minimax with pruning, compiled straight to the "
                 "metal. The speed pole of the field: whatever the algorithm can do per "
                 "node, C++ does it fastest."},
    "rs-alphabeta": {"nick": "The Engineer", "lang": "Rust", "algorithm": "Alpha-Beta",
        "reuse": "C-ABI FFI", "strength": 4,
        "techniques": ["identical search to cpp-alphabeta", "native FFI to libchess",
                       "memory-safe, zero-cost abstractions"],
        "blurb": "The exact same alpha-beta, written in Rust and calling the C core over "
                 "FFI. Memory-safe and within a hair of C++ speed — proof the tax is about "
                 "the language runtime, not the algorithm."},
    "js-alphabeta": {"nick": "The Upstart", "lang": "JavaScript", "algorithm": "Alpha-Beta",
        "reuse": "WebAssembly", "strength": 3,
        "techniques": ["same alpha-beta in Node.js", "movegen compiled to WASM",
                       "JIT-compiled search loop"],
        "blurb": "Alpha-beta in Node.js, with the perft-clean movegen compiled to "
                 "WebAssembly. The hot path runs in WASM, so the web platform hangs "
                 "surprisingly close to the compiled pack."},
    "py-alphabeta": {"nick": "The Purist", "lang": "Python", "algorithm": "Alpha-Beta",
        "reuse": "ctypes FFI", "strength": 3,
        "techniques": ["same alpha-beta in pure Python", "ctypes calls into libchess",
                       "readable, ~120 lines"],
        "blurb": "The same search again, in clean idiomatic Python via ctypes. Elegant and "
                 "easy to read — and it pays the full interpreter tax, ~20-30x fewer "
                 "nodes/sec than C++. The headline of the whole experiment."},
    "py-mcts": {"nick": "The Gambler", "lang": "Python", "algorithm": "Monte-Carlo Tree Search",
        "reuse": "ctypes FFI", "strength": 2,
        "techniques": ["UCT selection (exploration vs exploitation)", "tree expansion",
                       "eval-guided playouts", "no brute-force minimax"],
        "blurb": "A completely different paradigm: instead of exhaustively pruning a tree, "
                 "it grows one by sampling promising lines (UCT) and backing up the "
                 "results. The knowledge pole — it must win on Elo-per-node, not raw speed."},
    "py-minimax": {"nick": "The Naive", "lang": "Python", "algorithm": "Minimax (no pruning)",
        "reuse": "ctypes FFI", "strength": 1,
        "techniques": ["plain minimax to fixed depth", "NO alpha-beta pruning",
                       "visits every node"],
        "blurb": "Textbook minimax with the pruning switched OFF — it dutifully visits "
                 "every branch to its depth. It exists to show why alpha-beta matters: the "
                 "same move, at a fraction of the work, once you prune."},
    "cpp-greedy": {"nick": "The Brute", "lang": "C++", "algorithm": "Depth-1 Greedy",
        "reuse": "native", "strength": 1,
        "techniques": ["evaluate every reply", "grab the best-eval move", "no lookahead"],
        "blurb": "One ply deep: it plays whatever move maximises the eval right now, with "
                 "zero foresight. Fast, shallow, and easily out-planned — but it'll punish "
                 "a free piece instantly."},
    "py-greedy": {"nick": "The Impatient", "lang": "Python", "algorithm": "Depth-1 Greedy",
        "reuse": "ctypes FFI", "strength": 1,
        "techniques": ["same greedy rule in Python", "one-ply eval scan"],
        "blurb": "Depth-1 greedy, Python edition. The lightest search there is short of "
                 "not searching at all."},
    "random": {"nick": "The Wildcard", "lang": "C++", "algorithm": "Uniform Random",
        "reuse": "native", "strength": 0,
        "techniques": ["pick a uniform-random legal move", "seeded RNG"],
        "blurb": "No evaluation, no search — a uniform-random legal move. The Elo anchor of "
                 "the tournament and the protocol canary: if anything speaks UCI, it's this."},
    "cpp-analyst": {"nick": "The Oracle", "lang": "C++", "algorithm": "Alpha-Beta + TT + PVS",
        "reuse": "native", "strength": 5, "role": "analysis",
        "techniques": ["transposition table (Zobrist)", "principal variation search",
                       "killer + history heuristics", "iterative deepening + quiescence"],
        "blurb": "Not a competitor — the reference analyst. It runs the strongest search in "
                 "the project (alpha-beta with a transposition table and PVS) at a high "
                 "budget, so its evaluation and best line are the ground truth used to "
                 "annotate every game in the Watch view."},
}
# 48 slots: 16 alpha-beta (strong), 8 mcts, 8 random, 16 greedy (spread across pots).
SLOT_ENGINES = (["cpp-alphabeta", "rs-alphabeta", "js-alphabeta", "py-alphabeta"] * 4
                + ["py-mcts"] * 8 + ["random"] * 8
                + ["cpp-greedy"] * 8 + ["py-greedy"] * 8)
COUNTRIES = ["BR", "AR", "FR", "DE", "ES", "PT", "NL", "IT", "GB", "BE", "HR", "MA",
             "JP", "KR", "US", "MX", "CA", "AU", "SN", "GH", "CM", "NG", "EG", "PL",
             "DK", "CH", "RS", "UY", "CO", "EC", "QA", "IR", "SA", "TN", "CR", "JM",
             "PE", "CL", "SE", "NO", "GR", "TR", "UA", "CZ", "AT", "SK", "HU", "RO"]


def bracket_positions(n):
    order = [1, 2]
    while len(order) < n:
        m = len(order) * 2
        order = [x for s in order for x in (s, m + 1 - s)]
    return order


class WorldCup:
    def __init__(self, state=None):
        self.s = state or {}

    # ---------- historical implied odds ----------
    @staticmethod
    def _load_history():
        hist = defaultdict(lambda: {"w": 0, "d": 0, "l": 0})  # (a,b) a's record vs b
        runs = os.path.join(ROOT, "runs")
        for fn in os.listdir(runs) if os.path.isdir(runs) else []:
            if not fn.endswith(".jsonl"):
                continue
            try:
                for line in open(os.path.join(runs, fn)):
                    line = line.strip()
                    if not line:
                        continue
                    r = json.loads(line)
                    if r.get("type") != "result":
                        continue
                    w, b = r["white"], r["black"]
                    if r["result"] == "1-0":
                        hist[(w, b)]["w"] += 1; hist[(b, w)]["l"] += 1
                    elif r["result"] == "0-1":
                        hist[(w, b)]["l"] += 1; hist[(b, w)]["w"] += 1
                    else:
                        hist[(w, b)]["d"] += 1; hist[(b, w)]["d"] += 1
            except Exception:
                pass
        return hist

    @staticmethod
    def _as_rating(x):
        """Accept a numeric rating directly, or an engine name (legacy betting
        API), and return a rating. Team ratings drive the World Cup; the
        engine->rating map only backs the standalone /api/odds engine matrix."""
        if isinstance(x, (int, float)):
            return float(x)
        return float(ENGINE_RATING[x])

    def odds(self, ra, rb):
        """Implied (win, draw, loss) probabilities from two ratings.

        `ra`/`rb` may be numeric ratings (the World Cup path) or engine names
        (the legacy engine-matrix betting API). The empirical-history override
        was removed: history is keyed by engine, but two real teams can share
        an engine flavour at very different ratings, so it no longer applies."""
        ra, rb = self._as_rating(ra), self._as_rating(rb)
        exp = 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
        pdraw = 0.35 * math.exp(-((ra - rb) / 220.0) ** 2)
        pw = max(0.02, exp - pdraw / 2)
        pl = max(0.02, (1 - exp) - pdraw / 2)
        tot = pw + pdraw + pl
        return [pw / tot, pdraw / tot, pl / tot]

    # ---------- the draw ----------
    @staticmethod
    def _load_draw():
        with open(DATA_FILE) as f:
            return json.load(f)["groups"]

    def new(self, seed=None, real=True):
        """Build the REAL 2026 World Cup: 48 teams in the drawn groups A-L.

        `new(real=True)` with `seed=None` reproduces the real draw exactly.
        With a random seed it performs a **new draw**: teams are reshuffled
        *within each pot* across the 12 groups (the same 48 real teams, new
        group assignments). NOTE: the UEFA "max two from a confederation per
        group" constraint is intentionally dropped for this casual reshuffle."""
        import random
        rng = random.Random(seed)
        draw = self._load_draw()

        # Collect the four pots across all groups, preserving group letters.
        pot_members = {1: [], 2: [], 3: [], 4: []}  # pot -> [(name,code,pot,fifa)]
        group_slots = {}  # letter -> list of pots (order in the json)
        for letter in GROUP_LETTERS:
            group_slots[letter] = []
            for entry in draw[letter]:
                name, code, pot, fifa = entry
                pot_members[pot].append((name, code, pot, fifa))
                group_slots[letter].append(pot)

        # A "new draw": reshuffle each pot, then deal one team per pot per group.
        if seed is not None:
            for p in pot_members.values():
                rng.shuffle(p)
        cursor = {1: 0, 2: 0, 3: 0, 4: 0}
        group_teams = {letter: [] for letter in GROUP_LETTERS}  # letter -> entries
        for letter in GROUP_LETTERS:
            for pot in group_slots[letter]:
                group_teams[letter].append(pot_members[pot][cursor[pot]])
                cursor[pot] += 1

        # Assign a cosmetic engine per team by cycling POT_ENGINES[pot]
        # deterministically across the pot's teams (in draw/deal order).
        pot_engine_idx = {1: 0, 2: 0, 3: 0, 4: 0}
        teams = []
        groups = []  # numeric group index -> list of team ids
        tid = 0
        for gi, letter in enumerate(GROUP_LETTERS):
            member_ids = []
            for (name, code, pot, fifa) in group_teams[letter]:
                pe = POT_ENGINES[pot]
                eng = pe[pot_engine_idx[pot] % len(pe)]
                pot_engine_idx[pot] += 1
                rating = _rating_of(fifa)
                teams.append({
                    "id": tid, "name": name, "code": code, "country": code,
                    "group": letter, "pot": pot, "fifa_points": fifa,
                    "engine": eng, "lang": ENGINE_LANG[eng],
                    "rating": rating, "nodes": _nodes_of(rating),
                })
                member_ids.append(tid)
                tid += 1
            groups.append(member_ids)

        fixtures = []
        pair_order = [(0, 1), (2, 3), (0, 2), (1, 3), (0, 3), (1, 2)]
        for g, members in enumerate(groups):
            for mi, (x, y) in enumerate(pair_order):
                fixtures.append({"id": f"G{g}M{mi}", "stage": "group", "group": g,
                                 "a": members[x], "b": members[y], "played": False})
        self.s = {"id": os.urandom(4).hex(), "v": STATE_VERSION,
                  "teams": teams, "groups": groups, "fixtures": fixtures,
                  "stage": "group", "knockout": [], "champion": None,
                  "stage_mult": dict(STAGE_MULT)}
        self._hist = self._load_history()
        return self

    def get_config(self):
        """Per-stage think-time multipliers (approx. nodes at the average team)."""
        sm = self.s.get("stage_mult", dict(STAGE_MULT))
        base = _nodes_of(_rating_of(1600))  # a mid-table side's base budget
        return {"stages": STAGE_ORDER,
                "stage_mult": {k: sm.get(k, STAGE_MULT[k]) for k in STAGE_ORDER},
                "approx_nodes": {k: int(base * sm.get(k, STAGE_MULT[k])) for k in STAGE_ORDER}}

    def get_engines(self):
        """Engine profiles for the About page, enriched with which teams each backs."""
        by_engine = {}
        for t in self.s.get("teams", []):
            by_engine.setdefault(t["engine"], []).append({"name": t["name"], "code": t["code"]})
        out = []
        for name, info in ENGINE_INFO.items():
            e = dict(info); e["name"] = name
            e["teams"] = by_engine.get(name, [])
            e["team_count"] = len(e["teams"])
            out.append(e)
        return {"engines": out}

    def set_config(self, cfg):
        sm = self.s.setdefault("stage_mult", dict(STAGE_MULT))
        for k, v in (cfg.get("stage_mult") or {}).items():
            if k in STAGE_MULT:
                try:
                    sm[k] = max(0.25, min(20.0, float(v)))
                except (TypeError, ValueError):
                    pass
        return self.get_config()

    # ---------- play a match ----------
    def _run_game(self, ea, eb, nodes1, nodes2, seed1, seed2):
        tmp = os.path.join(ROOT, "runs", "_wc_tmp.jsonl")
        argv = [os.path.join(ROOT, "build", "orchestrator"),
                "--engine1"] + ENGINES[ea] + ["--engine2"] + ENGINES[eb] + [
                "--games", "1", "--nodes1", str(int(nodes1)), "--nodes2", str(int(nodes2)),
                "--log", tmp, "--warmup-ms", "0",
                "--seed1", str(seed1), "--seed2", str(seed2)]
        subprocess.run(argv, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        moves, result = [], None
        for line in open(tmp):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("type") == "result":
                result = r
            else:
                moves.append(r)
        os.remove(tmp)
        # Reconstruct positions + final board to count captured pieces.
        positions = [m["fen"] for m in moves]
        b = Board()
        if moves:
            b.set_fen(moves[-1]["fen"])
            mv = b.move_from_uci(moves[-1]["move"])
            if mv:
                b.make(mv)
            positions.append(b.fen())
        final = positions[-1] if positions else b.fen()
        wcnt, bcnt = _count_pieces(final)
        return {
            "result": result["result"] if result else "1/2-1/2",
            "reason": result["reason"] if result else "?",
            "plies": result["plies"] if result else len(moves),
            "white_captured": 16 - bcnt, "black_captured": 16 - wcnt,
            "moves": [{"uci": m["move"], "fen": m["fen"], "engine": m.get("engine"),
                       "color": m.get("color"), "orch_ms": m.get("orch_ms"),
                       "self_ms": m.get("self_ms"), "delta_ms": m.get("delta_ms"),
                       "self_nodes": m.get("self_nodes")} for m in moves],
            "positions": positions,
        }

    def play(self, match_id):
        m = self._find(match_id)
        if not m or m.get("played"):
            return m
        ta, tb = self._team(m["a"]), self._team(m["b"])
        # Each side plays at its own FIFA-derived node budget, scaled by the
        # configurable per-stage think-time multiplier (later rounds go deeper).
        stage_key = "group" if m["stage"] == "group" else m.get("round", "Round of 32")
        scale = self.s.get("stage_mult", STAGE_MULT).get(stage_key, 1.0)
        n1 = ta["nodes"] * scale
        n2 = tb["nodes"] * scale
        g = self._run_game(ta["engine"], tb["engine"], n1, n2,
                           1000 + m["a"], 2000 + m["b"])
        # a = white, b = black.
        if g["result"] == "1-0":
            winner = m["a"]
        elif g["result"] == "0-1":
            winner = m["b"]
        else:
            winner = None
        if m["stage"] == "knockout" and winner is None:  # decide the tie ("penalties")
            if g["white_captured"] != g["black_captured"]:
                winner = m["a"] if g["white_captured"] > g["black_captured"] else m["b"]
            else:
                winner = m["a"] if m.get("seedA", 99) < m.get("seedB", 99) else m["b"]
            m["tiebreak"] = "penalties"
        m.update({"played": True, "result": g["result"], "reason": g["reason"],
                  "plies": g["plies"], "winner": winner,
                  "capA": g["white_captured"], "capB": g["black_captured"],
                  "game": {"moves": g["moves"], "positions": g["positions"]}})
        if m["stage"] == "knockout":
            self._maybe_advance_knockout()
        return m

    # ---------- standings ----------
    def group_table(self, g):
        rows = {tid: {"team": tid, "P": 0, "W": 0, "D": 0, "L": 0, "pts": 0,
                      "cf": 0, "ca": 0, "plies": 0} for tid in self.s["groups"][g]}
        for m in self.s["fixtures"]:
            if m["group"] != g or not m["played"]:
                continue
            a, b = rows[m["a"]], rows[m["b"]]
            a["P"] += 1; b["P"] += 1
            a["cf"] += m["capA"]; a["ca"] += m["capB"]
            b["cf"] += m["capB"]; b["ca"] += m["capA"]
            a["plies"] += m["plies"]; b["plies"] += m["plies"]
            if m["winner"] == m["a"]:
                a["W"] += 1; a["pts"] += 3; b["L"] += 1
            elif m["winner"] == m["b"]:
                b["W"] += 1; b["pts"] += 3; a["L"] += 1
            else:
                a["D"] += 1; b["D"] += 1; a["pts"] += 1; b["pts"] += 1
        ordered = sorted(rows.values(), key=self._rank_key, reverse=True)
        return ordered

    @staticmethod
    def _rank_key(r):
        # points, piece-difference, pieces-for, wins, fewer plies (negated).
        return (r["pts"], r["cf"] - r["ca"], r["cf"], r["W"], -r["plies"])

    def group_stage_done(self):
        return all(m["played"] for m in self.s["fixtures"])

    # ---------- qualification + knockout ----------
    def advance(self):
        if self.s["stage"] != "group" or not self.group_stage_done():
            return
        winners, runners, thirds = [], [], []
        for g in range(12):
            t = self.group_table(g)
            winners.append((t[0], g)); runners.append((t[1], g)); thirds.append((t[2], g))
        thirds.sort(key=lambda x: self._rank_key(x[0]), reverse=True)
        best_thirds = thirds[:8]
        # Seed 1..32: winners (by strength), then runners-up, then best thirds.
        winners.sort(key=lambda x: self._rank_key(x[0]), reverse=True)
        runners.sort(key=lambda x: self._rank_key(x[0]), reverse=True)
        seeded = [x[0]["team"] for x in winners] + [x[0]["team"] for x in runners] \
            + [x[0]["team"] for x in best_thirds]
        seed_of = {tid: i + 1 for i, tid in enumerate(seeded)}
        order = bracket_positions(32)
        slots = [seeded[s - 1] for s in order]
        self.s["seed_of"] = seed_of
        self.s["knockout"] = [self._make_round(slots, "Round of 32")]
        self.s["stage"] = "knockout"

    def _make_round(self, teams, name):
        ties = []
        # Tie ids must be globally unique across rounds. Keying by round size
        # (32/16/8/4/2) avoids the collision where "Round of 32" and "Round of
        # 16" both started with "R" and produced duplicate ids like "KR0".
        rsize = len(teams)
        for i in range(0, len(teams), 2):
            a, b = teams[i], teams[i + 1]
            ties.append({"id": f"K{rsize}_{i}", "stage": "knockout", "round": name,
                         "group": -1, "a": a, "b": b,
                         "seedA": self.s["seed_of"].get(a), "seedB": self.s["seed_of"].get(b),
                         "played": False})
        return {"name": name, "ties": ties}

    def _maybe_advance_knockout(self):
        ko = self.s["knockout"]
        cur = ko[-1]
        if not all(t["played"] for t in cur["ties"]):
            return
        winners = [t["winner"] for t in cur["ties"]]
        names = {16: "Round of 32", 8: "Round of 16", 4: "Quarterfinals",
                 2: "Semifinals", 1: "Final"}
        if len(winners) == 1:
            self.s["champion"] = winners[0]
            self.s["stage"] = "done"
            return
        ko.append(self._make_round(winners, names.get(len(winners) // 2, "Round")))

    # ---------- helpers / serialization ----------
    def _find(self, mid):
        for m in self.s["fixtures"]:
            if m["id"] == mid:
                return m
        for rnd in self.s.get("knockout", []):
            for t in rnd["ties"]:
                if t["id"] == mid:
                    return t
        return None

    def _team(self, tid):
        return self.s["teams"][tid]

    def public_match(self, m, with_odds=True):
        out = {k: m[k] for k in ("id", "stage", "group", "a", "b", "played") if k in m}
        for k in ("result", "reason", "plies", "winner", "capA", "capB", "round",
                  "seedA", "seedB", "tiebreak"):
            if k in m:
                out[k] = m[k]
        out["hasGame"] = "game" in m
        if with_odds and not m.get("played"):
            out["odds"] = self.odds(self._team(m["a"])["rating"], self._team(m["b"])["rating"])
        return out

    def public_state(self):
        return {
            "id": self.s.get("id"),
            "stage": self.s["stage"],
            "champion": self.s.get("champion"),
            "teams": self.s["teams"],
            "groups": [{"index": g, "table": self.group_table(g)} for g in range(12)],
            "fixtures": [self.public_match(m) for m in self.s["fixtures"]],
            "group_done": self.group_stage_done(),
            "knockout": [{"name": r["name"], "ties": [self.public_match(t) for t in r["ties"]]}
                         for r in self.s.get("knockout", [])],
        }

    def game_of(self, mid):
        m = self._find(mid)
        return m.get("game") if m else None

    # ---------- WS3 additive: unified betting model ----------
    # The 8 distinct engines that back the 48 teams. Odds/contracts/sim all
    # derive from self.odds(), the single probability model.
    _MODEL_ENGINES = ["cpp-alphabeta", "rs-alphabeta", "js-alphabeta",
                      "py-alphabeta", "py-mcts", "random", "cpp-greedy", "py-greedy"]

    def odds_matrix(self):
        """Pairwise [w,d,l] for every ordered engine pair (static bake + /api/odds)."""
        out = {}
        for a in self._MODEL_ENGINES:
            out[a] = {}
            for b in self._MODEL_ENGINES:
                if a == b:
                    continue
                out[a][b] = self.odds(a, b)
        return out

    def odds_detail(self, ea, eb):
        """odds() plus provenance: {w,d,l,n,source}."""
        h = self._hist.get((ea, eb), {"w": 0, "d": 0, "l": 0})
        n = h["w"] + h["d"] + h["l"]
        w, d, l = self.odds(ea, eb)
        # The empirical-history override was removed; odds are always Elo-based
        # from ratings now. `n` is retained for informational display only.
        return {"w": w, "d": d, "l": l, "n": n, "source": "elo"}

    # --- Monte-Carlo simulation of the rest of the tournament ---
    def _win_prob(self, ta, tb):
        """P(team a beats team b) as a single knockout outcome, draw split by seed
        proxy: use win/(win+loss) normalised, draws resolved to the stronger side."""
        w, d, l = self.odds(self._team(ta)["rating"], self._team(tb)["rating"])
        # In knockouts a draw is decided; give the draw mass to the a-vs-b
        # win/loss split proportionally (a coin weighted by relative strength).
        denom = w + l
        base = w / denom if denom > 1e-9 else 0.5
        return w + d * base

    def simulate(self, n=2000, seed=None):
        """Monte-Carlo the REST of the tournament using odds() draws only (no engine
        games). Returns per-team champion probability. Runs in ~ms."""
        import random
        rng = random.Random(seed)
        stage = self.s.get("stage")
        champ = {t["id"]: 0 for t in self.s["teams"]}

        if stage == "done" and self.s.get("champion") is not None:
            champ[self.s["champion"]] = n
            return self._sim_result(champ, n)

        # Build the current knockout bracket as a flat list of remaining slots.
        # If we are still in the group stage, project group qualification first
        # via a cheap points Monte-Carlo, then run the knockout.
        for _ in range(n):
            if stage == "knockout":
                bracket = self._current_ko_slots(rng)
            else:
                bracket = self._project_group_qualifiers(rng)
            winner = self._sim_bracket(bracket, rng)
            if winner is not None:
                champ[winner] += 1
        return self._sim_result(champ, n)

    def _sim_result(self, champ, n):
        rows = []
        for t in self.s["teams"]:
            rows.append({"team": t["id"], "country": t.get("country"),
                         "engine": t["engine"], "name": t.get("name"),
                         "champion_pct": (champ.get(t["id"], 0) / n) if n else 0.0})
        rows.sort(key=lambda r: r["champion_pct"], reverse=True)
        return {"teams": rows, "n": n}

    def _current_ko_slots(self, rng):
        """Return the remaining-to-play bracket as an ordered list of team ids,
        collapsing already-played ties to their winners."""
        ko = self.s.get("knockout", [])
        if not ko:
            return []
        cur = ko[-1]
        slots = []
        for t in cur["ties"]:
            if t.get("played"):
                slots.append(t["winner"])
            else:
                # both sides still alive; simulate this tie during _sim_bracket
                slots.append(("tie", t["a"], t["b"]))
        return slots

    def _project_group_qualifiers(self, rng):
        """Cheap projection: simulate remaining group fixtures, then re-seed a
        Round-of-32 bracket, returning an ordered list of team ids."""
        pts = {t["id"]: 0.0 for t in self.s["teams"]}
        cf = {t["id"]: 0.0 for t in self.s["teams"]}
        for m in self.s["fixtures"]:
            a, b = m["a"], m["b"]
            if m.get("played"):
                if m["winner"] == a:
                    pts[a] += 3
                elif m["winner"] == b:
                    pts[b] += 3
                else:
                    pts[a] += 1; pts[b] += 1
                cf[a] += m.get("capA", 0) - m.get("capB", 0)
                cf[b] += m.get("capB", 0) - m.get("capA", 0)
            else:
                w, d, l = self.odds(self._team(a)["rating"], self._team(b)["rating"])
                r = rng.random()
                if r < w:
                    pts[a] += 3; cf[a] += 2; cf[b] -= 2
                elif r < w + d:
                    pts[a] += 1; pts[b] += 1
                else:
                    pts[b] += 3; cf[b] += 2; cf[a] -= 2
        # rank each group, take top 2 + best 8 thirds
        winners, runners, thirds = [], [], []
        for g in range(12):
            members = self.s["groups"][g]
            ranked = sorted(members, key=lambda tid: (pts[tid], cf[tid], rng.random()),
                            reverse=True)
            winners.append(ranked[0]); runners.append(ranked[1]); thirds.append(ranked[2])
        thirds.sort(key=lambda tid: (pts[tid], cf[tid]), reverse=True)
        winners.sort(key=lambda tid: (pts[tid], cf[tid]), reverse=True)
        runners.sort(key=lambda tid: (pts[tid], cf[tid]), reverse=True)
        seeded = winners + runners + thirds[:8]
        order = bracket_positions(32)
        return [seeded[s - 1] for s in order]

    def _sim_bracket(self, slots, rng):
        """Play down a bracket (list of ids or ('tie',a,b) tuples) to a champion."""
        cur = []
        for s in slots:
            if isinstance(s, tuple):  # unplayed current tie
                _, a, b = s
                cur.append(a if rng.random() < self._win_prob(a, b) else b)
            else:
                cur.append(s)
        while len(cur) > 1:
            nxt = []
            for i in range(0, len(cur), 2):
                a, b = cur[i], cur[i + 1]
                nxt.append(a if rng.random() < self._win_prob(a, b) else b)
            cur = nxt
        return cur[0] if cur else None

    # --- event contracts derived from live tournament state ---
    def contracts(self):
        """Derive event contracts from live state. Open contracts carry NO
        `outcome`; resolved ones do. `p0` is the model opening probability."""
        out = []
        sim = self.simulate(n=1500, seed=7)
        champ_pct = {r["team"]: r["champion_pct"] for r in sim["teams"]}
        teams = self.s["teams"]
        by_id = {t["id"]: t for t in teams}
        stage = self.s.get("stage")
        champion = self.s.get("champion")

        def lang_of(tid):
            return self._team(tid)["engine"] and ENGINE_LANG[self._team(tid)["engine"]]

        # --- reachability sets from the current bracket ---
        alive = None
        if stage == "knockout":
            ko = self.s["knockout"]
            cur = ko[-1]
            alive = set()
            for t in cur["ties"]:
                if t.get("played"):
                    alive.add(t["winner"])
                else:
                    alive.add(t["a"]); alive.add(t["b"])

        # 1) Random finishes bottom (opens high): a random-engine team wins nothing.
        rand_teams = [t["id"] for t in teams if t["engine"] == "random"]
        if rand_teams:
            # P(no random team is champion) ~ 1 - sum(champ pct of random teams)
            p_rand_champ = sum(champ_pct.get(tid, 0) for tid in rand_teams)
            p0 = min(0.995, max(0.005, 1 - p_rand_champ))
            c = {"id": "random-not-champ", "label": "No random-mover team wins the Cup",
                 "desc": "Resolves YES if no team backed by the random engine lifts the trophy.",
                 "p0": p0, "status": "open"}
            if stage == "done":
                c["status"] = "resolved"
                c["outcome"] = "NO" if champion in rand_teams else "YES"
            out.append(c)

        # 2) A Python-language team reaches the Final.
        py_teams = set(t["id"] for t in teams if ENGINE_LANG[t["engine"]] == "Python")
        p_py_final = self._prob_reach_final(py_teams, sim)
        c = {"id": "python-in-final", "label": "A Python-language team reaches the Final",
             "desc": "Resolves YES if at least one Python-backed team plays in the Final.",
             "p0": min(0.995, max(0.005, p_py_final)), "status": "open"}
        finalists = self._finalists()
        if finalists is not None:
            c["status"] = "resolved"
            c["outcome"] = "YES" if (py_teams & set(finalists)) else "NO"
        out.append(c)

        # 3) The top seed lifts the trophy.
        seed_of = self.s.get("seed_of")
        if seed_of:
            top = min(seed_of, key=lambda k: seed_of[k])
            p0 = min(0.995, max(0.005, champ_pct.get(top, 0)))
            c = {"id": "top-seed-champ",
                 "label": "The top seed lifts the trophy",
                 "desc": "Resolves YES if the No. 1 knockout seed wins the tournament.",
                 "p0": p0, "status": "open"}
            if stage == "done":
                c["status"] = "resolved"; c["outcome"] = "YES" if champion == top else "NO"
            out.append(c)

        # 4) An alpha-beta engine wins the Cup ("the language tax is real" flavour).
        ab_teams = [t["id"] for t in teams if t["engine"].endswith("alphabeta")]
        p_ab = sum(champ_pct.get(tid, 0) for tid in ab_teams)
        c = {"id": "alphabeta-champ",
             "label": "An alpha-beta engine wins the Cup",
             "desc": "The language tax is real: resolves YES if the champion is an "
                     "alpha-beta search engine (any language).",
             "p0": min(0.995, max(0.005, p_ab)), "status": "open"}
        if stage == "done":
            c["status"] = "resolved"
            c["outcome"] = "YES" if (champion in ab_teams) else "NO"
        out.append(c)

        # 5) The champion is a C++ team (language market).
        cpp_teams = [t["id"] for t in teams if ENGINE_LANG[t["engine"]] == "C++"]
        p_cpp = sum(champ_pct.get(tid, 0) for tid in cpp_teams)
        c = {"id": "cpp-champ", "label": "A C++ team wins the Cup",
             "desc": "Resolves YES if the champion is backed by a C++ engine.",
             "p0": min(0.995, max(0.005, p_cpp)), "status": "open"}
        if stage == "done":
            c["status"] = "resolved"
            c["outcome"] = "YES" if (champion in cpp_teams) else "NO"
        out.append(c)

        # ---- real-2026-team contracts (priced straight from simulate) ----
        by_code = {}
        for t in teams:
            by_code.setdefault(t.get("code"), []).append(t["id"])
        finalists = self._finalists()

        def code_ids(*codes):
            ids = []
            for cc in codes:
                ids += by_code.get(cc, [])
            return ids

        # 6) Argentina retains the title (reigning 2022 champion).
        arg = code_ids("AR")
        if arg:
            p0 = sum(champ_pct.get(tid, 0) for tid in arg)
            c = {"id": "argentina-champ", "label": "Argentina retains the title",
                 "desc": "Resolves YES if Argentina wins the 2026 World Cup.",
                 "p0": min(0.995, max(0.005, p0)), "status": "open"}
            if stage == "done":
                c["status"] = "resolved"
                c["outcome"] = "YES" if champion in arg else "NO"
            out.append(c)

        # 7) A team outside pot 1 wins the Cup.
        non_pot1 = [t["id"] for t in teams if t.get("pot") != 1]
        p_np1 = sum(champ_pct.get(tid, 0) for tid in non_pot1)
        c = {"id": "non-pot1-champ", "label": "A team outside pot 1 wins the Cup",
             "desc": "Resolves YES if the champion was not a pot-1 seed.",
             "p0": min(0.995, max(0.005, p_np1)), "status": "open"}
        if stage == "done":
            c["status"] = "resolved"
            c["outcome"] = "YES" if (champion in set(non_pot1)) else "NO"
        out.append(c)

        # 8) A CONMEBOL team wins the Cup.
        conmebol = code_ids("BR", "AR", "UY", "CO", "EC", "PY")
        p_con = sum(champ_pct.get(tid, 0) for tid in conmebol)
        c = {"id": "conmebol-champ", "label": "A CONMEBOL team wins the Cup",
             "desc": "Resolves YES if a South American (CONMEBOL) side lifts the trophy.",
             "p0": min(0.995, max(0.005, p_con)), "status": "open"}
        if stage == "done":
            c["status"] = "resolved"
            c["outcome"] = "YES" if (champion in set(conmebol)) else "NO"
        out.append(c)

        # 9) An all-C++ Final (both finalists backed by a C++ engine).
        cpp_set = set(cpp_teams)
        p_final_pair = self._prob_all_cpp_final(cpp_set, sim)
        c = {"id": "all-cpp-final", "label": "An all-C++ Final",
             "desc": "Resolves YES if both teams in the Final are backed by a C++ engine.",
             "p0": min(0.995, max(0.005, p_final_pair)), "status": "open"}
        if finalists is not None:
            c["status"] = "resolved"
            c["outcome"] = "YES" if all(f in cpp_set for f in finalists) else "NO"
        out.append(c)

        return out

    def _prob_all_cpp_final(self, cpp_set, sim):
        """Rough P(both finalists are in cpp_set). Uses per-team final odds ~ 2x
        champion odds; assumes the two finalists are drawn near-independently."""
        finalists = self._finalists()
        if finalists is not None:
            return 1.0 if all(f in cpp_set for f in finalists) else 0.0
        champ_pct = {r["team"]: r["champion_pct"] for r in sim["teams"]}
        p_cpp_final = sum(min(0.98, 2.0 * champ_pct.get(tid, 0)) for tid in cpp_set)
        p_cpp_final = min(1.0, p_cpp_final)
        # two independent finalist slots both C++:
        return p_cpp_final * p_cpp_final

    def _finalists(self):
        """Return [a,b] finalist team ids if the Final tie exists, else None."""
        for rnd in self.s.get("knockout", []):
            if rnd["name"] == "Final" and rnd["ties"]:
                t = rnd["ties"][0]
                return [t["a"], t["b"]]
        return None

    def _prob_reach_final(self, team_set, sim):
        """Estimate P(any team in team_set reaches the Final). Reuses champion sim
        as a lower-cost proxy: a team reaches the final roughly at 2x its champ
        odds capped at 1; sum over the set with independence approximation."""
        if not team_set:
            return 0.0
        finalists = self._finalists()
        if finalists is not None:
            return 1.0 if (team_set & set(finalists)) else 0.0
        champ_pct = {r["team"]: r["champion_pct"] for r in sim["teams"]}
        # P(not in final) product approximation using per-team final odds ~ 2*champ.
        p_none = 1.0
        for tid in team_set:
            p_final = min(0.98, 2.0 * champ_pct.get(tid, 0))
            p_none *= (1 - p_final)
        return 1 - p_none

    def save(self):
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(self.s, f)

    @classmethod
    def load(cls):
        wc = cls()
        loaded = None
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                loaded = json.load(f)
        if loaded is not None and loaded.get("v") == STATE_VERSION:
            wc.s = loaded
            wc._hist = cls._load_history()
        else:
            # Missing state, or an old fake-draw state (v != current): rebuild
            # the real 2026 draw cleanly and persist it.
            wc.new()
            wc.save()
        return wc


def _count_pieces(fen):
    place = fen.split(" ")[0]
    w = sum(1 for c in place if c.isalpha() and c.isupper())
    b = sum(1 for c in place if c.isalpha() and c.islower())
    return w, b


if __name__ == "__main__":
    # quick self-test: real draw, calibration, one real orchestrator match.
    wc = WorldCup().new()  # real draw (no seed) reproduces the drawn groups
    print("teams:", len(wc.s["teams"]), "groups:", len(wc.s["groups"]),
          "fixtures:", len(wc.s["fixtures"]), "v:", wc.s["v"])
    by_code = {t["code"]: t for t in wc.s["teams"]}
    for code, grp in [("BR", "C"), ("ES", "H"), ("AR", "J"), ("ENG", "L")]:
        t = by_code[code]
        assert t["group"] == grp, (code, t["group"], grp)
        print(f"  {t['name']:14s} grp {t['group']} pot {t['pot']} "
              f"fifa {t['fifa_points']:7.1f} rating {t['rating']:6.1f} "
              f"nodes {t['nodes']:5d} eng {t['engine']} ({t['lang']})")

    # calibration: champion probabilities
    sim = wc.simulate(n=3000, seed=7)
    print("\n-- top-10 champion probabilities (simulate n=3000) --")
    for r in sim["teams"][:10]:
        print(f"  {r['name']:16s} {r['champion_pct']*100:5.1f}%")
    pct = {r["name"]: r["champion_pct"] for r in sim["teams"]}
    print("  sum:", round(sum(r["champion_pct"] for r in sim["teams"]), 3))
    for mnw in ("Haiti", "Curacao", "New Zealand"):
        print(f"  minnow {mnw}: {pct.get(mnw, 0)*100:.2f}%")

    # favourite vs minnow odds (rating-based)
    fav = by_code["ES"]["rating"]; minn = by_code["HT"]["rating"]
    w, d, l = wc.odds(fav, minn)
    print("odds Spain vs Haiti:", [round(x, 3) for x in (w, d, l)],
          "-> win share", round(w + d * (w / (w + l)), 3))

    # play one real match through the orchestrator (Brazil vs Haiti, group C).
    gC = wc.s["groups"][2]  # group C is index 2
    bid = by_code["BR"]["id"]; hid = by_code["HT"]["id"]
    mid = None
    for m in wc.s["fixtures"]:
        if m["group"] == 2 and {m["a"], m["b"]} == {bid, hid}:
            mid = m["id"]; break
    if mid and os.path.exists(os.path.join(ROOT, "build", "orchestrator")):
        m = wc.play(mid)
        print("\nplayed", mid, m["result"], m["reason"], "plies", m["plies"],
              "winner", m["winner"], "(Brazil id", bid, "Haiti id", hid, ")")
    else:
        print("\n(orchestrator not built or match not found; skipped live game)")

    cs = wc.contracts()
    print("\ncontracts:", len(cs), "open-with-outcome:",
          sum(1 for c in cs if c["status"] == "open" and "outcome" in c))
    for c in cs:
        print(f"  {c['id']:20s} p0={c['p0']:.3f} {c['status']}")
    print("matrix pairs:", sum(len(v) for v in wc.odds_matrix().values()))
