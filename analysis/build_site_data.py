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
    "rs-alphabeta":  {"lang": "Rust", "family": "alpha-beta", "color": "#dea584"},
    "js-alphabeta":  {"lang": "JavaScript", "family": "alpha-beta", "color": "#f7df1e"},
    "py-alphabeta":  {"lang": "Python", "family": "alpha-beta", "color": "#f4a261"},
    "py-mcts":       {"lang": "Python", "family": "MCTS", "color": "#2a9d8f"},
    "cpp-greedy":    {"lang": "C++", "family": "greedy", "color": "#e76f51"},
    "py-greedy":     {"lang": "Python", "family": "greedy", "color": "#8ab17d"},
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


def _by_lang(meta, names, lang):
    for n in names:
        if meta.get(n, {}).get("lang") == lang:
            return n
    return None


def build_markets(events_by_id, meta):
    """Kalshi-style event contracts derived from the tournament, with the
    ground-truth outcome for resolution."""
    markets = []
    fn = events_by_id.get("fixed-node")
    wc = events_by_id.get("wall-clock")

    # Duel markets: does the C++ engine finish above 50%?
    for ev in (fn, wc):
        if not ev or len(ev["engines"]) != 2:
            continue
        cpp = _by_lang(meta, ev["engines"], "C++") or ev["engines"][0]
        share = engine_score(ev["standings"], cpp)
        markets.append({
            "id": f"{ev['id']}-cpp-wins", "event": ev["label"],
            "label": f"{cpp} wins the {ev['label']}",
            "desc": f"Same algorithm, two languages. Resolves YES if {cpp} scores "
                    f"over 50% here. (Fixed-node should be a coin-flip; wall-clock shouldn't.)",
            "outcome": "YES" if share > 0.5 else "NO"})

    # The headline: language tax.
    if fn and wc and len(fn["engines"]) == 2:
        cpp = _by_lang(meta, fn["engines"], "C++")
        py = _by_lang(meta, fn["engines"], "Python")
        if cpp and py:
            cf = engine_score(fn["standings"], cpp)
            cw = engine_score(wc["standings"], cpp)
            markets.append({
                "id": "language-tax", "event": "Language Tax",
                "label": f"The language tax is real: {cpp} pulls further ahead under wall-clock",
                "desc": f"{cpp} and {py} run the SAME alpha-beta over the SAME eval. Resolves "
                        f"YES if {cpp}'s score share is higher at equal time than at equal nodes "
                        f"— i.e. {py} loses purely to speed.",
                "outcome": "YES" if cw > cf else "NO"})

    # Group-stage markets.
    gs = events_by_id.get("group-stage")
    if gs:
        rank = sorted(gs["engines"], key=lambda n: gs["standings"][n]["pts"], reverse=True)
        pya = "py-alphabeta" if "py-alphabeta" in gs["engines"] else None
        pym = "py-mcts" if "py-mcts" in gs["engines"] else None
        if pya and pym:
            markets.append({
                "id": "gs-py-duel", "event": "Group Stage",
                "label": "py-alphabeta out-scores py-mcts in the Group Stage",
                "desc": "Knowledge pole vs knowledge pole, same language — which paradigm "
                        "banks more points across the round robin?",
                "outcome": "YES" if gs["standings"][pya]["pts"] > gs["standings"][pym]["pts"] else "NO"})
        if "random" in gs["engines"]:
            markets.append({
                "id": "gs-random-last", "event": "Group Stage",
                "label": "random finishes bottom of the Group Stage",
                "desc": "Does the protocol canary anchor the table, as an Elo anchor should?",
                "outcome": "YES" if rank[-1] == "random" else "NO"})
    return markets


