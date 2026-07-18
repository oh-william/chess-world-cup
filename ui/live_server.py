#!/usr/bin/env python3
"""Live match server: runs a match and streams move/result events to the UI over
Server-Sent Events, so the Broadcast page can watch a game unfold in real time.

    python3 ui/live_server.py                       # default match, port 8000
    python3 ui/live_server.py --engine1 cpp-alphabeta --engine2 py-mcts \
        --mode movetime --budget 250 --games 6 --port 8000

Then open http://localhost:<port> and use the 🔴 Live tab.
"""
import argparse
import functools
import http.server
import json
import os
import subprocess
import threading
import time
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import sys
sys.path.insert(0, os.path.join(ROOT, "analysis"))
from worldcup import WorldCup  # noqa: E402

WC = WorldCup.load()
WC_LOCK = threading.Lock()
UI_DIR = os.path.join(ROOT, "ui")
LIVE_LOG = os.path.join(ROOT, "runs", "live.jsonl")

# name -> (executable path, launch prefix)
ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "js-alphabeta":  [os.path.join(ROOT, "bots", "js-alphabeta", "js-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
}
ENGINE_META = {
    "cpp-alphabeta": {"lang": "C++", "country": "DE", "color": "#e63946"},
    "rs-alphabeta":  {"lang": "Rust", "country": "SE", "color": "#dea584"},
    "js-alphabeta":  {"lang": "JavaScript", "country": "US", "color": "#f7df1e"},
    "py-mcts":       {"lang": "Python", "country": "BR", "color": "#2a9d8f"},
    "py-alphabeta":  {"lang": "Python", "country": "BR", "color": "#f4a261"},
    "cpp-greedy":    {"lang": "C++", "country": "DE", "color": "#e76f51"},
    "py-greedy":     {"lang": "Python", "country": "BR", "color": "#8ab17d"},
    "random":        {"lang": "C++", "country": "AQ", "color": "#8d99ae"},
}

STATE = {"proc": None, "cfg": {}, "gen": 0, "lock": threading.Lock()}
GROUP_JSONL = os.path.join(ROOT, "runs", "group.jsonl")
BRACKET_LOG = os.path.join(ROOT, "runs", "bracket_live.jsonl")
BSTATE = {"proc": None, "gen": 0, "lock": threading.Lock()}


def start_bracket(budget, games):
    with BSTATE["lock"]:
        if BSTATE["proc"] and BSTATE["proc"].poll() is None:
            BSTATE["proc"].terminate()
            try:
                BSTATE["proc"].wait(timeout=3)
            except subprocess.TimeoutExpired:
                BSTATE["proc"].kill()
        open(BRACKET_LOG, "w").close()
        argv = ["python3", os.path.join(ROOT, "analysis", "run_bracket.py"),
                "--from-group", GROUP_JSONL, "--mode", "nodes",
                "--budget", str(budget), "--games", str(games),
                "--progress", BRACKET_LOG,
                "--out-jsonl", os.path.join(ROOT, "runs", "knockout_live.jsonl"),
                "--out-bracket", os.path.join(ROOT, "runs", "bracket_live.json")]
        BSTATE["proc"] = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, cwd=ROOT)
        BSTATE["gen"] += 1


def bracket_running():
    p = BSTATE["proc"]
    return p is not None and p.poll() is None


def start_match(cfg):
    with STATE["lock"]:
        if STATE["proc"] and STATE["proc"].poll() is None:
            STATE["proc"].terminate()
            try:
                STATE["proc"].wait(timeout=3)
            except subprocess.TimeoutExpired:
                STATE["proc"].kill()
        os.makedirs(os.path.dirname(LIVE_LOG), exist_ok=True)
        open(LIVE_LOG, "w").close()  # truncate
        e1, e2 = ENGINES[cfg["engine1"]], ENGINES[cfg["engine2"]]
        mode_flag = "--nodes" if cfg["mode"] == "nodes" else "--movetime"
        argv = [os.path.join(ROOT, "build", "orchestrator"),
                "--engine1"] + e1 + ["--engine2"] + e2 + [
                "--games", str(cfg["games"]), mode_flag, str(cfg["budget"]),
                "--log", LIVE_LOG, "--seed1", "101", "--seed2", "202"]
        STATE["proc"] = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, cwd=ROOT)
        STATE["cfg"] = cfg
        STATE["gen"] += 1


