"""ctypes binding to the libchess C ABI.

Bots reuse the perft-clean C++ core over FFI instead of re-implementing movegen
(they may write their own — that's part of the experiment, but py-mcts trusts
libchess). A Pythonic Board wrapper using make/unmake, so a search never copies.
"""
import ctypes
import os


def _find_lib():
    env = os.environ.get("LIBCHESS_LIB")
    if env and os.path.exists(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))  # shim/py
    root = os.path.dirname(os.path.dirname(here))       # repo root
    for name in ("liblibchess_c.dylib", "liblibchess_c.so"):
        p = os.path.join(root, "build", name)
        if os.path.exists(p):
            return p
    raise RuntimeError("libchess_c shared library not found; set LIBCHESS_LIB")


_lib = ctypes.CDLL(_find_lib())

_lib.lc_new.restype = ctypes.c_void_p
_lib.lc_free.argtypes = [ctypes.c_void_p]
_lib.lc_startpos.argtypes = [ctypes.c_void_p]
_lib.lc_set_fen.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
_lib.lc_set_fen.restype = ctypes.c_int
_lib.lc_fen.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
_lib.lc_side_to_move.argtypes = [ctypes.c_void_p]
_lib.lc_side_to_move.restype = ctypes.c_int
_lib.lc_in_check.argtypes = [ctypes.c_void_p]
_lib.lc_in_check.restype = ctypes.c_int
_lib.lc_insufficient_material.argtypes = [ctypes.c_void_p]
_lib.lc_insufficient_material.restype = ctypes.c_int
_lib.lc_legal_moves.argtypes = [ctypes.c_void_p,
                                ctypes.POINTER(ctypes.c_uint16), ctypes.c_int]
_lib.lc_legal_moves.restype = ctypes.c_int
_lib.lc_make.argtypes = [ctypes.c_void_p, ctypes.c_uint16]
_lib.lc_unmake.argtypes = [ctypes.c_void_p, ctypes.c_uint16]
_lib.lc_eval.argtypes = [ctypes.c_void_p]
_lib.lc_eval.restype = ctypes.c_int
_lib.lc_piece_at.argtypes = [ctypes.c_void_p, ctypes.c_int]
_lib.lc_piece_at.restype = ctypes.c_int
_lib.lc_move_to_uci.argtypes = [ctypes.c_uint16, ctypes.c_char_p]
_lib.lc_move_from_uci.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
_lib.lc_move_from_uci.restype = ctypes.c_uint16

WHITE, BLACK = 0, 1


class Board:
    __slots__ = ("_h", "_buf")

    def __init__(self):
        self._h = _lib.lc_new()
        self._buf = (ctypes.c_uint16 * 256)()

    def __del__(self):
        if getattr(self, "_h", None):
            _lib.lc_free(self._h)

    def startpos(self):
        _lib.lc_startpos(self._h)

    def set_fen(self, fen):
        return bool(_lib.lc_set_fen(self._h, fen.encode()))

    def fen(self):
        buf = ctypes.create_string_buffer(120)
        _lib.lc_fen(self._h, buf, 120)
        return buf.value.decode()

    def side_to_move(self):
        return _lib.lc_side_to_move(self._h)

    def in_check(self):
        return bool(_lib.lc_in_check(self._h))

    def insufficient(self):
        return bool(_lib.lc_insufficient_material(self._h))

    def legal_moves(self):
        n = _lib.lc_legal_moves(self._h, self._buf, 256)
        return self._buf[:n]

    def make(self, move):
        _lib.lc_make(self._h, move)

    def unmake(self, move):
        _lib.lc_unmake(self._h, move)

    def eval(self):
        return _lib.lc_eval(self._h)

    def piece_at(self, sq):
        return _lib.lc_piece_at(self._h, sq)

    def move_to_uci(self, move):
        buf = ctypes.create_string_buffer(6)
        _lib.lc_move_to_uci(move, buf)
        return buf.value.decode()

    def move_from_uci(self, uci):
        return _lib.lc_move_from_uci(self._h, uci.encode())


# Packed-move decode helpers (see libchess/types.h).
def move_from(m):  return m & 0x3F
def move_to(m):    return (m >> 6) & 0x3F
def move_flag(m):  return (m >> 14) & 0x3          # 0 normal 1 promo 2 ep 3 castle
def move_promo(m): return ((m >> 12) & 0x3) + 1    # KNIGHT=1 .. QUEEN=4
