// libchess — bitboards and attack generation (magic bitboards for sliders).
#pragma once

#include "types.h"

namespace libchess {

constexpr Bitboard FILE_A_BB = 0x0101010101010101ULL;
constexpr Bitboard RANK_1_BB = 0x00000000000000FFULL;

inline Bitboard square_bb(Square s) { return Bitboard(1) << int(s); }

inline int popcount(Bitboard b) { return __builtin_popcountll(b); }
inline Square lsb(Bitboard b) { return Square(__builtin_ctzll(b)); }
inline Square pop_lsb(Bitboard& b) {
    Square s = lsb(b);
    b &= b - 1;
    return s;
}

// Non-sliding attack tables, indexed by [square] (and [color] for pawns).
extern Bitboard PawnAttacks[COLOR_NB][SQUARE_NB];
extern Bitboard KnightAttacks[SQUARE_NB];
extern Bitboard KingAttacks[SQUARE_NB];

// Sliding attacks via magic lookup. `occ` is the full-board occupancy.
Bitboard rook_attacks(Square s, Bitboard occ);
Bitboard bishop_attacks(Square s, Bitboard occ);
inline Bitboard queen_attacks(Square s, Bitboard occ) {
    return rook_attacks(s, occ) | bishop_attacks(s, occ);
}

// Must be called once before any attack lookup. Idempotent.
void init_attacks();

} // namespace libchess
