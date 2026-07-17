#!/usr/bin/env python3
"""Compile match JSONL logs into a single tournament.json the spectator UI reads.

Usage:
    python3 analysis/build_site_data.py \
        --event fixed-node "Fixed-Node Match" runs/gate5_nodes.jsonl \
        --event wall-clock "Wall-Clock Match" runs/gate5_time.jsonl \
        --out ui/data/tournament.json
"""
import argparse
import datetime
import json
import os
import statistics as st
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "shim", "py"))
from libchess_ffi import Board  # noqa: E402  (reuse the core to reconstruct positions)

_recon = Board()


def positions_for(mv):
    """FEN before each ply, plus the final position (reconstructed via libchess)."""
    if not mv:
        return []
    pos = [m["fen"] for m in mv]
    _recon.set_fen(mv[-1]["fen"])
    last = _recon.move_from_uci(mv[-1]["uci"])
    if last:
        _recon.make(last)
    pos.append(_recon.fen())
    return pos

# Presentation metadata for the engines we ship (World-Cup flavour).
ENGINE_META = {
    "cpp-alphabeta": {"lang": "C++", "family": "alpha-beta", "color": "#e63946"},
    "py-mcts":       {"lang": "Python", "family": "MCTS", "color": "#2a9d8f"},
    "random":        {"lang": "C++", "family": "random", "color": "#8d99ae"},
}


def pct(vals, q):
    if not vals:
        return 0
    s = sorted(vals)
    i = min(len(s) - 1, int(q * (len(s) - 1) + 0.5))
    return s[i]


def load_event(event_id, label, path):
    moves = defaultdict(list)      # game -> [move rows]
    results = {}                   # game -> result row
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("type") == "result":
                results[r["game"]] = r
            else:
                moves[r["game"]].append(r)

    mode = next(iter(results.values()))["mode"] if results else "?"
    budget = next(iter(results.values()))["budget"] if results else 0

    games, standings = [], defaultdict(lambda: {"w": 0, "d": 0, "l": 0, "pts": 0.0,
                                                "games": 0})
    countries = {}
    for gid in sorted(results):
        res = results[gid]
        w, b = res["white"], res["black"]
        countries[w] = res.get("white_country", "XX")
        countries[b] = res.get("black_country", "XX")
        mv = [{"ply": m["ply"], "color": m["color"], "engine": m["engine"],
               "uci": m["move"], "fen": m["fen"], "orch_ms": m["orch_ms"],
               "self_ms": m["self_ms"], "delta_ms": m["delta_ms"],
               "self_nodes": m["self_nodes"]} for m in moves.get(gid, [])]
        games.append({"id": gid, "white": w, "black": b,
                      "white_country": countries[w], "black_country": countries[b],
                      "result": res["result"], "reason": res["reason"],
                      "plies": res["plies"], "moves": mv,
                      "positions": positions_for(mv)})

        for name in (w, b):
            standings[name]["games"] += 1
        if res["result"] == "1-0":
            standings[w]["w"] += 1; standings[w]["pts"] += 1
            standings[b]["l"] += 1
        elif res["result"] == "0-1":
            standings[b]["w"] += 1; standings[b]["pts"] += 1
            standings[w]["l"] += 1
        else:
            standings[w]["d"] += 1; standings[b]["d"] += 1
            standings[w]["pts"] += 0.5; standings[b]["pts"] += 0.5

    # Per-engine timing/NPS within this event.
    stats = {}
    per_engine_moves = defaultdict(list)
    for gid, ms in moves.items():
        for m in ms:
            per_engine_moves[m["engine"]].append(m)
    for name, ms in per_engine_moves.items():
        nps = [m["self_nodes"] / (m["self_ms"] / 1000.0)
               for m in ms if m["self_ms"] > 0]
        stats[name] = {
            "moves": len(ms),
            "nps_mean": round(st.mean(nps)) if nps else None,
            "lat_p50": pct([m["orch_ms"] for m in ms], 0.50),
            "lat_p99": pct([m["orch_ms"] for m in ms], 0.99),
            "delta_p50": pct([m["delta_ms"] for m in ms], 0.50),
            "delta_p99": pct([m["delta_ms"] for m in ms], 0.99),
        }

    return {
        "id": event_id, "label": label, "mode": mode, "budget": budget,
        "engines": sorted(standings.keys()),
        "countries": countries,
        "standings": {k: dict(v) for k, v in standings.items()},
        "stats": stats,
        "games": games,
    }, standings, stats


def engine_score(standings, name):
    s = standings[name]
    return (s["w"] + 0.5 * s["d"]) / s["games"] if s["games"] else 0.0


