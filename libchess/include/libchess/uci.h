// libchess — UCI long-algebraic move conversion.
#pragma once

#include "types.h"
#include "board.h"
#include <string>

namespace libchess {

// e.g. e2e4, e7e8q. Castling is encoded king-to-target (e1g1).
std::string to_uci(Move m);

// Parse a UCI move against the given position. Returns MOVE_NONE if the string
// is malformed or does not correspond to a legal move (i.e. this doubles as a
// legality check). `board` is not modified.
Move from_uci(Board& board, const std::string& uci);

} // namespace libchess
