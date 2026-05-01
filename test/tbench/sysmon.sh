#!/bin/bash
# sysmon.sh — capture system + docker metrics during a tbench sweep so
# the post-mortem can retune RUMMY_TBENCH_CONCURRENCY empirically.
#
# Outputs three CSVs under <out-dir>:
#   sysmon.csv    — host RAM/swap/load every <interval-s> (default 15s)
#   containers.csv — per-container memory + CPU snapshot at the same cadence
#   oom.log       — every docker OOM-kill event with timestamp + container name
#
# Run alongside `harbor run`. runner.js auto-launches and SIGTERMs this on
# sweep exit; standalone usage is fine too.
#
# Args: <out-dir> [sample-interval-seconds]

set -euo pipefail

OUT="${1:?usage: sysmon.sh <out-dir> [interval-s]}"
INTERVAL="${2:-15}"
mkdir -p "$OUT"

SYS_CSV="$OUT/sysmon.csv"
CONT_CSV="$OUT/containers.csv"
OOM_LOG="$OUT/oom.log"

# Start docker OOM-event listener in the background. Records every
# OOM-killed container so we can correlate failures with memory pressure
# in the postmortem (`docker stats` only catches the moment, not the kill).
docker events --filter event=oom --format '{{.Time}} {{.Actor.Attributes.name}}' \
  > "$OOM_LOG" 2>/dev/null &
OOM_PID=$!
trap 'kill $OOM_PID 2>/dev/null || true' EXIT

# Headers
echo "ts,mem_used_mb,mem_avail_mb,mem_total_mb,swap_used_mb,swap_total_mb,load_1m,load_5m,load_15m,n_containers" > "$SYS_CSV"
echo "ts,container_name,mem_mb,mem_pct,cpu_pct" > "$CONT_CSV"

while true; do
  TS=$(date +%s)

  # Host-level memory + load + container count.
  read -r MEM_USED MEM_AVAIL MEM_TOTAL SWAP_USED SWAP_TOTAL < <(
    free -m | awk '
      /^Mem:/  {mu=$3; ma=$7; mt=$2}
      /^Swap:/ {su=$3; st=$2; print mu, ma, mt, su, st}
    '
  )
  read -r LOAD1 LOAD5 LOAD15 < <(awk '{print $1, $2, $3}' /proc/loadavg)
  N_CONT=$(docker ps -q 2>/dev/null | wc -l)
  echo "$TS,$MEM_USED,$MEM_AVAIL,$MEM_TOTAL,$SWAP_USED,$SWAP_TOTAL,$LOAD1,$LOAD5,$LOAD15,$N_CONT" >> "$SYS_CSV"

  # Per-container snapshot. `MemUsage` is like "1.5GiB / 30GiB" — split,
  # normalize to MiB. Skip empty (no containers running) cleanly.
  docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.MemPerc}}|{{.CPUPerc}}' 2>/dev/null \
    | while IFS='|' read -r NAME MEM_USAGE MEM_PCT CPU_PCT; do
        [[ -z "${NAME:-}" ]] && continue
        # Take left side of "1.5GiB / 30GiB"
        MEM_RAW="${MEM_USAGE%% *}"
        # Convert to MiB
        case "$MEM_RAW" in
          *GiB) MEM_MB=$(awk -v x="${MEM_RAW%GiB}" 'BEGIN{printf "%.1f", x*1024}') ;;
          *MiB) MEM_MB="${MEM_RAW%MiB}" ;;
          *KiB) MEM_MB=$(awk -v x="${MEM_RAW%KiB}" 'BEGIN{printf "%.3f", x/1024}') ;;
          *)    MEM_MB="0" ;;
        esac
        echo "$TS,$NAME,$MEM_MB,$MEM_PCT,$CPU_PCT" >> "$CONT_CSV"
      done

  sleep "$INTERVAL"
done