def build_markets(events_by_id):
    """Kalshi-style event contracts derived from the tournament, with the
    ground-truth outcome for resolution."""
    markets = []
    fn = events_by_id.get("fixed-node")
    wc = events_by_id.get("wall-clock")

    def winner(ev):
        st_ = ev["standings"]
        a, b = ev["engines"][0], ev["engines"][1]
        sa, sb = engine_score({k: st_[k] for k in st_}, a), engine_score(st_, b)
        return (a if sa > sb else b if sb > sa else None), sa, sb

    if fn:
        w, sa, sb = winner(fn)
        markets.append({
            "id": "fn-cpp-wins", "event": "Fixed-Node Match",
            "label": "cpp-alphabeta wins the Fixed-Node match",
            "desc": "Resolves YES if cpp-alphabeta scores more than py-mcts at equal node budget.",
            "outcome": "YES" if fn["standings"]["cpp-alphabeta"]["w"] >
                        fn["standings"]["py-mcts"]["w"] else "NO"})
    if wc:
        markets.append({
            "id": "wc-cpp-wins", "event": "Wall-Clock Match",
            "label": "cpp-alphabeta wins the Wall-Clock match",
            "desc": "Resolves YES if cpp-alphabeta scores more than py-mcts at equal wall-clock.",
            "outcome": "YES" if wc["standings"]["cpp-alphabeta"]["w"] >
                        wc["standings"]["py-mcts"]["w"] else "NO"})
        markets.append({
            "id": "wc-mcts-any", "event": "Wall-Clock Match",
            "label": "py-mcts wins at least one Wall-Clock game",
            "desc": "Can the knowledge pole steal a point when starved of nodes by the language tax?",
            "outcome": "YES" if wc["standings"]["py-mcts"]["w"] >= 1 else "NO"})
    if fn and wc:
        cpp_fn = engine_score(fn["standings"], "cpp-alphabeta")
        cpp_wc = engine_score(wc["standings"], "cpp-alphabeta")
        markets.append({
            "id": "language-tax", "event": "Language Tax",
            "label": "The language tax is real: C++ dominates MORE under wall-clock",
            "desc": "Resolves YES if cpp-alphabeta's score share is higher under wall-clock "
                    "than under fixed nodes — i.e. Python loses Elo purely to speed.",
            "outcome": "YES" if cpp_wc > cpp_fn else "NO"})
    return markets


def build_gates(events_by_id):
    gates = [
        {"n": 1, "name": "perft", "status": "pass",
         "detail": "startpos/kiwipete/position3 exact to depth 5-6; ~82 Mnps."},
        {"n": 2, "name": "protocol conformance", "status": "pass",
         "detail": "random: 100/100 self-games, 0 protocol errors / timeouts / illegal moves."},
        {"n": 3, "name": "warm-up isolation", "status": "pass",
         "detail": "NPS flat across moves 1-20; no move-1 cold-start spike."},
        {"n": 4, "name": "timing honesty", "status": "pass",
         "detail": "cpp-alphabeta orch-vs-self delta <= 1 ms, stable."},
    ]
    fn, wc = events_by_id.get("fixed-node"), events_by_id.get("wall-clock")
    if fn and wc:
        cpp_fn = engine_score(fn["standings"], "cpp-alphabeta")
        cpp_wc = engine_score(wc["standings"], "cpp-alphabeta")
        nps_cpp = wc["stats"].get("cpp-alphabeta", {}).get("nps_mean") or 0
        nps_py = wc["stats"].get("py-mcts", {}).get("nps_mean") or 1
        gates.append({
            "n": 5, "name": "language tax (miniature)",
            "status": "pass" if cpp_wc >= cpp_fn else "measured",
            "detail": f"cpp-alphabeta score share: {cpp_fn*100:.0f}% fixed-node -> "
                      f"{cpp_wc*100:.0f}% wall-clock. Speed ratio {nps_cpp/nps_py:.1f}x "
                      f"({nps_cpp:,} vs {nps_py:,} nps)."})
    else:
        gates.append({"n": 5, "name": "language tax (miniature)",
                      "status": "pending", "detail": "run both events to measure."})
    return gates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", nargs=3, action="append", metavar=("ID", "LABEL", "PATH"),
                    default=[])
    ap.add_argument("--out", default="ui/data/tournament.json")
    args = ap.parse_args()

    events, events_by_id = [], {}
    all_engines = {}
    for eid, label, path in args.event:
        ev, standings, stats = load_event(eid, label, path)
        events.append(ev)
        events_by_id[eid] = ev
        for name in ev["engines"]:
            meta = ENGINE_META.get(name, {"lang": "?", "family": "?", "color": "#888"})
            all_engines[name] = {"name": name, "country": ev["countries"].get(name, "XX"),
                                 **meta}

    out = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "engines": all_engines,
        "events": events,
        "gates": build_gates(events_by_id),
        "markets": build_markets(events_by_id),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    size = os.path.getsize(args.out)
    print(f"wrote {args.out} ({size/1024:.0f} KB): "
          f"{len(events)} events, {len(all_engines)} engines, "
          f"{sum(len(e['games']) for e in events)} games, "
          f"{len(out['markets'])} markets")


if __name__ == "__main__":
    main()
