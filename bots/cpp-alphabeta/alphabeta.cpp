// cpp-alphabeta — classical iterative-deepening alpha-beta + quiescence with a
// handcrafted integer eval. The speed pole of the tournament.
//
// Budget handling honours both non-negotiables:
//   * fixed-node mode (nodes_left >= 0): stops purely on node count, never reads
//     the clock — so it is bit-reproducible for a given (position, node budget).
//   * wall-clock mode (ms_left >= 0): checks the clock only every 2048 nodes.
#include "shim.h"
#include "eval.h"

#include "libchess/board.h"

#include <algorithm>
#include <chrono>
#include <cstdint>

using namespace libchess;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int INF = 1'000'000;
constexpr int MATE = 30'000;
constexpr int MAX_PLY = 64;

struct Search {
    uint64_t nodes = 0;
    bool     node_mode = false;
    uint64_t node_limit = 0;
    bool     time_mode = false;
    long long time_limit_ms = 0;
    Clock::time_point start;
    bool     stop = false;

    bool budget_exceeded() {
        if (node_mode) return nodes >= node_limit;
        if (time_mode && (nodes & 2047) == 0) {
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                          Clock::now() - start).count();
            if (ms >= time_limit_ms) return true;
        }
        return false;
    }
};

bool is_capture(const Board& b, Move m) {
    Color c;
    return b.piece_on(move_to(m), c) != NO_PIECE_TYPE || move_flag(m) == EN_PASSANT;
}

// MVV-LVA: most valuable victim, least valuable attacker; promotions rank high.
int move_score(const Board& b, Move m) {
    Color c;
    int s = 0;
    PieceType victim = b.piece_on(move_to(m), c);
    if (victim != NO_PIECE_TYPE)
        s += 100 * ab::PieceValue[victim] - ab::PieceValue[b.piece_on(move_from(m), c)];
    if (move_flag(m) == PROMOTION) s += 100 * ab::PieceValue[move_promo(m)];
    if (move_flag(m) == EN_PASSANT) s += 100 * ab::PieceValue[PAWN];
    return s;
}

void order(const Board& b, MoveList& list, Move hint) {
    // Selection sort by descending score; the hint (previous best) goes first.
    for (int i = 0; i < list.count; ++i) {
        int best = i;
        int best_key = (list.moves[i] == hint) ? INF : move_score(b, list.moves[i]);
        for (int j = i + 1; j < list.count; ++j) {
            int key = (list.moves[j] == hint) ? INF : move_score(b, list.moves[j]);
            if (key > best_key) { best_key = key; best = j; }
        }
        std::swap(list.moves[i], list.moves[best]);
    }
}

int quiesce(Board& b, int alpha, int beta, Search& ss) {
    ss.nodes++;
    if (ss.budget_exceeded()) { ss.stop = true; return alpha; }

    int stand = ab::evaluate(b);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    MoveList list;
    b.legal_moves(list);
    order(b, list, MOVE_NONE);
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i];
        if (!is_capture(b, m) && move_flag(m) != PROMOTION) continue;
        b.make_move(m);
        int score = -quiesce(b, -beta, -alpha, ss);
        b.unmake_move(m);
        if (ss.stop) return alpha;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

int negamax(Board& b, int depth, int ply, int alpha, int beta, Search& ss) {
    if (ss.budget_exceeded()) { ss.stop = true; return 0; }
    if (depth <= 0) return quiesce(b, alpha, beta, ss);
    ss.nodes++;

    MoveList list;
    b.legal_moves(list);
    if (list.count == 0)                          // mate or stalemate
        return b.in_check() ? -MATE + ply : 0;

    order(b, list, MOVE_NONE);
    int best = -INF;
    for (int i = 0; i < list.count; ++i) {
        b.make_move(list.moves[i]);
        int score = -negamax(b, depth - 1, ply + 1, -beta, -alpha, ss);
        b.unmake_move(list.moves[i]);
        if (ss.stop) return best > -INF ? best : alpha;
        if (score > best) best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;                 // beta cutoff
    }
    return best;
}

} // namespace

namespace shim {

Meta meta() {
    return Meta{"cpp-alphabeta", "C++", "alphabeta", "DE"};
}

Move search(Board& board, const Limits& limits, uint64_t& out_nodes) {
    Search ss;
    if (limits.nodes_left >= 0) {
        ss.node_mode = true;
        ss.node_limit = (uint64_t)limits.nodes_left;
    }
    if (limits.ms_left >= 0) {
        ss.time_mode = true;
        // Leave a small margin so we return inside the wall-clock budget.
        ss.time_limit_ms = std::max<long long>(1, limits.ms_left - 5);
        ss.start = Clock::now();
    }

    MoveList root;
    board.legal_moves(root);
    if (root.count == 0) { out_nodes = 0; return MOVE_NONE; }

    Move overall_best = root.moves[0]; // legal fallback if we can't finish depth 1
    Move depth_hint = MOVE_NONE;

    for (int depth = 1; depth < MAX_PLY; ++depth) {
        int alpha = -INF, beta = INF;
        Move local_best = MOVE_NONE;
        int best_score = -INF;

        order(board, root, depth_hint);
        for (int i = 0; i < root.count; ++i) {
            board.make_move(root.moves[i]);
            int score = -negamax(board, depth - 1, 1, -beta, -alpha, ss);
            board.unmake_move(root.moves[i]);
            if (ss.stop) break;
            if (score > best_score) { best_score = score; local_best = root.moves[i]; }
            if (score > alpha) alpha = score;
        }

        if (ss.stop) break;                 // discard this incomplete depth
        overall_best = local_best;
        depth_hint = local_best;
        if (best_score >= MATE - MAX_PLY) break; // forced mate found
    }

    out_nodes = ss.nodes;
    return overall_best;
}

} // namespace shim

int main() { return shim::run(); }
