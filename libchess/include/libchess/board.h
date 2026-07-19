// libchess — board state, move generation, make/unmake.
#pragma once

#include "types.h"
#include "bitboard.h"
#include <string>
#include <vector>

namespace libchess {

// Fixed-capacity move list to avoid heap traffic in the hot path.
struct MoveList {
    Move moves[256];
    int  count = 0;
    void add(Move m) { moves[count++] = m; }
    const Move* begin() const { return moves; }
    const Move* end() const { return moves + count; }
    int size() const { return count; }
};

class Board {
public:
    Board() { set_startpos(); }

    void set_startpos();
    // Parse a FEN. Returns false on malformed input.
    bool set_fen(const std::string& fen);
    std::string fen() const;

    Color side_to_move() const { return stm_; }

    // Generate all fully-legal moves.
    void legal_moves(MoveList& list);

    // Apply / revert a move. make_move pushes irreversible state so unmake can
    // restore it exactly.
    void make_move(Move m);
    void unmake_move(Move m);

    bool in_check() const { return is_attacked(king_sq(stm_), ~stm_); }

    // Zobrist hash of the full position (placement + side + castling + ep file),
    // computed from scratch. For transposition tables in a search.
    uint64_t hash() const;

    // True for K vs K, K+minor vs K, and K+B vs K+B with same-colored bishops.
    // A conservative subset of the FIDE "impossibility of checkmate" rule.
    bool insufficient_material() const;

    // Is square `s` attacked by any piece of color `by` (using current occupancy)?
    bool is_attacked(Square s, Color by) const;

    PieceType piece_on(Square s, Color& out_color) const;

    // Read-only access for engine evaluation.
    Bitboard pieces(Color c, PieceType pt) const { return pieces_[c][pt]; }
    Bitboard occupancy(Color c) const { return occ_[c]; }
    Bitboard occupancy() const { return all_; }

private:
    Bitboard pieces_[COLOR_NB][PIECE_TYPE_NB]{}; // per color, per type
    Bitboard occ_[COLOR_NB]{};
    Bitboard all_{};
    Color    stm_ = WHITE;
    int      castling_ = NO_CASTLING;
    Square   ep_ = NO_SQUARE; // en-passant target square, or NO_SQUARE

    // Irreversible-state stack for unmake.
    struct Undo {
        int       castling;
        Square    ep;
        PieceType captured;    // NO_PIECE_TYPE if none
        Square    captured_sq; // where the captured piece stood (ep differs from `to`)
    };
    std::vector<Undo> history_;

    Square king_sq(Color c) const { return lsb(pieces_[c][KING]); }

    void put(Color c, PieceType pt, Square s) {
        Bitboard b = square_bb(s);
        pieces_[c][pt] |= b; occ_[c] |= b; all_ |= b;
    }
    void remove(Color c, PieceType pt, Square s) {
        Bitboard b = square_bb(s);
        pieces_[c][pt] &= ~b; occ_[c] &= ~b; all_ &= ~b;
    }
    void move_piece(Color c, PieceType pt, Square from, Square to) {
        remove(c, pt, from); put(c, pt, to);
    }

    void clear();
    void add_pawn_moves(MoveList& list) const;
    void add_piece_moves(MoveList& list) const;
    void add_castling(MoveList& list) const;
    bool leaves_king_safe(Move m);
};

} // namespace libchess
