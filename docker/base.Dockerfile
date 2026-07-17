# Base image: builds libchess (static + C ABI shared lib) and all engines once.
# Per-bot images derive from this and set an ENTRYPOINT. Engines run one-per-
# container so the orchestrator can pin/limit each independently (see README.md).
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ cmake make python3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /cwc
COPY . /cwc
RUN cmake -B build -S . -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

# Python bots load the C ABI via this path.
ENV LIBCHESS_LIB=/cwc/build/liblibchess_c.so
