// Orchestrator — the only source of truth on time.
//
// Runs an N-game match between two persistent UCI engines, alternating colors
// from a forced opening book. Two modes: --movetime <ms> and --nodes <n>.
// It is the referee (validates every move against libchess, adjudicates the
// result) and the timekeeper (timestamps go -> bestmove with a monotonic clock).
// Emits a per-move JSONL log whose key column is the implementation tax:
//   delta_ms = orchestrator_ms - engine_self_reported_ms.
#include "process.h"

#include "libchess/board.h"
#include "libchess/uci.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace libchess;
using orch::Process;
using Clock = std::chrono::steady_clock;

namespace {

struct Options {
    std::string engine1, engine2;
    std::string book = "books/openings.txt";
    std::string log = "match.jsonl";
    int games = 100;
    bool nodes_mode = false;
    long long movetime = 100; // ms
    long long nodes = 100000;
    unsigned long long seed1 = 1, seed2 = 2;
};

struct Engine {
    Process proc;
    std::string name = "?", lang = "?", family = "?", country = "?";
};

// ---- accounting ---------------------------------------------------------
int g_protocol_errors = 0;
int g_timeouts = 0;
int g_illegal_moves = 0;

std::vector<std::string> split(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream ss(s);
    std::string t;
    while (ss >> t) out.push_back(t);
    return out;
}

std::vector<std::vector<std::string>> load_book(const std::string& path) {
    std::vector<std::vector<std::string>> book;
    std::ifstream in(path);
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        auto moves = split(line);
        if (!moves.empty()) book.push_back(moves);
    }
    return book;
}

// UCI handshake: uci -> (capture id lines) -> uciok, then isready -> readyok.
bool handshake(Engine& e) {
    e.proc.send("uci");
    std::string line; bool to;
    for (;;) {
        if (!e.proc.read_line(line, 5000, to)) return false;
        auto tok = split(line);
        if (tok.empty()) continue;
        if (tok[0] == "uciok") break;
        if (tok[0] == "id" && tok.size() >= 3) {
            std::string rest = line.substr(line.find(tok[1]) + tok[1].size() + 1);
            if (tok[1] == "name") e.name = rest;
            else if (tok[1] == "lang") e.lang = tok[2];
            else if (tok[1] == "family") e.family = tok[2];
            else if (tok[1] == "country") e.country = tok[2];
        }
    }
    e.proc.send("isready");
    for (;;) {
        if (!e.proc.read_line(line, 5000, to)) return false;
        if (split(line).front() == "readyok") return true;
    }
}

// Discarded warm-up so we measure chess, not JIT/first-call allocation.
void warmup(Engine& e, const Options& o) {
    e.proc.send("position startpos");
    if (o.nodes_mode) e.proc.send("go nodes " + std::to_string(o.nodes));
    else              e.proc.send("go movetime 2000");
    std::string line; bool to;
    while (e.proc.read_line(line, 10000, to)) {
        if (!split(line).empty() && split(line).front() == "bestmove") break;
        if (to) break;
    }
}

struct MoveResult {
    bool ok = false;
    bool timed_out = false;
    std::string uci;
    long long orch_ms = 0;
    long long self_ms = 0;
    long long self_nodes = 0;
};

MoveResult request_move(Engine& e, const std::string& moves_cmd, const Options& o) {
    MoveResult r;
    e.proc.send(moves_cmd);
    if (o.nodes_mode) e.proc.send("go nodes " + std::to_string(o.nodes));
    else              e.proc.send("go movetime " + std::to_string(o.movetime));

    // Deadline: generous slack over the budget so a healthy engine never trips it,
    // but a hung one is caught. Nodes mode has no wall budget, so use a fixed cap.
    long long budget_ms = o.nodes_mode ? 30000 : (o.movetime + 1000);
    auto t0 = Clock::now();
    auto deadline = t0 + std::chrono::milliseconds(budget_ms);

    std::string line;
    for (;;) {
        auto now = Clock::now();
        long long remaining =
            std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
        if (remaining <= 0) { r.timed_out = true; return r; }

        bool to = false;
        if (!e.proc.read_line(line, (int)remaining, to)) {
            r.timed_out = to;
            return r; // timeout or EOF/protocol error
        }
        auto tok = split(line);
        if (tok.empty()) continue;
        if (tok[0] == "info") {
            for (size_t i = 0; i + 1 < tok.size(); ++i) {
                if (tok[i] == "time") r.self_ms = std::stoll(tok[i + 1]);
                else if (tok[i] == "nodes") r.self_nodes = std::stoll(tok[i + 1]);
            }
        } else if (tok[0] == "bestmove") {
            auto t1 = Clock::now();
            r.orch_ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
            r.uci = tok.size() >= 2 ? tok[1] : "";
            r.ok = true;
            return r;
        }
    }
}

