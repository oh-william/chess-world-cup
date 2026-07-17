// libchess — thin C ABI so bots in any language can reuse the core over FFI.
// (Bots may also write their own movegen — that's part of the experiment.)
#ifndef LIBCHESS_C_API_H
#define LIBCHESS_C_API_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* lc_board;

lc_board lc_new(void);
void     lc_free(lc_board b);

void     lc_startpos(lc_board b);
int      lc_set_fen(lc_board b, const char* fen); // 1 on success, 0 on failure
// Writes the current FEN (repetition key) into buf (>= 100 bytes recommended).
void     lc_fen(lc_board b, char* buf, int buf_len);

int      lc_side_to_move(lc_board b);   // 0 = white, 1 = black
int      lc_in_check(lc_board b);       // 1 / 0
int      lc_insufficient_material(lc_board b);

// Fills `out` with up to `max` legal moves (uint16 packed). Returns the count.
int      lc_legal_moves(lc_board b, uint16_t* out, int max);

void     lc_make(lc_board b, uint16_t move);
void     lc_unmake(lc_board b, uint16_t move);

// Static eval (material + piece-square tables), side-to-move relative, centipawns.
int      lc_eval(lc_board b);

// Move <-> UCI. lc_move_to_uci writes into buf (>= 6 bytes). lc_move_from_uci
// returns the packed move, or 0 (MOVE_NONE) if illegal/unparseable.
void     lc_move_to_uci(uint16_t move, char* buf);
uint16_t lc_move_from_uci(lc_board b, const char* uci);

#ifdef __cplusplus
}
#endif

#endif // LIBCHESS_C_API_H
