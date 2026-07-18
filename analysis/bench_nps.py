#!/usr/bin/env python3
"""Measure each engine's raw search throughput (nodes/sec) on a fixed position,
so the Analysis spectrum uses real, reproducible numbers instead of a constant.

Runs `go movetime <ms>` from the start position, parses the engine's own
`info ... nodes N time T` line, and writes runs/nps_bench.json = {engine: nps}.

    python3 analysis/bench_nps.py [--ms 300]
"""
import argparse
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "js-alphabeta":  [os.path.join(ROOT, "bots", "js-alphabeta", "js-alphabeta")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
}


def bench(path, ms):
    cmd = f"uci\nisready\nposition startpos\ngo movetime {ms}\nquit\n"
    out = subprocess.run(path, input=cmd, capture_output=True, text=True, cwd=ROOT, timeout=30).stdout
    nodes = tms = None
    for line in out.splitlines():
        if line.startswith("info") and "nodes" in line:
            t = line.split()
            for i, tok in enumerate(t):
                if tok == "nodes":
                    nodes = int(t[i + 1])
                elif tok == "time":
                    tms = int(t[i + 1])
    if not nodes or not tms:
        return None
    return round(nodes / (tms / 1000.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ms", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(ROOT, "runs", "nps_bench.json"))
    args = ap.parse_args()

    result = {}
    for name, path in ENGINES.items():
        if not os.path.exists(path[0]):
            print(f"  {name:14s} (missing binary, skipped)")
            continue
        nps = bench(path, args.ms)
        if nps:
            result[name] = nps
            print(f"  {name:14s} {nps:>10,} nps")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"ms": args.ms, "nps": result}, f, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
