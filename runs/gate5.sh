#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "[gate5] fixed-node match starting $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-mcts/py-mcts \
  --games 40 --nodes 20000 --seed1 11 --seed2 22 --log runs/gate5_nodes.jsonl > runs/gate5_nodes.summary 2>&1
echo "[gate5] wall-clock match starting $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-mcts/py-mcts \
  --games 40 --movetime 100 --seed1 11 --seed2 22 --log runs/gate5_time.jsonl > runs/gate5_time.summary 2>&1
echo "[gate5] DONE $(date)"
