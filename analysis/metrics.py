#!/usr/bin/env python3
"""Shared measurement math for the Chess World Cup analysis pipeline.

This is the ONE implementation of the per-move statistics surfaced by both the
CLI report (`analysis/report.py`) and the site-data / live-API builders
(`analysis/build_site_data.py`, `ui/api_analysis.py`). Keeping the math here
means the numbers can never drift between the terminal and the browser.

Pure stdlib, no dependencies.
"""
import datetime
import json
import os
from collections import defaultdict


def pct(sorted_vals, q):
    """Nearest-rank percentile of an ALREADY-SORTED sequence.

    `q` in [0, 1]. Returns 0.0 (float) for an empty input to match the historic
    report.py behaviour. Callers that pass unsorted data should sort first, or
    use `percentile()` which sorts for them.
    """
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, int(q * (len(sorted_vals) - 1) + 0.5))
    return sorted_vals[i]


def percentile(vals, q):
    """Convenience: nearest-rank percentile of an UNSORTED iterable."""
    return pct(sorted(vals), q)


def nps_by_move_number(rows, engine):
    """Mean NPS grouped by full-move number for one engine.

    Returns (means, buckets) where means[move_no] is the mean nodes/sec and
    buckets[move_no] is the list of per-ply NPS samples that fed it.

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


def nps_samples(rows, engine=None):
    """All per-move NPS samples (self_ms > 0), optionally for one engine."""
    out = []
    for r in rows:
        if engine is not None and r["engine"] != engine:
            continue
        if r.get("self_ms", 0) > 0:
            out.append(r["self_nodes"] / (r["self_ms"] / 1000.0))
    return out


def nps_mean(rows, engine=None):
    """Mean NPS over all timed moves; None when nothing is measurable."""
    s = nps_samples(rows, engine)
    return sum(s) / len(s) if s else None


def latency_percentiles(rows, engine, qs=(0.50, 0.90, 0.99)):
    """orch_ms percentiles for one engine, keyed by the q values passed."""
    lat = sorted(r["orch_ms"] for r in rows if r["engine"] == engine)
    return {q: pct(lat, q) for q in qs}


def delta_percentiles(rows, engine, qs=(0.50, 0.99)):
    """delta_ms (orch_ms - self_ms) percentiles + max for one engine."""
    dl = sorted(r["delta_ms"] for r in rows if r["engine"] == engine)
    out = {q: pct(dl, q) for q in qs}
    out["max"] = max(dl) if dl else 0
    return out


# ---------------------------------------------------------------------------
# Analysis block — the shared shape consumed by ui/js/analysis.js. Built the
# same way whether baked into tournament.json (build_site_data.py) or served
# live (ui/api_analysis.py), so the view is server-agnostic.
# ---------------------------------------------------------------------------

# Presentation metadata for the same-algorithm engines. `reuse` is how each
# language reaches the shared libchess core (the story of the language tax).
_LANG_META = {
    "cpp-alphabeta": {"lang": "C++", "family": "alpha-beta", "reuse": "native"},
    "rs-alphabeta":  {"lang": "Rust", "family": "alpha-beta", "reuse": "FFI"},
    "js-alphabeta":  {"lang": "JavaScript", "family": "alpha-beta", "reuse": "WASM"},
    "py-alphabeta":  {"lang": "Python", "family": "alpha-beta", "reuse": "ctypes"},
    "py-mcts":       {"lang": "Python", "family": "MCTS", "reuse": "ctypes"},
    "cpp-greedy":    {"lang": "C++", "family": "greedy", "reuse": "native"},
    "py-greedy":     {"lang": "Python", "family": "greedy", "reuse": "ctypes"},
    "random":        {"lang": "C++", "family": "random", "reuse": "native"},
}

# The spectrum shows the four SAME-algorithm engines, in this order.
_SPECTRUM_ORDER = ["cpp-alphabeta", "rs-alphabeta", "js-alphabeta", "py-alphabeta"]

# Canonical single-engine NPS from the dedicated startpos / 300 ms benchmark
# (README "language-tax spectrum" table). This isolates raw search throughput
# without the confounds of mixed opponents and time pressure that a tournament
# JSONL carries, so it is the reference the spectrum bars use when available.
# Falls back to measured tournament NPS for any engine not listed here.
_SPECTRUM_NPS = {
    "cpp-alphabeta": 4300000,   # native (inlined) — 1.0x baseline
    "rs-alphabeta":  2300000,   # native FFI        — ~1.8x
    "js-alphabeta":  1800000,   # WASM              — ~2.3x
    "py-alphabeta":   200000,   # ctypes FFI        — ~21x
}


def _load_move_rows(path):
    """Read a match JSONL into (move_rows, result_rows)."""
    moves, results = [], []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("type") == "result":
                results.append(r)
            else:
                moves.append(r)
    return moves, results


def _score_share(results, engine):
    """(w + 0.5 d) / games for one engine across a set of result rows."""
    w = d = g = 0
    for r in results:
        wp, bp = r["white"], r["black"]
        if engine not in (wp, bp):
            continue
        g += 1
        res = r["result"]
        if res == "1-0":
            if engine == wp:
                w += 1
        elif res == "0-1":
            if engine == bp:
                w += 1
        else:
            d += 1
    return (w + 0.5 * d) / g if g else 0.0


def build_analysis(sources):
    """Compute the `analysis` block from a list of (event_id, path) pairs.

    `event_id` values of interest: "fixed-node" and "wall-clock" drive the
    score-share swing; every source contributes NPS / latency / delta samples.
    Returns the dict documented in build_site_data.py, or {} if no rows load.
    """
    all_moves = []              # every move row across sources
    per_event_moves = {}        # event_id -> [move rows]
    per_event_results = {}      # event_id -> [result rows]
    src_paths = []
    for eid, path in sources:
        if not path or not os.path.exists(path):
            continue
        moves, results = _load_move_rows(path)
        per_event_moves[eid] = moves
        per_event_results[eid] = results
        all_moves.extend(moves)
        src_paths.append(path)

    if not all_moves:
        return {}

    fixed = per_event_results.get("fixed-node", [])
    wall = per_event_results.get("wall-clock", [])

    # Prefer the group stage (all four languages present) for the spectrum;
    # fall back to knockout, then to whatever moves we have.
    spectrum_moves = (per_event_moves.get("group-stage")
                      or per_event_moves.get("knockout")
                      or all_moves)

    engines = {}
    names = sorted({m["engine"] for m in all_moves})
    for name in names:
        meta = _LANG_META.get(name, {"lang": "?", "family": "?", "reuse": "?"})
        means, _ = nps_by_move_number(all_moves, name)
        nps_by_move = [[mv, round(means[mv])] for mv in sorted(means) if mv <= 20]
        lat = latency_percentiles(all_moves, name)
        dl = delta_percentiles(all_moves, name)
        nm = nps_mean(all_moves, name)
        engines[name] = {
            "lang": meta["lang"],
            "family": meta["family"],
            "nps_mean": round(nm) if nm is not None else None,
            "nps_by_move": nps_by_move,
            "lat": {"p50": lat[0.50], "p90": lat[0.90], "p99": lat[0.99]},
            "delta": {"p50": dl[0.50], "p99": dl[0.99], "max": dl["max"]},
            "score_fixed": _score_share(fixed, name) if fixed else None,
            "score_wall": _score_share(wall, name) if wall else None,
            "moves": sum(1 for m in all_moves if m["engine"] == name),
        }

    # --- spectrum: same algorithm, four languages, NPS + tax multiplier ---
    spec_nps = {}
    for name in _SPECTRUM_ORDER:
        # Prefer the canonical startpos benchmark; fall back to measured NPS.
        nm = _SPECTRUM_NPS.get(name) or nps_mean(spectrum_moves, name)
        if nm:
            spec_nps[name] = nm
    cpp_nps = spec_nps.get("cpp-alphabeta")
    spectrum = []
    for name in _SPECTRUM_ORDER:
        if name not in spec_nps:
            continue
        meta = _LANG_META[name]
        spectrum.append({
            "engine": name,
            "lang": meta["lang"],
            "reuse": meta["reuse"],
            "nps": round(spec_nps[name]),
            "tax_x": round(cpp_nps / spec_nps[name], 1) if cpp_nps else 1.0,
        })

    # --- tax pairs: same-algorithm cross-language duels (fixed vs wall) ---
    tax_pairs = []
    if fixed and wall:
        duel_engines = sorted({m["engine"] for m in
                               (per_event_moves.get("fixed-node", []))})
        # pair the C++ baseline against every other same-family engine present
        base = "cpp-alphabeta" if "cpp-alphabeta" in duel_engines else (
            duel_engines[0] if duel_engines else None)
        for other in duel_engines:
            if other == base or base is None:
                continue
            fa = _score_share(fixed, base)
            wa = _score_share(wall, base)
            na = engines.get(base, {}).get("nps_mean") or 0
            nb = engines.get(other, {}).get("nps_mean") or 1
            tax_pairs.append({
                "a": base, "b": other,
                "fixed_share_a": round(fa, 3),
                "wall_share_a": round(wa, 3),
                "nps_ratio": round(na / nb, 1) if nb else None,
                "swing_pts": round((wa - fa) * 100, 1),
            })

    return {
        "engines": engines,
        "tax_pairs": tax_pairs,
        "spectrum": spectrum,
        "sources": src_paths,
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
    }
