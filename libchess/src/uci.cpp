#include "libchess/uci.h"

namespace libchess {

static std::string square_name(Square s) {
    std::string out;
    out += char('a' + file_of(s));
    out += char('1' + rank_of(s));
    return out;
}

std::string to_uci(Move m) {
    if (m == MOVE_NONE) return "0000";
    std::string out = square_name(move_from(m)) + square_name(move_to(m));
    if (move_flag(m) == PROMOTION) {
        const char* p = "nbrq";
        out += p[move_promo(m) - KNIGHT];
    }
    return out;
}

Move from_uci(Board& board, const std::string& uci) {
    if (uci.size() < 4) return MOVE_NONE;
    int ff = uci[0] - 'a', fr = uci[1] - '1';
    int tf = uci[2] - 'a', tr = uci[3] - '1';
    if (ff < 0 || ff > 7 || fr < 0 || fr > 7 || tf < 0 || tf > 7 || tr < 0 || tr > 7)
        return MOVE_NONE;
    Square from = make_square(ff, fr), to = make_square(tf, tr);

    PieceType promo = NO_PIECE_TYPE;
    if (uci.size() >= 5) {
        switch (uci[4]) {
            case 'n': promo = KNIGHT; break;
            case 'b': promo = BISHOP; break;
            case 'r': promo = ROOK;   break;
            case 'q': promo = QUEEN;  break;
            default: return MOVE_NONE;
        }
    }

    MoveList list;
    board.legal_moves(list);
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i];
        if (move_from(m) != from || move_to(m) != to) continue;
        if (move_flag(m) == PROMOTION) {
            if (promo != NO_PIECE_TYPE && move_promo(m) == promo) return m;
        } else {
            if (promo == NO_PIECE_TYPE) return m;
        }
    }
    return MOVE_NONE;
}

} // namespace libchess