enum class Result { WHITE_WINS, BLACK_WINS, DRAW, ABORTED };

const char* result_str(Result r) {
    switch (r) {
        case Result::WHITE_WINS: return "1-0";
        case Result::BLACK_WINS: return "0-1";
        case Result::DRAW:       return "1/2-1/2";
        default:                 return "aborted";
    }
}

} // namespace

int main(int argc, char** argv) {
    init_attacks();
    Options o;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() { return std::string(argv[++i]); };
        if (a == "--engine1") o.engine1 = next();
        else if (a == "--engine2") o.engine2 = next();
        else if (a == "--book") o.book = next();
        else if (a == "--log") o.log = next();
        else if (a == "--games") o.games = std::stoi(next());
        else if (a == "--movetime") { o.movetime = std::stoll(next()); o.nodes_mode = false; }
        else if (a == "--nodes") { o.nodes = std::stoll(next()); o.nodes_mode = true; }
        else if (a == "--seed1") o.seed1 = std::stoull(next());
        else if (a == "--seed2") o.seed2 = std::stoull(next());
    }
    if (o.engine1.empty() || o.engine2.empty()) {
        std::cerr << "usage: orchestrator --engine1 P --engine2 P [--games N]"
                     " [--movetime MS | --nodes N] [--book F] [--log F]\n";
        return 2;
    }

    auto book = load_book(o.book);
    if (book.empty()) { std::cerr << "empty book: " << o.book << "\n"; return 2; }

    Engine e1, e2;
    if (!e1.proc.start(o.engine1, o.seed1) || !e2.proc.start(o.engine2, o.seed2)) {
        std::cerr << "failed to launch engines\n"; return 2;
    }
    if (!handshake(e1) || !handshake(e2)) {
        std::cerr << "handshake failed\n"; g_protocol_errors++; return 1;
    }
    warmup(e1, o);
    warmup(e2, o);

    std::ofstream log(o.log);
    std::printf("mode: %s   budget: %lld   games: %d\n",
                o.nodes_mode ? "nodes" : "movetime",
                o.nodes_mode ? o.nodes : o.movetime, o.games);
    std::printf("engine1: %s [lang=%s family=%s country=%s]\n",
                e1.name.c_str(), e1.lang.c_str(), e1.family.c_str(), e1.country.c_str());
    std::printf("engine2: %s [lang=%s family=%s country=%s]\n\n",
                e2.name.c_str(), e2.lang.c_str(), e2.family.c_str(), e2.country.c_str());

    int w1 = 0, w2 = 0, draws = 0, completed = 0;
    const int MAX_PLIES = 800;
    bool fatal = false;

    for (int g = 0; g < o.games && !fatal; ++g) {
        const auto& opening = book[(g / 2) % book.size()];
        bool e1_white = (g % 2 == 0);
        Engine& white = e1_white ? e1 : e2;
        Engine& black = e1_white ? e2 : e1;

        white.proc.send("ucinewgame"); black.proc.send("ucinewgame");
        white.proc.send("isready");    black.proc.send("isready");
        std::string tmp; bool to;
        white.proc.read_line(tmp, 5000, to); black.proc.read_line(tmp, 5000, to);

        Board board; board.set_startpos();
        std::vector<std::string> moves;
        std::map<std::string, int> rep;
        int halfmove = 0;
        rep[board.fen()]++;

        // Apply the forced opening, tracking the 50-move clock as we go.
        for (const auto& uci : opening) {
            Move m = from_uci(board, uci);
            if (m == MOVE_NONE) { std::cerr << "bad book move " << uci << "\n"; break; }
            Color c;
            bool capture = board.piece_on(move_to(m), c) != NO_PIECE_TYPE ||
                           move_flag(m) == EN_PASSANT;
            bool pawn = board.piece_on(move_from(m), c) == PAWN;
            halfmove = (capture || pawn) ? 0 : halfmove + 1;
            board.make_move(m);
            moves.push_back(uci);
            rep[board.fen()]++;
        }

        Result res = Result::DRAW;
        std::string reason = "adjudicated";
        for (int ply = 0; ; ++ply) {
            // Terminal checks (referee side).
            MoveList legal; board.legal_moves(legal);
            if (legal.count == 0) {
                if (board.in_check()) {
                    res = board.side_to_move() == WHITE ? Result::BLACK_WINS
                                                        : Result::WHITE_WINS;
                    reason = "checkmate";
                } else { res = Result::DRAW; reason = "stalemate"; }
                break;
            }
            if (halfmove >= 100) { res = Result::DRAW; reason = "fifty-move"; break; }
            if (board.insufficient_material()) {
                res = Result::DRAW; reason = "insufficient-material"; break;
            }
            if (rep[board.fen()] >= 3) { res = Result::DRAW; reason = "repetition"; break; }
            if (ply >= MAX_PLIES) { res = Result::DRAW; reason = "max-plies"; break; }

            Color stm = board.side_to_move();
            Engine& mover = (stm == WHITE) ? white : black;

            std::string cmd = "position startpos";
            if (!moves.empty()) {
                cmd += " moves";
                for (auto& mv : moves) cmd += " " + mv;
            }
            std::string fen_before = board.fen();
            MoveResult mr = request_move(mover, cmd, o);

            if (mr.timed_out) {
                std::cerr << "TIMEOUT g" << g << " ply" << ply
                          << " engine " << mover.name << "\n";
                g_timeouts++; res = Result::ABORTED; fatal = true; break;
            }
            if (!mr.ok) {
                std::cerr << "PROTOCOL ERROR g" << g << " ply" << ply << "\n";
                g_protocol_errors++; res = Result::ABORTED; fatal = true; break;
            }

            Move m = from_uci(board, mr.uci);
            if (m == MOVE_NONE) {
                std::cerr << "ILLEGAL MOVE '" << mr.uci << "' g" << g << " ply" << ply
                          << " by " << mover.name << " in " << fen_before << "\n";
                g_illegal_moves++; res = Result::ABORTED; fatal = true; break;
            }

            // Update the 50-move clock: reset on pawn move or any capture.
            Color capc;
            bool capture = board.piece_on(move_to(m), capc) != NO_PIECE_TYPE ||
                           move_flag(m) == EN_PASSANT;
            bool pawn = board.piece_on(move_from(m), capc) == PAWN;
            halfmove = (capture || pawn) ? 0 : halfmove + 1;

            long long delta = mr.orch_ms - mr.self_ms;
            log << "{\"type\":\"move\",\"game\":" << g << ",\"ply\":" << ply
                << ",\"color\":\"" << (stm == WHITE ? "w" : "b") << "\""
                << ",\"engine\":\"" << mover.name << "\""
                << ",\"mode\":\"" << (o.nodes_mode ? "nodes" : "movetime") << "\""
                << ",\"budget\":" << (o.nodes_mode ? o.nodes : o.movetime)
                << ",\"move\":\"" << mr.uci << "\""
                << ",\"orch_ms\":" << mr.orch_ms
                << ",\"self_ms\":" << mr.self_ms
                << ",\"delta_ms\":" << delta
                << ",\"self_nodes\":" << mr.self_nodes
                << ",\"fen\":\"" << fen_before << "\"}\n";

            board.make_move(m);
            moves.push_back(mr.uci);
            rep[board.fen()]++;
        }

        if (fatal) break;
        completed++;
        // Score from engine1's perspective.
        bool white_is_e1 = e1_white;
        if (res == Result::WHITE_WINS) (white_is_e1 ? w1 : w2)++;
        else if (res == Result::BLACK_WINS) (white_is_e1 ? w2 : w1)++;
        else draws++;

        // Authoritative per-game result record (the UI/analysis read this).
        log << "{\"type\":\"result\",\"game\":" << g
            << ",\"mode\":\"" << (o.nodes_mode ? "nodes" : "movetime") << "\""
            << ",\"budget\":" << (o.nodes_mode ? o.nodes : o.movetime)
            << ",\"white\":\"" << white.name << "\",\"black\":\"" << black.name << "\""
            << ",\"white_country\":\"" << white.country << "\""
            << ",\"black_country\":\"" << black.country << "\""
            << ",\"result\":\"" << result_str(res) << "\""
            << ",\"reason\":\"" << reason << "\""
            << ",\"plies\":" << moves.size() << "}\n";

        std::printf("game %3d  %-8s(W) vs %-8s(B)  %-8s  %zu plies (%s)\n",
                    g, white.name.c_str(), black.name.c_str(),
                    result_str(res), moves.size(), reason.c_str());
    }

    e1.proc.stop();
    e2.proc.stop();
    log.close();

    std::printf("\n==== summary ====\n");
    std::printf("games completed : %d / %d\n", completed, o.games);
    std::printf("%s wins: %d   %s wins: %d   draws: %d\n",
                e1.name.c_str(), w1, e2.name.c_str(), w2, draws);
    std::printf("protocol errors : %d\n", g_protocol_errors);
    std::printf("timeouts        : %d\n", g_timeouts);
    std::printf("illegal moves   : %d\n", g_illegal_moves);
    std::printf("log written to  : %s\n", o.log.c_str());

    bool pass = g_protocol_errors == 0 && g_timeouts == 0 && g_illegal_moves == 0 &&
                completed == o.games;
    std::printf("\nGATE 2: %s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}
