// cpp-greedy — depth-1 material/eval greedy. A cheap mid-strength engine that
// sits between random and the searchers; fills out the field. Reuses the same
// handcrafted eval as cpp-alphabeta.
#include "shim.h"
#include "eval.h"

#include "libchess/board.h"

#include <climits>

using namespace libchess;

namespace shim {

Meta meta() { return Meta{"cpp-greedy", "C++", "greedy", "DE"}; }

Move search(Board& board, const Limits&, uint64_t& out_nodes) {
    MoveList list;
    board.legal_moves(list);
    out_nodes = uint64_t(list.count);
    if (list.count == 0) return MOVE_NONE;

    int best = INT_MIN;
    Move best_move = list.moves[0];
    for (int i = 0; i < list.count; ++i) {
        board.make_move(list.moves[i]);
        int score = -ab::evaluate(board); // eval is opponent-relative after our move
        board.unmake_move(list.moves[i]);
        if (score > best) { best = score; best_move = list.moves[i]; }
    }
    return best_move;
}

} // namespace shim

int main() { return shim::run(); }
