// random — uniform random legal move. The Elo anchor and the protocol canary.
//
// Deliberately the dumbest possible engine: if the harness is broken, it breaks
// here first and cheaply. Seeded from ENGINE_SEED for reproducibility; the RNG
// state persists across the whole match (the process is never restarted).
#include "shim.h"

#include "libchess/board.h"

#include <cstdint>
#include <cstdlib>

using namespace libchess;

namespace {
uint64_t g_state = 0;
bool g_seeded = false;

void seed_once() {
    if (g_seeded) return;
    const char* env = std::getenv("ENGINE_SEED");
    g_state = env ? std::strtoull(env, nullptr, 10) : 0x9E3779B97F4A7C15ULL;
    if (g_state == 0) g_state = 0x9E3779B97F4A7C15ULL;
    g_seeded = true;
}

uint64_t next_rand() {
    g_state ^= g_state >> 12;
    g_state ^= g_state << 25;
    g_state ^= g_state >> 27;
    return g_state * 0x2545F4914F6CDD1DULL;
}
} // namespace

namespace shim {

Meta meta() {
    return Meta{"random", "C++", "random", "AQ"};
}

Move search(Board& board, const Limits&, uint64_t& out_nodes) {
    seed_once();
    MoveList list;
    board.legal_moves(list);
    out_nodes = uint64_t(list.count); // "nodes" = moves considered
    if (list.count == 0) return MOVE_NONE;
    return list.moves[next_rand() % uint64_t(list.count)];
}

} // namespace shim

int main() { return shim::run(); }
