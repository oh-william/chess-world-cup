// C++ UCI shim. A bot author implements meta() and search(); the shim handles
// the entire UCI dance, FEN/position parsing, time bookkeeping and self-reporting.
//
// Ship-a-new-language contract: the only bot-specific code is these two functions
// plus a main() that calls shim::run().
#pragma once

#include "libchess/board.h"

#include <cstdint>
#include <string>

namespace shim {

// Tournament metadata. `lang`, `family`, `country` extend the UCI handshake.
struct Meta {
    std::string name;
    std::string lang;
    std::string family;
    std::string country;
};

// Search budget for one move. A value < 0 means "not limited on this axis".
struct Limits {
    long long ms_left = -1;    // wall-clock budget in ms (movetime mode)
    long long nodes_left = -1; // node budget (fixed-node mode)
};

// Implemented by the bot:
Meta meta();
// Return a legal move for `board`. Write the number of nodes visited to
// `out_nodes` (used by the orchestrator's self-reported-time delta).
libchess::Move search(libchess::Board& board, const Limits& limits, uint64_t& out_nodes);

// Run the UCI loop on stdin/stdout. Returns the process exit code.
int run();

} // namespace shim
