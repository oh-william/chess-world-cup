"""Python UCI shim — mirrors shim/cpp. A bot provides meta() and search(); the
shim handles the UCI dance, position/FEN parsing, time bookkeeping and the
self-reported timing line. Ship-a-new-language contract: only those two funcs.
"""
import sys
import time

from libchess_ffi import Board


class Limits:
    __slots__ = ("ms_left", "nodes_left")

    def __init__(self, ms_left=-1, nodes_left=-1):
        self.ms_left = ms_left
        self.nodes_left = nodes_left


def _apply_position(board, tokens):
    i = 0
    if tokens and tokens[0] == "startpos":
        board.startpos()
        i = 1
    elif tokens and tokens[0] == "fen":
        fen = " ".join(tokens[1:7])
        board.set_fen(fen)
        i = 7
    if i < len(tokens) and tokens[i] == "moves":
        for uci in tokens[i + 1:]:
            m = board.move_from_uci(uci)
            if m:
                board.make(m)


def _parse_go(tokens):
    lim = Limits()
    i = 0
    while i < len(tokens):
        if tokens[i] == "movetime" and i + 1 < len(tokens):
            lim.ms_left = int(tokens[i + 1]); i += 2
        elif tokens[i] == "nodes" and i + 1 < len(tokens):
            lim.nodes_left = int(tokens[i + 1]); i += 2
        else:
            i += 1
    return lim


def run(meta, search):
    board = Board()
    m = meta()
    out = sys.stdout
    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        cmd = parts[0]
        if cmd == "uci":
            out.write(f"id name {m['name']}\n")
            out.write("id author chess-world-cup\n")
            out.write(f"id lang {m['lang']}\n")
            out.write(f"id family {m['family']}\n")
            out.write(f"id country {m['country']}\n")
            out.write("uciok\n"); out.flush()
        elif cmd == "isready":
            out.write("readyok\n"); out.flush()
        elif cmd == "ucinewgame":
            board.startpos()
        elif cmd == "position":
            _apply_position(board, parts[1:])
        elif cmd == "go":
            lim = _parse_go(parts[1:])
            t0 = time.monotonic()
            best, nodes = search(board, lim)
            ms = int((time.monotonic() - t0) * 1000)
            uci = board.move_to_uci(best) if best else "0000"
            out.write(f"info time {ms} nodes {nodes}\n")
            out.write(f"bestmove {uci}\n"); out.flush()
        elif cmd == "quit":
            break
    return 0