def match_running():
    p = STATE["proc"]
    return p is not None and p.poll() is None


# ---------------------------------------------------------------------------
# Route registry. Extension modules can register routes without editing core:
# they expose module-level GET_ROUTES / POST_ROUTES dicts of {path: fn}.
#   GET_ROUTES[path]  = fn(handler, query_dict)
#   POST_ROUTES[path] = fn(handler, body_dict)
# These are merged and dispatched BEFORE the core handlers below. A route fn
# should send its own response (e.g. via handler._json(...)).
# ---------------------------------------------------------------------------
GET_ROUTES = {}
POST_ROUTES = {}


def register_routes(get_routes=None, post_routes=None):
    if get_routes:
        GET_ROUTES.update(get_routes)
    if post_routes:
        POST_ROUTES.update(post_routes)


def _load_extension_modules():
    """Import optional ui/api_betting.py and ui/api_analysis.py if present and
    merge their route dicts. They may not exist yet — import defensively."""
    import importlib
    for mod_name in ("api_betting", "api_analysis"):
        try:
            sys.path.insert(0, UI_DIR)
            mod = importlib.import_module(mod_name)
        except Exception:
            continue  # module absent or failed to import -> skip
        register_routes(getattr(mod, "GET_ROUTES", None),
                        getattr(mod, "POST_ROUTES", None))
        # allow a module to register imperatively too
        reg = getattr(mod, "register", None)
        if callable(reg):
            try:
                reg(register_routes)
            except Exception:
                pass


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        fn = POST_ROUTES.get(parsed.path)
        if fn is not None:
            n = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, json.JSONDecodeError):
                body = {}
            return fn(self, body)
        if self.path == "/api/start":
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            cfg = {"engine1": req.get("engine1", "cpp-alphabeta"),
                   "engine2": req.get("engine2", "py-mcts"),
                   "mode": req.get("mode", "movetime"),
                   "budget": int(req.get("budget", 250)),
                   "games": int(req.get("games", 6))}
            if cfg["engine1"] not in ENGINES or cfg["engine2"] not in ENGINES:
                return self._json({"error": "unknown engine"}, 400)
            start_match(cfg)
            return self._json({"ok": True, "cfg": cfg})
        if self.path == "/api/bracket-start":
            if not os.path.exists(GROUP_JSONL):
                return self._json({"error": "no group.jsonl — run the group stage first"}, 400)
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            start_bracket(int(req.get("budget", 12000)), int(req.get("games", 4)))
            return self._json({"ok": True})
        if self.path.startswith("/api/tournament/"):
            return self.tournament_post()
        self.send_error(404)

    def tournament_post(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        action = self.path.rsplit("/", 1)[1]
        with WC_LOCK:
            if action == "play":
                m = WC.play(req.get("match_id"))
                WC.save()
                return self._json({"ok": bool(m), "match": WC.public_match(m) if m else None,
                                   "state": WC.public_state()})
            if action == "advance":
                WC.advance(); WC.save()
                return self._json({"ok": True, "state": WC.public_state()})
            if action == "reset":
                WC.new(req.get("seed")); WC.save()
                return self._json({"ok": True, "state": WC.public_state()})
        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        fn = GET_ROUTES.get(parsed.path)
        if fn is not None:
            return fn(self, parse_qs(parsed.query))
        if self.path == "/api/config":
            return self._json({"engines": ENGINE_META, "available": list(ENGINES),
                               "cfg": STATE["cfg"], "running": match_running()})
        if self.path == "/api/stream":
            return self.stream()
        if self.path == "/api/bracket-stream":
            return self.bracket_stream()
        if self.path == "/api/tournament":
            with WC_LOCK:
                return self._json(WC.public_state())
        if self.path.startswith("/api/tournament/game"):
            qs = parse_qs(urlparse(self.path).query)
            with WC_LOCK:
                return self._json({"game": WC.game_of(qs.get("id", [""])[0])})
        # static files from ui/
        return super().do_GET()

    def bracket_stream(self):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            gen = BSTATE["gen"]
            pos = 0
            done_sent = False
            while True:
                if BSTATE["gen"] != gen:
                    gen = BSTATE["gen"]; pos = 0; done_sent = False
                    self._sse("reset", {})
                size = os.path.getsize(BRACKET_LOG) if os.path.exists(BRACKET_LOG) else 0
                if size < pos:
                    pos = 0; done_sent = False; self._sse("reset", {})
                if os.path.exists(BRACKET_LOG):
                    with open(BRACKET_LOG) as f:
                        f.seek(pos)
                        line = f.readline()
                        if line and line.endswith("\n"):
                            pos = f.tell()
                            rec = json.loads(line)
                            self._sse(rec.get("type", "tie_result"), rec)
                            continue
                if not bracket_running() and not done_sent:
                    self._sse("done", {}); done_sent = True
                self.wfile.write(b": keepalive\n\n"); self.wfile.flush()
                time.sleep(0.15)
        except (BrokenPipeError, ConnectionResetError):
            return

    def stream(self):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            cfg = dict(STATE["cfg"])
            cfg["engine_meta"] = ENGINE_META
            self._sse("config", cfg)

            gen = STATE["gen"]
            pos, idx = 0, 0
            last_id = int(self.headers.get("Last-Event-ID", -1) or -1)
            done_sent = False
            while True:
                if STATE["gen"] != gen:                 # a new match was started
                    gen = STATE["gen"]; pos = idx = 0; done_sent = False
                    self._sse("reset", {})
                try:
                    size = os.path.getsize(LIVE_LOG)
                except OSError:
                    size = 0
                if size < pos:                          # log truncated -> restart
                    pos = idx = 0; done_sent = False
                    self._sse("reset", {})
                with open(LIVE_LOG) as f:
                    f.seek(pos)
                    line = f.readline()
                    if line and line.endswith("\n"):
                        pos = f.tell()
                        if idx > last_id:
                            rec = json.loads(line)
                            self._sse(rec.get("type", "move"), rec, event_id=idx)
                        idx += 1
                        continue
                if not match_running() and not done_sent:
                    self._sse("done", {}); done_sent = True
                self.wfile.write(b": keepalive\n\n"); self.wfile.flush()
                time.sleep(0.15)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _sse(self, event, data, event_id=None):
        buf = ""
        if event_id is not None:
            buf += f"id: {event_id}\n"
        buf += f"event: {event}\n"
        buf += f"data: {json.dumps(data)}\n\n"
        self.wfile.write(buf.encode()); self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine1", default="cpp-alphabeta")
    ap.add_argument("--engine2", default="py-mcts")
    ap.add_argument("--mode", default="movetime", choices=["movetime", "nodes"])
    ap.add_argument("--budget", type=int, default=250)
    ap.add_argument("--games", type=int, default=6)
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    _load_extension_modules()

    start_match({"engine1": args.engine1, "engine2": args.engine2,
                 "mode": args.mode, "budget": args.budget, "games": args.games})

    handler = functools.partial(Handler, directory=UI_DIR)
    httpd = http.server.ThreadingHTTPServer(("", args.port), handler)
    print(f"Chess World Cup LIVE → http://localhost:{args.port}  (🔴 Live tab)")
    print(f"streaming: {args.engine1} vs {args.engine2} · {args.mode} {args.budget} · {args.games} games")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        if STATE["proc"]:
            STATE["proc"].terminate()


if __name__ == "__main__":
    main()
