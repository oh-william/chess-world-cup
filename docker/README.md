# Docker — one image per bot

Each engine runs in its own container so the orchestrator can enforce the
non-negotiables uniformly across 48 toolchains without dependency hell:

- **cpuset-pinned** — one core, no migration, so strength doesn't depend on the scheduler.
- **no network** — engines cannot phone home.
- **memory-capped** — a TT-hungry bot can't starve the box.

## Build

```bash
# base image builds libchess + every engine once
docker build -f docker/base.Dockerfile -t cwc-base .
docker build -f docker/cpp-alphabeta.Dockerfile -t cwc-cpp-alphabeta .
docker build -f docker/py-mcts.Dockerfile       -t cwc-py-mcts .
docker build -f docker/random.Dockerfile        -t cwc-random .
```

## Run (isolation flags the orchestrator applies)

```bash
docker run --rm -i \
    --cpuset-cpus=0 \        # pin to a single core
    --memory=512m \          # hard memory cap
    --network=none \         # no network
    --cpu-quota=-1 \         # turbo/quota policy set by the host
    -e ENGINE_SEED=1 \
    cwc-cpp-alphabeta
```

The container speaks UCI over stdin/stdout exactly like the native binary, so the
orchestrator is unchanged — it just execs `docker run ...` instead of the binary path.

## Note (Phase 0)

`cpuset` pinning and turbo disabling are **Linux-only**; on macOS/Windows the Docker
VM abstracts them away. The gates in this repo were measured natively on the dev machine;
containerized, pinned runs are what a real tournament host would use. These Dockerfiles
are the scaffolding for that host.
