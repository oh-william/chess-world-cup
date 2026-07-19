#include "libchess/board.h"

#include <cctype>
#include <sstream>

namespace libchess {

namespace {
// Rights remaining after a piece touches (moves from / to) a given square.
int castle_remain[SQUARE_NB];
bool tables_ready = false;

void init_tables() {
    if (tables_ready) return;
    for (int s = 0; s < SQUARE_NB; ++s) castle_remain[s] = ANY_CASTLING;
    castle_remain[A1] &= ~WHITE_OOO;
    castle_remain[H1] &= ~WHITE_OO;
    castle_remain[E1] &= ~(WHITE_OO | WHITE_OOO);
    castle_remain[A8] &= ~BLACK_OOO;
    castle_remain[H8] &= ~BLACK_OO;
    castle_remain[E8] &= ~(BLACK_OO | BLACK_OOO);
    tables_ready = true;
}
} // namespace

void Board::clear() {
    for (int c = 0; c < COLOR_NB; ++c) {
        occ_[c] = 0;
        for (int pt = 0; pt < PIECE_TYPE_NB; ++pt) pieces_[c][pt] = 0;
    }
    all_ = 0;
    stm_ = WHITE;
    castling_ = NO_CASTLING;
    ep_ = NO_SQUARE;
    history_.clear();
}

void Board::set_startpos() {
    set_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

PieceType Board::piece_on(Square s, Color& out_color) const {
    Bitboard b = square_bb(s);
    for (int c = 0; c < COLOR_NB; ++c)
        for (int pt = 0; pt < PIECE_TYPE_NB; ++pt)
            if (pieces_[c][pt] & b) { out_color = Color(c); return PieceType(pt); }
    out_color = WHITE;
    return NO_PIECE_TYPE;
}

namespace {
PieceType type_from_char(char c, Color& col) {
    col = std::isupper((unsigned char)c) ? WHITE : BLACK;
    switch (std::tolower((unsigned char)c)) {
        case 'p': return PAWN;   case 'n': return KNIGHT;
        case 'b': return BISHOP; case 'r': return ROOK;
        case 'q': return QUEEN;  case 'k': return KING;
    }
    return NO_PIECE_TYPE;
}
char char_from_type(Color c, PieceType pt) {
    const char* w = "PNBRQK";
    char ch = w[pt];
    return c == WHITE ? ch : char(std::tolower((unsigned char)ch));
}
} // namespace

bool Board::set_fen(const std::string& fen) {
    init_attacks();
    init_tables();
    clear();

    std::istringstream ss(fen);
    std::string placement, side, castle, ep;
    if (!(ss >> placement >> side >> castle >> ep)) return false;

    int rank = 7, file = 0;
    for (char c : placement) {
        if (c == '/') { rank--; file = 0; }
        else if (std::isdigit((unsigned char)c)) { file += c - '0'; }
        else {
            Color col; PieceType pt = type_from_char(c, col);
            if (pt == NO_PIECE_TYPE || file > 7 || rank < 0) return false;
            put(col, pt, make_square(file, rank));
            file++;
        }
    }

    stm_ = (side == "w") ? WHITE : BLACK;

    castling_ = NO_CASTLING;
    for (char c : castle) {
        switch (c) {
            case 'K': castling_ |= WHITE_OO;  break;
            case 'Q': castling_ |= WHITE_OOO; break;
            case 'k': castling_ |= BLACK_OO;  break;
            case 'q': castling_ |= BLACK_OOO; break;
            case '-': break;
        }
    }

    if (ep != "-" && ep.size() >= 2) {
        int f = ep[0] - 'a', r = ep[1] - '1';
        if (f >= 0 && f <= 7 && r >= 0 && r <= 7) ep_ = make_square(f, r);
    }
    return true;
}

std::string Board::fen() const {
    std::ostringstream ss;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f <= 7; ++f) {
            Color c; PieceType pt = piece_on(make_square(f, r), c);
            if (pt == NO_PIECE_TYPE) empty++;
            else {
                if (empty) { ss << empty; empty = 0; }
                ss << char_from_type(c, pt);
            }
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << (stm_ == WHITE ? " w " : " b ");
    std::string cr;
    if (castling_ & WHITE_OO)  cr += 'K';
    if (castling_ & WHITE_OOO) cr += 'Q';
    if (castling_ & BLACK_OO)  cr += 'k';
    if (castling_ & BLACK_OOO) cr += 'q';
    ss << (cr.empty() ? "-" : cr) << ' ';
    if (ep_ == NO_SQUARE) ss << '-';
    else ss << char('a' + file_of(ep_)) << char('1' + rank_of(ep_));
    ss << " 0 1";
    return ss.str();
}

namespace {
// Fixed Zobrist keys, generated once from a deterministic PRNG.
struct Zobrist {
    uint64_t piece[COLOR_NB][PIECE_TYPE_NB][SQUARE_NB];
    uint64_t side;
    uint64_t castling[16];
    uint64_t ep_file[8];
    Zobrist() {
        uint64_t s = 0x9E3779B97F4A7C15ULL;
        auto next = [&]() {
            s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
            return s * 0x2545F4914F6CDD1DULL;
        };
        for (int c = 0; c < COLOR_NB; ++c)
            for (int p = 0; p < PIECE_TYPE_NB; ++p)
                for (int sq = 0; sq < SQUARE_NB; ++sq) piece[c][p][sq] = next();
        side = next();
        for (int i = 0; i < 16; ++i) castling[i] = next();
        for (int i = 0; i < 8; ++i) ep_file[i] = next();
    }
};
const Zobrist ZOB;
} // namespace

uint64_t Board::hash() const {
    uint64_t h = 0;
    for (int c = 0; c < COLOR_NB; ++c)
        for (int p = 0; p < PIECE_TYPE_NB; ++p) {
            Bitboard b = pieces_[c][p];
            while (b) h ^= ZOB.piece[c][p][pop_lsb(b)];
        }
    if (stm_ == BLACK) h ^= ZOB.side;
    h ^= ZOB.castling[castling_ & 15];
    if (ep_ != NO_SQUARE) h ^= ZOB.ep_file[file_of(ep_)];
    return h;
}

bool Board::insufficient_material() const {
    // Any pawn, rook, or queen means mate is still possible.
    for (int c = 0; c < COLOR_NB; ++c)
        if (pieces_[c][PAWN] | pieces_[c][ROOK] | pieces_[c][QUEEN]) return false;

    int wN = popcount(pieces_[WHITE][KNIGHT]), wB = popcount(pieces_[WHITE][BISHOP]);
    int bN = popcount(pieces_[BLACK][KNIGHT]), bB = popcount(pieces_[BLACK][BISHOP]);
    int minors = wN + wB + bN + bB;

    if (minors <= 1) return true;                       // KvK, K+minor vs K
    if (minors == 2 && wB == 1 && bB == 1) {            // one bishop each
        Square wsq = lsb(pieces_[WHITE][BISHOP]);
        Square bsq = lsb(pieces_[BLACK][BISHOP]);
        int wcol = (file_of(wsq) + rank_of(wsq)) & 1;
        int bcol = (file_of(bsq) + rank_of(bsq)) & 1;
        return wcol == bcol;                            // draw only if same color
    }
    return false;
}

bool Board::is_attacked(Square s, Color by) const {
    if (PawnAttacks[~by][s] & pieces_[by][PAWN]) return true;
    if (KnightAttacks[s] & pieces_[by][KNIGHT]) return true;
    if (KingAttacks[s] & pieces_[by][KING]) return true;
    Bitboard bq = pieces_[by][BISHOP] | pieces_[by][QUEEN];
    if (bishop_attacks(s, all_) & bq) return true;
    Bitboard rq = pieces_[by][ROOK] | pieces_[by][QUEEN];
    if (rook_attacks(s, all_) & rq) return true;
    return false;
}

void Board::add_pawn_moves(MoveList& list) const {
    Color us = stm_, them = ~us;
    Bitboard pawns = pieces_[us][PAWN];
    int fwd = (us == WHITE) ? 8 : -8;
    int start_rank = (us == WHITE) ? 1 : 6;
    int promo_rank = (us == WHITE) ? 7 : 0;

    Bitboard p = pawns;
    while (p) {
        Square s = pop_lsb(p);
        Square one = Square(int(s) + fwd);
        if (!(all_ & square_bb(one))) {
            if (rank_of(one) == promo_rank) {
                list.add(encode_move(s, one, PROMOTION, QUEEN));
                list.add(encode_move(s, one, PROMOTION, ROOK));
                list.add(encode_move(s, one, PROMOTION, BISHOP));
                list.add(encode_move(s, one, PROMOTION, KNIGHT));
            } else {
                list.add(encode_move(s, one));
                if (rank_of(s) == start_rank) {
                    Square two = Square(int(one) + fwd);
                    if (!(all_ & square_bb(two))) list.add(encode_move(s, two));
                }
            }
        }
        Bitboard caps = PawnAttacks[us][s] & occ_[them];
        while (caps) {
            Square t = pop_lsb(caps);
            if (rank_of(t) == promo_rank) {
                list.add(encode_move(s, t, PROMOTION, QUEEN));
                list.add(encode_move(s, t, PROMOTION, ROOK));
                list.add(encode_move(s, t, PROMOTION, BISHOP));
                list.add(encode_move(s, t, PROMOTION, KNIGHT));
            } else {
                list.add(encode_move(s, t));
            }
        }
        if (ep_ != NO_SQUARE && (PawnAttacks[us][s] & square_bb(ep_)))
            list.add(encode_move(s, ep_, EN_PASSANT));
    }
}

void Board::add_piece_moves(MoveList& list) const {
    Color us = stm_;
    Bitboard targets = ~occ_[us];

    Bitboard b = pieces_[us][KNIGHT];
    while (b) { Square s = pop_lsb(b); Bitboard a = KnightAttacks[s] & targets;
        while (a) list.add(encode_move(s, pop_lsb(a))); }

    b = pieces_[us][BISHOP];
    while (b) { Square s = pop_lsb(b); Bitboard a = bishop_attacks(s, all_) & targets;
        while (a) list.add(encode_move(s, pop_lsb(a))); }

    b = pieces_[us][ROOK];
    while (b) { Square s = pop_lsb(b); Bitboard a = rook_attacks(s, all_) & targets;
        while (a) list.add(encode_move(s, pop_lsb(a))); }

    b = pieces_[us][QUEEN];
    while (b) { Square s = pop_lsb(b); Bitboard a = queen_attacks(s, all_) & targets;
        while (a) list.add(encode_move(s, pop_lsb(a))); }

    Square ks = king_sq(us);
    Bitboard a = KingAttacks[ks] & targets;
    while (a) list.add(encode_move(ks, pop_lsb(a)));
}

void Board::add_castling(MoveList& list) const {
    Color us = stm_, them = ~us;
    if (is_attacked(king_sq(us), them)) return; // no castling out of check

    if (us == WHITE) {
        if ((castling_ & WHITE_OO) && !(all_ & (square_bb(F1) | square_bb(G1))) &&
            !is_attacked(F1, them) && !is_attacked(G1, them))
            list.add(encode_move(E1, G1, CASTLING));
        if ((castling_ & WHITE_OOO) &&
            !(all_ & (square_bb(D1) | square_bb(C1) | square_bb(B1))) &&
            !is_attacked(D1, them) && !is_attacked(C1, them))
            list.add(encode_move(E1, C1, CASTLING));
    } else {
        if ((castling_ & BLACK_OO) && !(all_ & (square_bb(F8) | square_bb(G8))) &&
            !is_attacked(F8, them) && !is_attacked(G8, them))
            list.add(encode_move(E8, G8, CASTLING));
        if ((castling_ & BLACK_OOO) &&
            !(all_ & (square_bb(D8) | square_bb(C8) | square_bb(B8))) &&
            !is_attacked(D8, them) && !is_attacked(C8, them))
            list.add(encode_move(E8, C8, CASTLING));
    }
}

bool Board::leaves_king_safe(Move m) {
    Color mover = stm_;
    make_move(m);
    bool safe = !is_attacked(king_sq(mover), stm_);
    unmake_move(m);
    return safe;
}

void Board::legal_moves(MoveList& list) {
    MoveList pseudo;
    add_pawn_moves(pseudo);
    add_piece_moves(pseudo);
    add_castling(pseudo);
    for (int i = 0; i < pseudo.count; ++i)
        if (leaves_king_safe(pseudo.moves[i])) list.add(pseudo.moves[i]);
}

void Board::make_move(Move m) {
    Square from = move_from(m), to = move_to(m);
    MoveFlag flag = move_flag(m);
    Color us = stm_, them = ~us;

    Undo u;
    u.castling = castling_;
    u.ep = ep_;
    u.captured = NO_PIECE_TYPE;
    u.captured_sq = NO_SQUARE;

    ep_ = NO_SQUARE;

    // Identify the moving piece type.
    PieceType pt = NO_PIECE_TYPE;
    { Bitboard fb = square_bb(from);
      for (int t = 0; t < PIECE_TYPE_NB; ++t)
          if (pieces_[us][t] & fb) { pt = PieceType(t); break; } }

    if (flag == CASTLING) {
        move_piece(us, KING, from, to);
        // Move the rook.
        if (to == G1)      move_piece(us, ROOK, H1, F1);
        else if (to == C1) move_piece(us, ROOK, A1, D1);
        else if (to == G8) move_piece(us, ROOK, H8, F8);
        else if (to == C8) move_piece(us, ROOK, A8, D8);
    } else if (flag == EN_PASSANT) {
        Square cap_sq = Square(int(to) + (us == WHITE ? -8 : 8));
        remove(them, PAWN, cap_sq);
        u.captured = PAWN;
        u.captured_sq = cap_sq;
        move_piece(us, PAWN, from, to);
    } else {
        // Regular move: handle capture on `to`.
        if (occ_[them] & square_bb(to)) {
            Bitboard tb = square_bb(to);
            for (int t = 0; t < PIECE_TYPE_NB; ++t)
                if (pieces_[them][t] & tb) { u.captured = PieceType(t); break; }
            remove(them, u.captured, to);
            u.captured_sq = to;
        }
        move_piece(us, pt, from, to);
        if (flag == PROMOTION) {
            remove(us, PAWN, to);
            put(us, move_promo(m), to);
        } else if (pt == PAWN && (int(to) - int(from) == 16 || int(from) - int(to) == 16)) {
            ep_ = Square((int(from) + int(to)) / 2);
        }
    }

    castling_ &= castle_remain[from] & castle_remain[to];
    stm_ = them;
    history_.push_back(u);
}

void Board::unmake_move(Move m) {
    Square from = move_from(m), to = move_to(m);
    MoveFlag flag = move_flag(m);
    stm_ = ~stm_;              // back to the mover
    Color us = stm_, them = ~us;

    Undo u = history_.back();
    history_.pop_back();

    if (flag == CASTLING) {
        move_piece(us, KING, to, from);
        if (to == G1)      move_piece(us, ROOK, F1, H1);
        else if (to == C1) move_piece(us, ROOK, D1, A1);
        else if (to == G8) move_piece(us, ROOK, F8, H8);
        else if (to == C8) move_piece(us, ROOK, D8, A8);
    } else if (flag == EN_PASSANT) {
        move_piece(us, PAWN, to, from);
        put(them, PAWN, u.captured_sq);
    } else {
        if (flag == PROMOTION) {
            remove(us, move_promo(m), to);
            put(us, PAWN, from);
        } else {
            // Find the piece now on `to` (the one that moved) and move it back.
            PieceType pt = NO_PIECE_TYPE;
            Bitboard tb = square_bb(to);
            for (int t = 0; t < PIECE_TYPE_NB; ++t)
                if (pieces_[us][t] & tb) { pt = PieceType(t); break; }
            move_piece(us, pt, to, from);
        }
        if (u.captured != NO_PIECE_TYPE)
            put(them, u.captured, u.captured_sq);
    }

    castling_ = u.castling;
    ep_ = u.ep;
}

} // namespace libchess
