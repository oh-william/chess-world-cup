#!/usr/bin/env python3
"""Analysis for the Chess World Cup per-move JSONL logs.

Produces the three Phase-0 measurement outputs:

  * NPS by move number      — Gate 3 (warm-up isolation): the curve must be flat.
  * move latency p50/p90/p99 — Gate 4 (timing honesty).
  * orchestrator-vs-self delta — Gate 4: delta_ms = orch_ms - self_ms is the
    implementation tax (IPC + GC + scheduling).

Pure stdlib, no dependencies. Usage:

    python3 analysis/report.py match.jsonl [match2.jsonl ...]
"""
import json
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows


def pct(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, int(q * (len(sorted_vals) - 1) + 0.5))
    return sorted_vals[i]


def bar(value, vmax, width=32):
    if vmax <= 0:
        return ""
    return "#" * max(0, int(round(width * value / vmax)))


def nps_by_move_number(rows, engine):
    """Mean NPS grouped by move number (ply index) for one engine.

    Only moves with a measurable self-reported time contribute (self_ms > 0),
    since NPS is undefined for sub-millisecond moves.
    """
    buckets = defaultdict(list)
    for r in rows:
        if r["engine"] != engine or r.get("self_ms", 0) <= 0:
            continue
        move_no = r["ply"] // 2 + 1  # full-move number
        nps = r["self_nodes"] / (r["self_ms"] / 1000.0)
        buckets[move_no].append(nps)
    return {k: sum(v) / len(v) for k, v in buckets.items()}, buckets


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)

    rows = load(sys.argv[1:])
    if not rows:
        print("no rows loaded")
        sys.exit(1)

    engines = sorted({r["engine"] for r in rows})
    print(f"loaded {len(rows)} moves across engines: {', '.join(engines)}\n")

    # ---- Gate 3: NPS by move number ------------------------------------
    print("=" * 68)
    print("GATE 3 — warm-up isolation: mean NPS by move number (should be FLAT)")
    print("=" * 68)
    for eng in engines:
        means, buckets = nps_by_move_number(rows, eng)
        if not means:
            print(f"\n{eng}: no timed moves (sub-ms search), NPS not measurable")
            continue
        first20 = {k: means[k] for k in sorted(means) if k <= 20}
        if not first20:
            continue
        vmax = max(first20.values())
        vals = list(first20.values())
        flat = 100.0 * (max(vals) - min(vals)) / (sum(vals) / len(vals))
        print(f"\n{eng}   (moves 1-20, spread {flat:.0f}% of mean)")
        for mv in sorted(first20):
            v = first20[mv]
            n = len(buckets[mv])
            print(f"  move {mv:2d}  {v/1e6:6.2f} Mnps  n={n:<3d} {bar(v, vmax)}")

    # ---- Gate 4: latency + delta ---------------------------------------
    print("\n" + "=" * 68)
    print("GATE 4 — timing honesty (per engine)")
    print("=" * 68)
    header = f"\n{'engine':<16}{'moves':>7}{'p50':>7}{'p90':>7}{'p99':>7}" \
             f"{'  |':>4}{'delta p50':>11}{'delta p99':>11}{'delta max':>11}"
    print(header)
    print("-" * len(header))
    for eng in engines:
        lat = sorted(r["orch_ms"] for r in rows if r["engine"] == eng)
        dl = sorted(r["delta_ms"] for r in rows if r["engine"] == eng)
        print(f"{eng:<16}{len(lat):>7}"
              f"{pct(lat,0.50):>7.0f}{pct(lat,0.90):>7.0f}{pct(lat,0.99):>7.0f}"
              f"{'  |':>4}{pct(dl,0.50):>11.0f}{pct(dl,0.99):>11.0f}"
              f"{max(dl) if dl else 0:>11.0f}")
    print("\nlatency = orchestrator go->bestmove (ms).  "
          "delta = orch_ms - self_ms = implementation tax (IPC+GC+sched).")


if __name__ == "__main__":
    main()
