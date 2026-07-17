// Gate 1 — perft. Verifies libchess movegen against known-exact node counts,
// then reports NPS for perft(5) from the start position.
#include "libchess/board.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace libchess;

static uint64_t perft(Board& b, int depth) {
    if (depth == 0) return 1;
    MoveList list;
    b.legal_moves(list);
    if (depth == 1) return uint64_t(list.count);
    uint64_t nodes = 0;
    for (int i = 0; i < list.count; ++i) {
        b.make_move(list.moves[i]);
        nodes += perft(b, depth - 1);
        b.unmake_move(list.moves[i]);
    }
    return nodes;
}

struct Case { const char* name; const char* fen; std::vector<uint64_t> expected; };

int main() {
    init_attacks();

    std::vector<Case> cases = {
        {"startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
         {20, 400, 8902, 197281, 4865609, 119060324}},
        {"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
         {48, 2039, 97862, 4085603, 193690690}},
        {"position3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
         {14, 191, 2812, 43238, 674624, 11030083}},
    };

    bool all_ok = true;
    for (auto& c : cases) {
        printf("\n%s\n  %s\n", c.name, c.fen);
        Board b;
        if (!b.set_fen(c.fen)) { printf("  FEN PARSE FAILED\n"); all_ok = false; continue; }
        for (size_t d = 0; d < c.expected.size(); ++d) {
            Board bb;
            bb.set_fen(c.fen);
            uint64_t got = perft(bb, int(d + 1));
            bool ok = got == c.expected[d];
            all_ok &= ok;
            printf("  depth %zu: %14llu  expected %14llu  %s\n",
                   d + 1, (unsigned long long)got,
                   (unsigned long long)c.expected[d], ok ? "OK" : "*** FAIL ***");
        }
    }

    // NPS benchmark: perft(5) on startpos.
    {
        Board b;
        b.set_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        auto t0 = std::chrono::steady_clock::now();
        uint64_t nodes = perft(b, 5);
        auto t1 = std::chrono::steady_clock::now();
        double secs = std::chrono::duration<double>(t1 - t0).count();
        printf("\nperft(5) startpos: %llu nodes in %.3f s = %.2f Mnodes/s\n",
               (unsigned long long)nodes, secs, nodes / secs / 1e6);
    }

    printf("\n%s\n", all_ok ? "ALL PERFT CASES PASS" : "PERFT FAILURES PRESENT");
    return all_ok ? 0 : 1;
}
