#!/bin/bash
cd "$(dirname "$0")/.."
echo "[tax] fixed-node $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-alphabeta/py-alphabeta \
  --games 20 --nodes 20000 --seed1 7 --seed2 8 --log runs/tax_nodes.jsonl > runs/tax_nodes.summary 2>&1
echo "[tax] wall-clock $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-alphabeta/py-alphabeta \
  --games 20 --movetime 100 --seed1 7 --seed2 8 --log runs/tax_time.jsonl > runs/tax_time.summary 2>&1
echo "[tax] DONE $(date)"
