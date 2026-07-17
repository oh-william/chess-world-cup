// libchess — core types
// Square indexing: a1 = 0, b1 = 1, ..., h1 = 7, a2 = 8, ..., h8 = 63.
// rank = sq / 8, file = sq % 8. Bit i of a Bitboard corresponds to square i.
#pragma once

#include <cstdint>

namespace libchess {

using Bitboard = uint64_t;

enum Color : int { WHITE = 0, BLACK = 1, COLOR_NB = 2 };

enum PieceType : int {
    PAWN = 0, KNIGHT, BISHOP, ROOK, QUEEN, KING, PIECE_TYPE_NB = 6, NO_PIECE_TYPE = 7
};

enum Square : int {
    A1, B1, C1, D1, E1, F1, G1, H1,
    A2, B2, C2, D2, E2, F2, G2, H2,
    A3, B3, C3, D3, E3, F3, G3, H3,
    A4, B4, C4, D4, E4, F4, G4, H4,
    A5, B5, C5, D5, E5, F5, G5, H5,
    A6, B6, C6, D6, E6, F6, G6, H6,
    A7, B7, C7, D7, E7, F7, G7, H7,
    A8, B8, C8, D8, E8, F8, G8, H8,
    NO_SQUARE = 64, SQUARE_NB = 64
};

// Castling rights, one bit each.
enum CastlingRight : int {
    NO_CASTLING = 0,
    WHITE_OO  = 1,
    WHITE_OOO = 2,
    BLACK_OO  = 4,
    BLACK_OOO = 8,
    ANY_CASTLING = 15
};

constexpr Color operator~(Color c) { return Color(c ^ BLACK); }

constexpr int rank_of(Square s) { return int(s) >> 3; }
constexpr int file_of(Square s) { return int(s) & 7; }
constexpr Square make_square(int file, int rank) { return Square((rank << 3) | file); }

// A move is packed into 16 bits:
//   bits 0-5   : from square
//   bits 6-11  : to square
//   bits 12-13 : promotion piece type - KNIGHT (0=N,1=B,2=R,3=Q)
//   bits 14-15 : move flag (0 normal, 1 promotion, 2 en passant, 3 castling)
enum MoveFlag : int { NORMAL = 0, PROMOTION = 1, EN_PASSANT = 2, CASTLING = 3 };

using Move = uint16_t;

constexpr Move encode_move(Square from, Square to, MoveFlag flag = NORMAL,
                           PieceType promo = KNIGHT) {
    return Move(int(from) | (int(to) << 6) | ((int(promo) - KNIGHT) << 12) |
                (int(flag) << 14));
}

constexpr Square move_from(Move m) { return Square(m & 0x3F); }
constexpr Square move_to(Move m)   { return Square((m >> 6) & 0x3F); }
constexpr MoveFlag move_flag(Move m) { return MoveFlag((m >> 14) & 0x3); }
constexpr PieceType move_promo(Move m) { return PieceType(((m >> 12) & 0x3) + KNIGHT); }

constexpr Move MOVE_NONE = 0;

} // namespace libchess
