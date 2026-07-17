// A persistent child engine process: bidirectional pipes to its stdin/stdout,
// with line-buffered reads that support a timeout (so a hung engine is caught
// rather than blocking the tournament forever).
#pragma once

#include <string>

namespace orch {

class Process {
public:
    // Launch `path` with ENGINE_SEED set in the child's environment.
    bool start(const std::string& path, unsigned long long seed);

    // Write a command (a trailing newline is added).
    void send(const std::string& line);

    // Read one line into `out`. Returns false on timeout or EOF; `timed_out`
    // distinguishes the two.
    bool read_line(std::string& out, int timeout_ms, bool& timed_out);

    void stop(); // send "quit" and reap
    ~Process();

private:
    int         in_fd_  = -1; // we write here -> child stdin
    int         out_fd_ = -1; // we read here  <- child stdout
    long        pid_    = -1;
    std::string buf_;         // leftover bytes between line reads
};

} // namespace orch
