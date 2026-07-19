// cpp-analyst — the reference ANALYSIS engine. Deliberately stronger than any
// tournament bot: iterative-deepening alpha-beta + quiescence, a transposition
// table (Zobrist), killer + history move ordering, and PVS null-window scouts.
// Run at a high node budget it plays well above the field, so its eval and best
// line are a trustworthy "ground truth" for annotating games.
//
// Its own UCI loop (not the shim) so it can emit `info depth .. score cp .. pv ..`.
#include "libchess/board.h"
#include "libchess/uci.h"
#include "eval.h"                 // ab::evaluate / PieceValue (shared handcrafted eval)

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace libchess;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int INF = 1'000'000;
constexpr int MATE = 30'000;
constexpr int MAX_PLY = 64;

// ---- transposition table ----
enum { TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2 };
struct TTEntry { uint64_t key = 0; int32_t score = 0; int16_t depth = -1; uint8_t flag = 0; Move move = MOVE_NONE; };
std::vector<TTEntry> TT;
uint64_t TT_MASK = 0;
void tt_init(size_t mb) {
    size_t n = 1; while (n * sizeof(TTEntry) < mb * 1024 * 1024) n <<= 1;
    TT.assign(n, TTEntry{});
    TT_MASK = n - 1;
}

struct Search {
    uint64_t nodes = 0;
    bool node_mode = false; uint64_t node_limit = 0;
    bool time_mode = false; long long time_limit_ms = 0;
    Clock::time_point start;
    bool stop = false;
    Move killers[MAX_PLY][2] = {};
    int history[COLOR_NB][64][64] = {};

    bool budget_exceeded() {
        if (node_mode) return nodes >= node_limit;
        if (time_mode && (nodes & 2047) == 0) {
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
            if (ms >= time_limit_ms) return true;
        }
        return false;
    }
};

bool is_capture(const Board& b, Move m) {
    Color c;
    return b.piece_on(move_to(m), c) != NO_PIECE_TYPE || move_flag(m) == EN_PASSANT;
}

int move_score(const Board& b, Move m, Move tt_move, const Search& ss, int ply) {
    if (m == tt_move) return 1'000'000;
    Color c;
    PieceType victim = b.piece_on(move_to(m), c);
    if (victim != NO_PIECE_TYPE)
        return 100'000 + 100 * ab::PieceValue[victim] - ab::PieceValue[b.piece_on(move_from(m), c)];
    if (move_flag(m) == PROMOTION) return 90'000 + ab::PieceValue[move_promo(m)];
    if (m == ss.killers[ply][0] || m == ss.killers[ply][1]) return 80'000;
    return ss.history[b.side_to_move()][move_from(m)][move_to(m)];
}

void order(const Board& b, MoveList& list, Move tt_move, const Search& ss, int ply) {
    int keys[256];
    for (int i = 0; i < list.count; ++i) keys[i] = move_score(b, list.moves[i], tt_move, ss, ply);
    for (int i = 1; i < list.count; ++i) {
        Move m = list.moves[i]; int k = keys[i], j = i - 1;
        while (j >= 0 && keys[j] < k) { list.moves[j+1] = list.moves[j]; keys[j+1] = keys[j]; --j; }
        list.moves[j+1] = m; keys[j+1] = k;
    }
}

int quiesce(Board& b, int alpha, int beta, Search& ss) {
    ss.nodes++;
    if (ss.budget_exceeded()) { ss.stop = true; return alpha; }
    int stand = ab::evaluate(b);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    MoveList list; b.legal_moves(list);
    order(b, list, MOVE_NONE, ss, 0);
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

    uint64_t key = b.hash();
    TTEntry& e = TT[key & TT_MASK];
    Move tt_move = MOVE_NONE;
    if (e.key == key) {
        tt_move = e.move;
        if (e.depth >= depth) {
            if (e.flag == TT_EXACT) return e.score;
            if (e.flag == TT_LOWER && e.score >= beta) return e.score;
            if (e.flag == TT_UPPER && e.score <= alpha) return e.score;
        }
    }

    MoveList list; b.legal_moves(list);
    if (list.count == 0) return b.in_check() ? -MATE + ply : 0;
    order(b, list, tt_move, ss, ply);

    int best = -INF, alpha0 = alpha;
    Move best_move = list.moves[0];
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i];
        b.make_move(m);
        int score;
        if (i == 0) score = -negamax(b, depth - 1, ply + 1, -beta, -alpha, ss);
        else {  // PVS: null-window scout, re-search on fail-high
            score = -negamax(b, depth - 1, ply + 1, -alpha - 1, -alpha, ss);
            if (score > alpha && score < beta)
                score = -negamax(b, depth - 1, ply + 1, -beta, -alpha, ss);
        }
        b.unmake_move(m);
        if (ss.stop) return best > -INF ? best : alpha;
        if (score > best) { best = score; best_move = m; }
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
            if (!is_capture(b, m)) {  // quiet cutoff -> killer + history
                if (ss.killers[ply][0] != m) { ss.killers[ply][1] = ss.killers[ply][0]; ss.killers[ply][0] = m; }
                ss.history[b.side_to_move()][move_from(m)][move_to(m)] += depth * depth;
            }
            break;
        }
    }
    uint8_t flag = best <= alpha0 ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
    if (e.key != key || e.depth <= depth) e = {key, best, (int16_t)depth, flag, best_move};
    return best;
}

