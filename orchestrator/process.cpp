#include "process.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <poll.h>
#include <string>
#include <sys/wait.h>
#include <unistd.h>

namespace orch {

bool Process::start(const std::string& path, unsigned long long seed) {
    int to_child[2];   // parent writes to_child[1] -> child reads to_child[0]
    int from_child[2]; // child writes from_child[1] -> parent reads from_child[0]
    if (pipe(to_child) != 0 || pipe(from_child) != 0) return false;

    pid_ = fork();
    if (pid_ < 0) return false;

    if (pid_ == 0) {
        // Child: wire pipes to stdio, set seed, exec.
        dup2(to_child[0], STDIN_FILENO);
        dup2(from_child[1], STDOUT_FILENO);
        close(to_child[0]); close(to_child[1]);
        close(from_child[0]); close(from_child[1]);

        std::string seed_str = std::to_string(seed);
        setenv("ENGINE_SEED", seed_str.c_str(), 1);

        execl(path.c_str(), path.c_str(), (char*)nullptr);
        _exit(127); // exec failed
    }

    // Parent.
    close(to_child[0]);
    close(from_child[1]);
    in_fd_ = to_child[1];
    out_fd_ = from_child[0];
    return true;
}

void Process::send(const std::string& line) {
    if (in_fd_ < 0) return;
    std::string data = line + "\n";
    ssize_t off = 0, n = (ssize_t)data.size();
    while (off < n) {
        ssize_t w = write(in_fd_, data.data() + off, n - off);
        if (w <= 0) break;
        off += w;
    }
}

bool Process::read_line(std::string& out, int timeout_ms, bool& timed_out) {
    timed_out = false;
    for (;;) {
        // Serve a complete line already sitting in the buffer.
        auto nl = buf_.find('\n');
        if (nl != std::string::npos) {
            out = buf_.substr(0, nl);
            buf_.erase(0, nl + 1);
            if (!out.empty() && out.back() == '\r') out.pop_back();
            return true;
        }

        struct pollfd pfd { out_fd_, POLLIN, 0 };
        int pr = poll(&pfd, 1, timeout_ms);
        if (pr == 0) { timed_out = true; return false; } // deadline hit
        if (pr < 0) { if (errno == EINTR) continue; return false; }

        char chunk[4096];
        ssize_t r = read(out_fd_, chunk, sizeof(chunk));
        if (r <= 0) return false; // EOF or error
        buf_.append(chunk, chunk + r);
    }
}

void Process::stop() {
    if (in_fd_ >= 0) { send("quit"); close(in_fd_); in_fd_ = -1; }
    if (out_fd_ >= 0) { close(out_fd_); out_fd_ = -1; }
    if (pid_ > 0) {
        int status = 0;
        // Give it a moment; if it lingers, it will be reaped on process exit.
        waitpid((pid_t)pid_, &status, 0);
        pid_ = -1;
    }
}

Process::~Process() { stop(); }

} // namespace orch
