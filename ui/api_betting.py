#!/usr/bin/env python3
"""WS3 unified-betting server routes.

Exposes module-level GET_ROUTES / POST_ROUTES dicts that live_server.py
auto-imports. Every probability comes from the single WorldCup.odds() model via
the live WC instance (imported lazily from live_server to avoid an import cycle).

    GET  /api/odds?a=&b=            -> {w,d,l,n,source}
    GET  /api/contracts            -> [ {id,label,desc,p0,status[,outcome]} ]
    POST /api/tournament/simulate  -> {teams:[{team,country,engine,champion_pct}], n}
"""


def _live():
    """Lazily grab the live WC instance + lock from live_server (avoids a cycle)."""
    import live_server
    return live_server.WC, live_server.WC_LOCK


def _odds(handler, query):
    a = (query.get("a") or [""])[0]
    b = (query.get("b") or [""])[0]
    WC, LOCK = _live()
    valid = set(WorldCup_engines(WC))
    if a not in valid or b not in valid or a == b:
        return handler._json({"error": "unknown or equal engines",
                              "engines": sorted(valid)}, 400)
    with LOCK:
        return handler._json(WC.odds_detail(a, b))


def WorldCup_engines(WC):
    return getattr(WC, "_MODEL_ENGINES")


def _contracts(handler, query):
    WC, LOCK = _live()
    with LOCK:
        cs = WC.contracts()
    # Defensive: never leak an outcome for an open contract.
    for c in cs:
        if c.get("status") == "open" and "outcome" in c:
            del c["outcome"]
    return handler._json(cs)


def _simulate(handler, body):
    n = body.get("n", 2000)
    try:
        n = max(100, min(20000, int(n)))
    except (TypeError, ValueError):
        n = 2000
    seed = body.get("seed")
    WC, LOCK = _live()
    with LOCK:
        res = WC.simulate(n=n, seed=seed)
    return handler._json(res)


GET_ROUTES = {
    "/api/odds": _odds,
    "/api/contracts": _contracts,
}
POST_ROUTES = {
    "/api/tournament/simulate": _simulate,
}
