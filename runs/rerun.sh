#!/bin/bash
cd "$(dirname "$0")/.."
RS=bots/rs-alphabeta/target/release/rs-alphabeta
echo "[rerun] tax fixed-node $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-alphabeta/py-alphabeta \
  --games 20 --nodes 20000 --seed1 7 --seed2 8 --log runs/tax_nodes.jsonl > runs/tax_nodes.summary 2>&1
echo "[rerun] group stage (7 engines) $(date)"
python3 analysis/run_tournament.py \
  --engines cpp-alphabeta,rs-alphabeta,py-alphabeta,py-mcts,cpp-greedy,py-greedy,random \
  --mode nodes --budget 8000 --games 2 --out runs/group.jsonl > runs/group.summary 2>&1
echo "[rerun] tax wall-clock $(date)"
./build/orchestrator --engine1 ./build/cpp-alphabeta --engine2 ./bots/py-alphabeta/py-alphabeta \
  --games 20 --movetime 100 --seed1 7 --seed2 8 --log runs/tax_time.jsonl > runs/tax_time.summary 2>&1
echo "[rerun] DONE $(date)"