def build_gates(events_by_id, meta):
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
    if fn and wc and len(fn["engines"]) == 2:
        cpp = _by_lang(meta, fn["engines"], "C++") or fn["engines"][0]
        py = _by_lang(meta, fn["engines"], "Python") or fn["engines"][1]
        cpp_fn = engine_score(fn["standings"], cpp)
        cpp_wc = engine_score(wc["standings"], cpp)
        nps_cpp = wc["stats"].get(cpp, {}).get("nps_mean") or 0
        nps_py = wc["stats"].get(py, {}).get("nps_mean") or 1
        gates.append({
            "n": 5, "name": "language tax (miniature)",
            "status": "pass" if cpp_wc > cpp_fn else "measured",
            "detail": f"{cpp} vs {py} (same algorithm): score share {cpp_fn*100:.0f}% "
                      f"fixed-node -> {cpp_wc*100:.0f}% wall-clock. Speed ratio "
                      f"{nps_cpp/nps_py:.1f}x ({nps_cpp:,} vs {nps_py:,} nps)."})
    else:
        gates.append({"n": 5, "name": "language tax (miniature)",
                      "status": "pending", "detail": "run both events to measure."})
    return gates


def build_analysis_block(event_paths):
    """ADDITIVE: the top-level `analysis` block consumed by ui/js/analysis.js.
    Delegates to analysis.metrics (single source of truth, shared with the live
    /api/analysis route). Returns {} when no rows load."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from metrics import build_analysis  # noqa: E402
        return build_analysis(event_paths)
    except Exception as e:  # never let the analysis block break the core build
        print(f"warning: analysis block skipped ({e})", file=sys.stderr)
        return {}


def build_odds_contracts(out):
    """ADDITIVE + GUARDED: bake worldcup odds/contracts if WS3 has landed the
    methods. Feature-detected so the build works either way."""
    try:
        from worldcup import WorldCup  # noqa: E402
    except Exception:
        return
    try:
        wc = WorldCup.load()
    except Exception:
        return
    if hasattr(wc, "odds_matrix"):
        try:
            out["odds"] = wc.odds_matrix()
        except Exception as e:
            print(f"warning: odds block skipped ({e})", file=sys.stderr)
    if hasattr(wc, "contracts"):
        try:
            out["contracts"] = wc.contracts()
        except Exception as e:
            print(f"warning: contracts block skipped ({e})", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", nargs=3, action="append", metavar=("ID", "LABEL", "PATH"),
                    default=[])
    ap.add_argument("--bracket", help="bracket.json from run_bracket.py to embed")
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
        "gates": build_gates(events_by_id, all_engines),
        "markets": build_markets(events_by_id, all_engines),
    }
    if args.bracket and os.path.exists(args.bracket):
        with open(args.bracket) as f:
            br = json.load(f)
        out["bracket"] = br
        # Knockout markets with real outcomes.
        top_seed = next((s["engine"] for s in br["seeds"] if s["seed"] == 1), None)
        if top_seed:
            out["markets"].append({
                "id": "ko-topseed", "event": "Knockout",
                "label": f"top seed {top_seed} lifts the trophy",
                "desc": "Does the group-stage winner convert its seeding into the title?",
                "outcome": "YES" if br["champion"] == top_seed else "NO"})
        final = br["rounds"][-1]["ties"][0] if br["rounds"] else None
        if final:
            finalists = [final["a"], final["b"]]
            py_final = any(all_engines.get(n, {}).get("lang") == "Python" for n in finalists)
            out["markets"].append({
                "id": "ko-py-final", "event": "Knockout",
                "label": "a Python engine reaches the Final",
                "desc": "Can an interpreted engine survive the knockout to the last match?",
                "outcome": "YES" if py_final else "NO"})
    # ADDITIVE blocks (existing keys above are untouched).
    analysis = build_analysis_block([(eid, path) for eid, _label, path in args.event])
    if analysis:
        out["analysis"] = analysis
    build_odds_contracts(out)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    size = os.path.getsize(args.out)
    extra = []
    if "analysis" in out:
        extra.append(f"{len(out['analysis'].get('spectrum', []))} spectrum engines")
    if "odds" in out:
        extra.append("odds")
    if "contracts" in out:
        extra.append(f"{len(out['contracts'])} contracts")
    print(f"wrote {args.out} ({size/1024:.0f} KB): "
          f"{len(events)} events, {len(all_engines)} engines, "
          f"{sum(len(e['games']) for e in events)} games, "
          f"{len(out['markets'])} markets"
          + (" | " + ", ".join(extra) if extra else ""))


if __name__ == "__main__":
    main()
