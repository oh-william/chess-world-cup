#!/bin/bash
cd "$(dirname "$0")/.."
echo "[r2] group stage (8 engines) $(date)"
python3 analysis/run_tournament.py \
  --engines cpp-alphabeta,rs-alphabeta,js-alphabeta,py-alphabeta,py-mcts,cpp-greedy,py-greedy,random \
  --mode nodes --budget 8000 --games 2 --out runs/group.jsonl > runs/group.summary 2>&1
echo "[r2] knockout $(date)"
python3 analysis/run_bracket.py --from-group runs/group.jsonl \
  --mode nodes --budget 12000 --games 4 \
  --out-jsonl runs/knockout.jsonl --out-bracket runs/bracket.json > runs/bracket.summary 2>&1
echo "[r2] DONE $(date)"
