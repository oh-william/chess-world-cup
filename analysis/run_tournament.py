#!/usr/bin/env python3
"""Round-robin group stage: run every pair of engines through the orchestrator,
concatenate the per-game logs (with globally-unique game ids) into one JSONL, and
print World-Cup standings. Feed the combined log to build_site_data as one event.

    python3 analysis/run_tournament.py \
        --engines cpp-alphabeta,py-alphabeta,py-mcts,cpp-greedy,py-greedy,random \
        --mode nodes --budget 8000 --games 2 --out runs/group.jsonl
"""
import argparse
import itertools
import json
import os
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engines", required=True, help="comma-separated engine names")
    ap.add_argument("--mode", default="nodes", choices=["nodes", "movetime"])
    ap.add_argument("--budget", type=int, default=8000)
    ap.add_argument("--games", type=int, default=2, help="games per pairing")
    ap.add_argument("--out", default="runs/group.jsonl")
    args = ap.parse_args()

    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    for e in engines:
        if e not in ENGINES:
            sys.exit(f"unknown engine: {e}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    combined = open(args.out, "w")
    standings = defaultdict(lambda: {"w": 0, "d": 0, "l": 0, "pts": 0.0, "games": 0})
    global_game = 0
    mode_flag = "--nodes" if args.mode == "nodes" else "--movetime"

    pairings = list(itertools.combinations(engines, 2))
    for pi, (a, b) in enumerate(pairings, 1):
        print(f"[{pi}/{len(pairings)}] {a} vs {b} ...", flush=True)
        argv = [os.path.join(ROOT, "build", "orchestrator"),
                "--engine1"] + ENGINES[a] + ["--engine2"] + ENGINES[b] + [
                "--games", str(args.games), mode_flag, str(args.budget),
                "--log", tmp, "--seed1", "1", "--seed2", "2"]
        subprocess.run(argv, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        local_to_global = {}
        with open(tmp) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                g = r["game"]
                if g not in local_to_global:
                    local_to_global[g] = global_game
                    global_game += 1
                r["game"] = local_to_global[g]
                combined.write(json.dumps(r) + "\n")
                if r.get("type") == "result":
                    w, bl = r["white"], r["black"]
                    standings[w]["games"] += 1
                    standings[bl]["games"] += 1
                    if r["result"] == "1-0":
                        standings[w]["w"] += 1; standings[w]["pts"] += 1; standings[bl]["l"] += 1
                    elif r["result"] == "0-1":
                        standings[bl]["w"] += 1; standings[bl]["pts"] += 1; standings[w]["l"] += 1
                    else:
                        standings[w]["d"] += 1; standings[bl]["d"] += 1
                        standings[w]["pts"] += 0.5; standings[bl]["pts"] += 0.5
    combined.close()
    if os.path.exists(tmp):
        os.remove(tmp)

    print(f"\nGroup Stage — {len(engines)} engines, {global_game} games "
          f"({args.mode} {args.budget})\n")
    print(f"{'#':>2} {'engine':<15}{'GP':>4}{'W':>4}{'D':>4}{'L':>4}{'Pts':>6}{'Score%':>8}")
    rows = sorted(standings.items(), key=lambda kv: kv[1]["pts"], reverse=True)
    for i, (name, s) in enumerate(rows, 1):
        share = 100 * s["pts"] / s["games"] if s["games"] else 0
        print(f"{i:>2} {name:<15}{s['games']:>4}{s['w']:>4}{s['d']:>4}{s['l']:>4}"
              f"{s['pts']:>6.1f}{share:>7.0f}%")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
