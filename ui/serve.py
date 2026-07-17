#!/usr/bin/env python3
"""Serve the spectator UI locally. Run from the repo root:

    python3 ui/serve.py           # http://localhost:8000
    python3 ui/serve.py 9000      # custom port
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Chess World Cup UI → http://localhost:{PORT}")
    print("Ctrl-C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