// Follow TT best-moves from the root to print a principal variation.
std::string extract_pv(Board& b, int max_len) {
    std::string pv;
    std::vector<Move> made;
    for (int i = 0; i < max_len; ++i) {
        uint64_t key = b.hash();
        TTEntry& e = TT[key & TT_MASK];
        if (e.key != key || e.move == MOVE_NONE) break;
        // verify legality
        MoveList l; b.legal_moves(l);
        bool ok = false; for (int j = 0; j < l.count; ++j) if (l.moves[j] == e.move) { ok = true; break; }
        if (!ok) break;
        pv += (pv.empty() ? "" : " ") + to_uci(e.move);
        b.make_move(e.move); made.push_back(e.move);
    }
    for (auto it = made.rbegin(); it != made.rend(); ++it) b.unmake_move(*it);
    return pv;
}

void go(Board& b, long long nodes, long long movetime, int maxdepth) {
    Search ss;
    if (nodes >= 0) { ss.node_mode = true; ss.node_limit = (uint64_t)nodes; }
    if (movetime >= 0) { ss.time_mode = true; ss.time_limit_ms = std::max<long long>(1, movetime - 5); ss.start = Clock::now(); }
    if (maxdepth <= 0) maxdepth = MAX_PLY - 1;

    auto t0 = Clock::now();
    Move best = MOVE_NONE; int best_score = 0;
    for (int depth = 1; depth <= maxdepth; ++depth) {
        int score = negamax(b, depth, 0, -INF, INF, ss);
        if (ss.stop && depth > 1) break;
        best_score = score;
        uint64_t key = b.hash();
        if (TT[key & TT_MASK].key == key) best = TT[key & TT_MASK].move;
        long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        std::string pv = extract_pv(b, depth);
        std::cout << "info depth " << depth << " score cp " << score
                  << " nodes " << ss.nodes << " time " << ms << " pv " << pv << "\n";
        std::cout.flush();
        if (ss.stop) break;
        if (score > MATE - MAX_PLY || score < -MATE + MAX_PLY) break; // mate found
    }
    std::cout << "bestmove " << (best == MOVE_NONE ? "0000" : to_uci(best)) << "\n";
    std::cout.flush();
}

} // namespace

int main() {
    std::ios::sync_with_stdio(false);
    init_attacks();
    tt_init(64);
    Board board;
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream ss(line);
        std::string cmd; ss >> cmd;
        if (cmd == "uci") {
            std::cout << "id name cpp-analyst\nid author chess-world-cup\n"
                         "id lang C++\nid family analyst\nid country XX\nuciok\n";
            std::cout.flush();
        } else if (cmd == "isready") { std::cout << "readyok\n"; std::cout.flush(); }
        else if (cmd == "ucinewgame") { std::fill(TT.begin(), TT.end(), TTEntry{}); board.set_startpos(); }
        else if (cmd == "position") {
            std::string tok; ss >> tok;
            if (tok == "startpos") board.set_startpos();
            else if (tok == "fen") { std::string fen, p; for (int i = 0; i < 6 && (ss >> p); ++i) fen += (i ? " " : "") + p; board.set_fen(fen); }
            std::string t;
            while (ss >> t) { if (t == "moves") continue; Move m = from_uci(board, t); if (m != MOVE_NONE) board.make_move(m); }
        } else if (cmd == "go") {
            long long nodes = -1, movetime = -1; int depth = 0; std::string t;
            while (ss >> t) { if (t == "nodes") ss >> nodes; else if (t == "movetime") ss >> movetime; else if (t == "depth") ss >> depth; }
            if (nodes < 0 && movetime < 0 && depth <= 0) nodes = 500000;
            go(board, nodes, movetime, depth);
        } else if (cmd == "quit") break;
    }
    return 0;
}
