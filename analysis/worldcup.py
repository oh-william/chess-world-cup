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
GROUP_BUDGET = 6000
KO_BUDGET = 10000

ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "js-alphabeta":  [os.path.join(ROOT, "bots", "js-alphabeta", "js-alphabeta")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
}
ENGINE_LANG = {"cpp-alphabeta": "C++", "rs-alphabeta": "Rust", "js-alphabeta": "JavaScript",
               "py-alphabeta": "Python", "py-mcts": "Python", "cpp-greedy": "C++",
               "py-greedy": "Python", "random": "C++"}
ENGINE_RATING = {"cpp-alphabeta": 1820, "rs-alphabeta": 1810, "js-alphabeta": 1800,
                 "py-alphabeta": 1790, "py-mcts": 1450, "random": 1150,
                 "cpp-greedy": 1080, "py-greedy": 1070}
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

    def odds(self, ea, eb):
        """Implied (win, draw, loss) probabilities for engine ea vs eb."""
        h = self._hist.get((ea, eb), {"w": 0, "d": 0, "l": 0})
        n = h["w"] + h["d"] + h["l"]
        if n >= 6:  # enough historical games -> empirical (Laplace-smoothed)
            return [(h["w"] + 1) / (n + 3), (h["d"] + 1) / (n + 3), (h["l"] + 1) / (n + 3)]
        # Fall back to an Elo model with a draw term.
        ra, rb = ENGINE_RATING[ea], ENGINE_RATING[eb]
        exp = 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
        pdraw = 0.35 * math.exp(-((ra - rb) / 220.0) ** 2)
        pw = max(0.02, exp - pdraw / 2)
        pl = max(0.02, (1 - exp) - pdraw / 2)
        tot = pw + pdraw + pl
        return [pw / tot, pdraw / tot, pl / tot]

    # ---------- the draw ----------
    def new(self, seed=None):
        import random
        rng = random.Random(seed)
        teams = []
        for i in range(48):
            eng = SLOT_ENGINES[i]
            teams.append({"id": i, "engine": eng, "lang": ENGINE_LANG[eng],
                          "rating": ENGINE_RATING[eng] + (len(SLOT_ENGINES) - i) * 0.3})
        countries = COUNTRIES[:]
        rng.shuffle(countries)
        for i, t in enumerate(teams):
            t["country"] = countries[i]
            t["name"] = countries[i]
        # Pots by rating, then snake-draw one per pot into each group.
        by_rating = sorted(teams, key=lambda t: t["rating"], reverse=True)
        pots = [by_rating[p * 12:(p + 1) * 12] for p in range(4)]
        for p in pots:
            rng.shuffle(p)
        groups = [[pots[p][g]["id"] for p in range(4)] for g in range(12)]

        fixtures = []
        pair_order = [(0, 1), (2, 3), (0, 2), (1, 3), (0, 3), (1, 2)]
        for g, members in enumerate(groups):
            for mi, (x, y) in enumerate(pair_order):
                fixtures.append({"id": f"G{g}M{mi}", "stage": "group", "group": g,
                                 "a": members[x], "b": members[y], "played": False})
        self.s = {"id": os.urandom(4).hex(), "teams": teams, "groups": groups,
                  "fixtures": fixtures, "stage": "group", "knockout": [], "champion": None}
        self._hist = self._load_history()
        return self

    # ---------- play a match ----------
    def _run_game(self, ea, eb, budget, seed1, seed2):
        tmp = os.path.join(ROOT, "runs", "_wc_tmp.jsonl")
        argv = [os.path.join(ROOT, "build", "orchestrator"),
                "--engine1"] + ENGINES[ea] + ["--engine2"] + ENGINES[eb] + [
                "--games", "1", "--nodes", str(budget), "--log", tmp,
                "--warmup-ms", "0", "--seed1", str(seed1), "--seed2", str(seed2)]
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
            "moves": [{"uci": m["move"], "fen": m["fen"]} for m in moves],
            "positions": positions,
        }

    def play(self, match_id):
        m = self._find(match_id)
        if not m or m.get("played"):
            return m
        ta, tb = self._team(m["a"]), self._team(m["b"])
        budget = GROUP_BUDGET if m["stage"] == "group" else KO_BUDGET
        g = self._run_game(ta["engine"], tb["engine"], budget,
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
        for i in range(0, len(teams), 2):
            a, b = teams[i], teams[i + 1]
            ties.append({"id": f"K{name[0]}{i}", "stage": "knockout", "round": name,
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
            out["odds"] = self.odds(self._team(m["a"])["engine"], self._team(m["b"])["engine"])
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

    def save(self):
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(self.s, f)

    @classmethod
    def load(cls):
        wc = cls()
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                wc.s = json.load(f)
        else:
            wc.new()
            wc.save()
        wc._hist = cls._load_history()
        return wc


def _count_pieces(fen):
    place = fen.split(" ")[0]
    w = sum(1 for c in place if c.isalpha() and c.isupper())
    b = sum(1 for c in place if c.isalpha() and c.islower())
    return w, b


if __name__ == "__main__":
    # quick self-test: draw + play one match
    wc = WorldCup().new(seed=1)
    print("teams:", len(wc.s["teams"]), "groups:", len(wc.s["groups"]),
          "fixtures:", len(wc.s["fixtures"]))
    m = wc.play("G0M0")
    print("played G0M0:", m["result"], m["reason"], "plies", m["plies"],
          "caps", m["capA"], m["capB"], "winner", m["winner"])
    print("odds sample:", wc.odds("cpp-alphabeta", "random"))
