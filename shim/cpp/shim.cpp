#include "shim.h"

#include "libchess/uci.h"

#include <chrono>
#include <iostream>
#include <sstream>
#include <string>

namespace shim {

using namespace libchess;

namespace {

// Rebuild the board from a `position` command:
//   position startpos [moves ...]
//   position fen <6 fields> [moves ...]
void apply_position(Board& board, std::istringstream& ss) {
    std::string token;
    ss >> token;
    if (token == "startpos") {
        board.set_startpos();
    } else if (token == "fen") {
        std::string fen, part;
        for (int i = 0; i < 6 && (ss >> part); ++i) {
            fen += part;
            if (i < 5) fen += ' ';
        }
        board.set_fen(fen);
    }
    // Optional moves.
    while (ss >> token) {
        if (token == "moves") continue;
        Move m = from_uci(board, token);
        if (m != MOVE_NONE) board.make_move(m);
    }
}

Limits parse_go(std::istringstream& ss) {
    Limits lim;
    std::string token;
    while (ss >> token) {
        if (token == "movetime") ss >> lim.ms_left;
        else if (token == "nodes") ss >> lim.nodes_left;
        // Other UCI go args (wtime/btime/depth/infinite) are ignored in Phase 0.
    }
    return lim;
}

} // namespace

int run() {
    std::ios::sync_with_stdio(false);
    Board board;
    Meta m = meta();

    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream ss(line);
        std::string cmd;
        ss >> cmd;

        if (cmd == "uci") {
            std::cout << "id name " << m.name << "\n"
                      << "id author chess-world-cup\n"
                      << "id lang " << m.lang << "\n"
                      << "id family " << m.family << "\n"
                      << "id country " << m.country << "\n"
                      << "uciok\n";
            std::cout.flush();
        } else if (cmd == "isready") {
            std::cout << "readyok\n";
            std::cout.flush();
        } else if (cmd == "ucinewgame") {
            board.set_startpos();
        } else if (cmd == "position") {
            apply_position(board, ss);
        } else if (cmd == "go") {
            Limits lim = parse_go(ss);
            uint64_t nodes = 0;
            auto t0 = std::chrono::steady_clock::now();
            Move best = search(board, lim, nodes);
            auto t1 = std::chrono::steady_clock::now();
            long long ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
            // Self-reported search time & nodes — the orchestrator subtracts this
            // from its own measurement to isolate the implementation tax.
            std::cout << "info time " << ms << " nodes " << nodes << "\n"
                      << "bestmove " << to_uci(best) << "\n";
            std::cout.flush();
        } else if (cmd == "quit") {
            break;
        }
    }
    return 0;
}

} // namespace shim
