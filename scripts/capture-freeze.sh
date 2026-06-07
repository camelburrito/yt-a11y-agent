#!/usr/bin/env bash
# Capture a DEFINITIVE artifact for the whole-machine freeze (macOS).
#
# Why a script: when the freeze hits, the local Terminal beachballs too — you can't type.
# So this PRE-STARTS background loggers that the kernel keeps writing to *through* the freeze
# (powermetrics samples in-kernel; unified logging buffers). Start it, reproduce the freeze,
# wait for recovery, then Ctrl-C. Everything lands in a timestamped folder.
#
# The hypothesis to confirm (2026-06-07 research, see docs/research/voice-audio-anti-freeze.md):
# the freeze is GPU/Metal → WindowServer COMPOSITOR STARVATION from on-device Gemini Nano, NOT
# coreaudiod and NOT the renderer main thread. The signature is:
#   GPU active residency ~100% for the whole freeze window, while CPU is NOT pegged on all
#   cores AND memory_pressure stays green — and, after recovery, the unified log contains
#   "kIOGPUCommandBufferCallbackErrorImpactingInteractivity".
#
# Usage:
#   1. (best) Run this from a SECOND machine? No — powermetrics must run locally. Instead:
#      run THIS on the frozen Mac (it pre-starts before the freeze), AND optionally also hold
#      an SSH session from another machine running:  sudo powermetrics --samplers gpu_power -i 500
#      (an ssh shell does no compositing, so it stays responsive while the display is frozen).
#   2. sudo ./scripts/capture-freeze.sh
#   3. In Chrome (flags on), opt into on-device Nano for the measurement run:
#        ytAgent.setModel(true); ytAgent.setEngine("nano")
#      then send a CONVERSATIONAL (non-command) utterance so a real session.prompt() runs.
#   4. When the machine recovers, come back here and press Ctrl-C.
#   5. Read OUT/SUMMARY.txt; attach the folder to the freeze investigation.
#
# Needs sudo (powermetrics + log).

set -u
if [[ "$(uname)" != "Darwin" ]]; then echo "macOS only."; exit 1; fi
if [[ "$EUID" -ne 0 ]]; then echo "Run with sudo: sudo $0"; exit 1; fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="freeze-capture-$TS"
mkdir -p "$OUT"
echo "Capturing into ./$OUT/  — reproduce the freeze now, Ctrl-C when recovered."

# 1) Power/GPU/ANE/CPU sampler — in-kernel, keeps writing through a UI freeze.
powermetrics --samplers gpu_power,cpu_power,ane_power,gpu_agpm -i 500 \
  > "$OUT/powermetrics.txt" 2>&1 &
PM_PID=$!

# 2) Unified log stream (GPU watchdog / WindowServer / coreaudiod) to a file.
log stream --style compact \
  --predicate 'eventMessage CONTAINS "Impacting Interactivity" OR eventMessage CONTAINS "kIOGPUCommandBuffer" OR process == "WindowServer" OR process == "coreaudiod"' \
  > "$OUT/logstream.txt" 2>&1 &
LOG_PID=$!

# 3) Memory-pressure ticker (rules swap in/out — should stay green if it's GPU, not memory).
( while true; do printf '%s ' "$(date +%H:%M:%S)"; memory_pressure 2>/dev/null | grep -i "System-wide memory free percentage" || echo "?"; sleep 1; done ) \
  > "$OUT/mem.txt" 2>&1 &
MEM_PID=$!

cleanup() {
  echo; echo "Stopping samplers…"
  kill "$PM_PID" "$LOG_PID" "$MEM_PID" 2>/dev/null
  wait "$PM_PID" "$LOG_PID" "$MEM_PID" 2>/dev/null

  # Post-recovery: pull the last 5 min of the corrected GPU-watchdog signature.
  echo "Collecting post-recovery log (corrected predicate)…"
  log show --last 5m --style compact \
    --predicate 'eventMessage CONTAINS "Impacting Interactivity" OR eventMessage CONTAINS "kIOGPUCommandBuffer" OR process == "WindowServer"' \
    > "$OUT/logshow.txt" 2>&1

  {
    echo "Freeze capture $TS"
    echo
    echo "== Corrected GPU-watchdog hits (the mechanism proof if present) =="
    grep -i "Impacting Interactivity\|kIOGPUCommandBuffer" "$OUT/logstream.txt" "$OUT/logshow.txt" 2>/dev/null | head -40 || echo "(none — mechanism NOT confirmed as GPU watchdog; check GPU residency below)"
    echo
    echo "== Peak GPU active-residency lines (look for ~100% sustained during the freeze) =="
    grep -i "GPU.*active residency\|GPU Power\|GPU HW active" "$OUT/powermetrics.txt" 2>/dev/null | tail -30 || echo "(see powermetrics.txt)"
    echo
    echo "== Memory pressure during window (should stay GREEN/high-free if it's GPU, not swap) =="
    tail -10 "$OUT/mem.txt" 2>/dev/null
    echo
    echo "Interpretation: GPU active ~100% for the whole freeze + CPU not pegged on all cores +"
    echo "memory green  ==> GPU/compositor starvation confirmed (re-enable Nano never; cloud only)."
    echo "Files: powermetrics.txt logstream.txt logshow.txt mem.txt"
  } > "$OUT/SUMMARY.txt"

  echo; echo "Done. Read ./$OUT/SUMMARY.txt"
  exit 0
}
trap cleanup INT TERM

# Idle until the user reproduces + recovers + Ctrl-C.
while true; do sleep 1; done
