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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(ROOT, "ui")
LIVE_LOG = os.path.join(ROOT, "runs", "live.jsonl")

# name -> (executable path, launch prefix)
ENGINES = {
    "cpp-alphabeta": [os.path.join(ROOT, "build", "cpp-alphabeta")],
    "random":        [os.path.join(ROOT, "build", "random")],
    "cpp-greedy":    [os.path.join(ROOT, "build", "cpp-greedy")],
    "rs-alphabeta":  [os.path.join(ROOT, "bots", "rs-alphabeta", "target", "release", "rs-alphabeta")],
    "py-mcts":       [os.path.join(ROOT, "bots", "py-mcts", "py-mcts")],
    "py-alphabeta":  [os.path.join(ROOT, "bots", "py-alphabeta", "py-alphabeta")],
    "py-greedy":     [os.path.join(ROOT, "bots", "py-greedy", "py-greedy")],
}
ENGINE_META = {
    "cpp-alphabeta": {"lang": "C++", "country": "DE", "color": "#e63946"},
    "rs-alphabeta":  {"lang": "Rust", "country": "SE", "color": "#dea584"},
    "py-mcts":       {"lang": "Python", "country": "BR", "color": "#2a9d8f"},
    "py-alphabeta":  {"lang": "Python", "country": "BR", "color": "#f4a261"},
    "cpp-greedy":    {"lang": "C++", "country": "DE", "color": "#e76f51"},
    "py-greedy":     {"lang": "Python", "country": "BR", "color": "#8ab17d"},
    "random":        {"lang": "C++", "country": "AQ", "color": "#8d99ae"},
}

STATE = {"proc": None, "cfg": {}, "gen": 0, "lock": threading.Lock()}


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
        self.send_error(404)

    def do_GET(self):
        if self.path == "/api/config":
            return self._json({"engines": ENGINE_META, "available": list(ENGINES),
                               "cfg": STATE["cfg"], "running": match_running()})
        if self.path == "/api/stream":
            return self.stream()
        # static files from ui/
        return super().do_GET()

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
