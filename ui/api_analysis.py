#!/usr/bin/env python3
"""Live analysis API for ui/live_server.py.

Exposes GET /api/analysis, which computes the SAME `analysis` block that
build_site_data.py bakes into tournament.json — but live, straight from the
run JSONLs — so ui/js/analysis.js renders identically whether it reads static
data or this endpoint.

live_server.py auto-imports this module and merges GET_ROUTES; it does not need
editing. Pure stdlib.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "analysis"))

from metrics import build_analysis  # noqa: E402  (single source of truth)

RUNS = os.path.join(ROOT, "runs")

# The canonical event -> JSONL mapping the static build uses. Any that are
# absent are silently skipped by build_analysis (it checks os.path.exists).
_EVENT_SOURCES = [
    ("fixed-node", os.path.join(RUNS, "tax_nodes.jsonl")),
    ("wall-clock", os.path.join(RUNS, "tax_time.jsonl")),
    ("group-stage", os.path.join(RUNS, "group.jsonl")),
    ("knockout", os.path.join(RUNS, "knockout.jsonl")),
]


def analysis_route(handler, query):
    """GET /api/analysis -> the live `analysis` block (or {} if no runs)."""
    try:
        block = build_analysis(_EVENT_SOURCES)
    except Exception as e:  # never 500 the spectator UI over a bad log line
        return handler._json({"error": str(e)}, 500)
    return handler._json(block)


GET_ROUTES = {"/api/analysis": analysis_route}
