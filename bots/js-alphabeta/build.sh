#!/bin/bash
# Compile the libchess C ABI to WebAssembly so the Node engine can reuse the
# perft-clean core (no native addons, no ffi-napi). Requires emscripten (emcc).
set -e
cd "$(dirname "$0")/../.."
emcc libchess/src/bitboard.cpp libchess/src/board.cpp libchess/src/uci.cpp libchess/src/c_api.cpp \
  -I libchess/include -O3 -std=c++20 \
  -sMODULARIZE=1 -sEXPORT_NAME=createLibchess \
  -sEXPORTED_FUNCTIONS=_lc_new,_lc_free,_lc_startpos,_lc_set_fen,_lc_fen,_lc_side_to_move,_lc_in_check,_lc_insufficient_material,_lc_legal_moves,_lc_make,_lc_unmake,_lc_eval,_lc_piece_at,_lc_move_to_uci,_lc_move_from_uci,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,getValue,setValue,HEAPU16 \
  -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=node \
  -o bots/js-alphabeta/libchess.js
echo "built bots/js-alphabeta/libchess.js (+ .wasm)"
