#!/usr/bin/env python3
"""Single-elimination knockout, seeded from the group-stage standings.

    python3 analysis/run_bracket.py --from-group runs/group.jsonl \
        --mode nodes --budget 12000 --games 4 \
        --out-jsonl runs/knockout.jsonl --out-bracket runs/bracket.json

Pads the field to a power of two with byes, runs each tie through the orchestrator
(winner = higher score; ties broken by wins then seed), and writes both the
bracket structure and the knockout games (for the UI).
"""
import argparse
import json
import os
import subprocess
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
}
BYE = "BYE"


def seeds_from_group(path):
    st = defaultdict(lambda: {"pts": 0.0, "w": 0})
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("type") != "result":
                continue
            w, b = r["white"], r["black"]
            if r["result"] == "1-0":
                st[w]["pts"] += 1; st[w]["w"] += 1; st[b]
            elif r["result"] == "0-1":
                st[b]["pts"] += 1; st[b]["w"] += 1; st[w]
            else:
                st[w]["pts"] += 0.5; st[b]["pts"] += 0.5
    return sorted(st, key=lambda n: (st[n]["pts"], st[n]["w"], n), reverse=True)


def bracket_positions(n):
    """Standard seeding order for a bracket of size n (power of two)."""
    order = [1, 2]
    while len(order) < n:
        m = len(order) * 2
        order = [x for s in order for x in (s, m + 1 - s)]
    return order


def run_tie(a, b, mode, budget, games, out_jsonl, base_id):
    """Run a mini-match A vs B; return (score_a, score_b, wins_a, wins_b, n_games)."""
    tmp = out_jsonl + ".tmp"
    mode_flag = "--nodes" if mode == "nodes" else "--movetime"
    argv = [os.path.join(ROOT, "build", "orchestrator"),
            "--engine1"] + ENGINES[a] + ["--engine2"] + ENGINES[b] + [
            "--games", str(games), mode_flag, str(budget),
            "--log", tmp, "--seed1", "13", "--seed2", "37"]
    subprocess.run(argv, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sa = sb = wa = wb = 0.0
    local = {}
    n = 0
    with open(tmp) as f, open(out_jsonl, "a") as out:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            g = r["game"]
            if g not in local:
                local[g] = base_id + len(local)
            r["game"] = local[g]
            out.write(json.dumps(r) + "\n")
            if r.get("type") == "result":
                n += 1
                winner = (r["white"] if r["result"] == "1-0"
                          else r["black"] if r["result"] == "0-1" else None)
                if winner == a:
                    sa += 1; wa += 1
                elif winner == b:
                    sb += 1; wb += 1
                else:
                    sa += 0.5; sb += 0.5
    if os.path.exists(tmp):
        os.remove(tmp)
    return sa, sb, wa, wb, n, base_id + len(local)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-group", help="group jsonl to seed from")
    ap.add_argument("--seeds", help="explicit comma-separated seed order (overrides --from-group)")
    ap.add_argument("--mode", default="nodes", choices=["nodes", "movetime"])
    ap.add_argument("--budget", type=int, default=12000)
    ap.add_argument("--games", type=int, default=4, help="games per knockout tie")
    ap.add_argument("--out-jsonl", default="runs/knockout.jsonl")
    ap.add_argument("--out-bracket", default="runs/bracket.json")
    args = ap.parse_args()

    if args.seeds:
        seeds = [s.strip() for s in args.seeds.split(",") if s.strip()]
    else:
        seeds = seeds_from_group(args.from_group)
    for s in seeds:
        if s not in ENGINES:
            raise SystemExit(f"unknown engine {s}")

    # Pad to power of two with byes.
    size = 1
    while size < len(seeds):
        size *= 2
    padded = seeds + [BYE] * (size - len(seeds))
    seed_of = {name: i + 1 for i, name in enumerate(padded)}  # seed number (1-best)

    order = bracket_positions(size)
    slots = [padded[s - 1] for s in order]  # engines in bracket position order

    open(args.out_jsonl, "w").close()
    base_id = 0
    rounds = []
    round_names = {1: "Final", 2: "Semifinals", 4: "Quarterfinals",
                   8: "Round of 16", 16: "Round of 32"}

    current = slots
    while len(current) > 1:
        ties = []
        winners = []
        for i in range(0, len(current), 2):
            a, b = current[i], current[i + 1]
            tie = {"a": a, "b": b,
                   "seedA": seed_of.get(a), "seedB": seed_of.get(b)}
            if a == BYE or b == BYE:
                win = b if a == BYE else a
                tie.update({"scoreA": None, "scoreB": None, "winner": win, "bye": True})
            else:
                sa, sb, wa, wb, ng, base_id = run_tie(a, b, args.mode, args.budget,
                                                      args.games, args.out_jsonl, base_id)
                if sa > sb or (sa == sb and (wa, -seed_of[a]) >= (wb, -seed_of[b])):
                    win = a
                else:
                    win = b
                tie.update({"scoreA": sa, "scoreB": sb, "winner": win, "bye": False})
                print(f"  {a} {sa} - {sb} {b}  -> {win}", flush=True)
            ties.append(tie)
            winners.append(tie["winner"])
        rounds.append({"name": round_names.get(len(ties), f"Round ({len(ties)})"),
                       "ties": ties})
        print(f"[{rounds[-1]['name']}] done", flush=True)
        current = winners

    champion = current[0]
    bracket = {"seeds": [{"seed": i + 1, "engine": n} for i, n in enumerate(padded) if n != BYE],
               "rounds": rounds, "champion": champion,
               "mode": args.mode, "budget": args.budget, "games_per_tie": args.games}
    with open(args.out_bracket, "w") as f:
        json.dump(bracket, f, indent=1)
    print(f"\n🏆 CHAMPION: {champion}")
    print(f"wrote {args.out_bracket} and {args.out_jsonl}")


if __name__ == "__main__":
    main()
