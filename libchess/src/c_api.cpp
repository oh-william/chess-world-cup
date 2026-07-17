#include "libchess/c_api.h"

#include "libchess/board.h"
#include "libchess/uci.h"

#include <cstring>
#include <string>

using namespace libchess;

// Shared material + piece-square eval so FFI bots get a real evaluation cheaply.
// Integer centipawns only. Tables are a8-first; white reads pst[sq^56], black pst[sq].
namespace {
const int kValue[6] = {100, 320, 330, 500, 900, 0};
const int kPST[6][64] = {
    {0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10,
     5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5,
     5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0},
    {-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30,
     -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
     -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50},
    {-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10,
     -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
     -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20},
    {0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
     -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0},
    {-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10,
     -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10,
     -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20},
    {-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
     -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
     20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20}};
} // namespace

extern "C" {

lc_board lc_new(void) {
    init_attacks();
    return new Board();
}
void lc_free(lc_board b) { delete static_cast<Board*>(b); }

void lc_startpos(lc_board b) { static_cast<Board*>(b)->set_startpos(); }
int lc_set_fen(lc_board b, const char* fen) {
    return static_cast<Board*>(b)->set_fen(fen) ? 1 : 0;
}
void lc_fen(lc_board b, char* buf, int buf_len) {
    std::string f = static_cast<Board*>(b)->fen();
    std::strncpy(buf, f.c_str(), buf_len - 1);
    buf[buf_len - 1] = '\0';
}

int lc_side_to_move(lc_board b) { return static_cast<Board*>(b)->side_to_move(); }
int lc_in_check(lc_board b) { return static_cast<Board*>(b)->in_check() ? 1 : 0; }
int lc_insufficient_material(lc_board b) {
    return static_cast<Board*>(b)->insufficient_material() ? 1 : 0;
}

int lc_legal_moves(lc_board b, uint16_t* out, int max) {
    MoveList list;
    static_cast<Board*>(b)->legal_moves(list);
    int n = list.count < max ? list.count : max;
    for (int i = 0; i < n; ++i) out[i] = list.moves[i];
    return n;
}

void lc_make(lc_board b, uint16_t move) { static_cast<Board*>(b)->make_move(move); }
void lc_unmake(lc_board b, uint16_t move) { static_cast<Board*>(b)->unmake_move(move); }

int lc_eval(lc_board b) {
    Board* bd = static_cast<Board*>(b);
    int score = 0;
    for (int pt = PAWN; pt <= KING; ++pt) {
        Bitboard w = bd->pieces(WHITE, PieceType(pt));
        while (w) { Square s = pop_lsb(w); score += kValue[pt] + kPST[pt][s ^ 56]; }
        Bitboard bl = bd->pieces(BLACK, PieceType(pt));
        while (bl) { Square s = pop_lsb(bl); score -= kValue[pt] + kPST[pt][s]; }
    }
    return bd->side_to_move() == WHITE ? score : -score;
}

void lc_move_to_uci(uint16_t move, char* buf) {
    std::string s = to_uci(move);
    std::strncpy(buf, s.c_str(), 5);
    buf[5] = '\0';
}
uint16_t lc_move_from_uci(lc_board b, const char* uci) {
    return from_uci(*static_cast<Board*>(b), std::string(uci));
}

} // extern "C"
