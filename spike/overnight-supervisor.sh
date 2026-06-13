#!/bin/bash
# Self-healing overnight supervisor for the Second Self 1.7B LoRA fine-tune.
# Why this exists: the 1.7B run HUNG twice right after an intermediate checkpoint save
# (~step 300, an SDK worker locks up; the 600M never did this). Mitigation: run with NO
# intermediate checkpoints (finetune.js now defaults checkpointSaveSteps very high). This
# supervisor adds a safety net: it watches for a HANG (no log progress) or a death, kills +
# restarts from scratch, caps attempts, and on success runs the base-vs-LoRA voice compare.
# Everything is logged so the findings survive. Runs under caffeinate (no machine sleep).
set -u
DIR="/Users/thomasblanc/Documents/PRO/QVAC/QVAC-agent/test/23-second-self"
cd "$DIR" || exit 1
export PATH="$HOME/.bun/bin:$PATH"

ADAPTER="$DIR/train/results-whatsapp-1.7b/trained-lora-adapter.gguf"
SLOG="$DIR/train/overnight-supervisor.log"
STATUS="$DIR/train/overnight-status.txt"
COMPARE="$DIR/train/overnight-chat-compare.txt"
MAX_ATTEMPTS=6
HANG_SECS=300          # no new bytes in the run log for 5 min => hung
POLL=30

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$SLOG"; }
setstatus(){ echo "$(date '+%Y-%m-%d %H:%M:%S') | $*" > "$STATUS"; }
killall_train(){ pkill -9 -f "finetune.js" 2>/dev/null; pkill -9 -f "worker.js" 2>/dev/null; pkill -9 -f "bare-runtime" 2>/dev/null; }

log "==================== supervisor START ===================="
log "target adapter: $ADAPTER"

attempt=0
while [ ! -f "$ADAPTER" ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt+1))
  RLOG="$DIR/train/overnight-run-$attempt.log"
  log "---- attempt $attempt / $MAX_ATTEMPTS ----"
  setstatus "attempt $attempt: cleaning + launching"
  killall_train; sleep 2
  rm -rf "$DIR/train/results-whatsapp-1.7b" "$DIR/train/checkpoints-whatsapp-1.7b"

  node spike/finetune.js --data whatsapp --base 1.7b --ctx 256 --epochs 1 > "$RLOG" 2>&1 &
  TPID=$!
  log "attempt $attempt: pid $TPID, log $RLOG"

  last_size=0; stall=0
  while kill -0 "$TPID" 2>/dev/null; do
    sleep "$POLL"
    cur_size=$(wc -c < "$RLOG" 2>/dev/null || echo 0)
    if [ "$cur_size" -eq "$last_size" ]; then stall=$((stall+POLL)); else stall=0; last_size=$cur_size; fi
    step=$(grep -oE "step [0-9]+" "$RLOG" 2>/dev/null | tail -1)
    setstatus "attempt $attempt: ${step:-loading} | stall ${stall}s | $(date '+%H:%M:%S')"
    if [ "$stall" -ge "$HANG_SECS" ]; then
      log "attempt $attempt: HUNG at ${step:-?} (no progress ${stall}s). killing + retrying."
      kill -9 "$TPID" 2>/dev/null; killall_train
      break
    fi
  done
  wait "$TPID" 2>/dev/null

  if [ -f "$ADAPTER" ]; then log "attempt $attempt: SUCCESS (adapter written)."; break; fi
  if grep -q "DIVERGED_NAN" "$RLOG" 2>/dev/null; then
    log "attempt $attempt: DIVERGED to NaN. Stopping (needs a lower lr, not a blind retry)."
    setstatus "DIVERGED on attempt $attempt - needs attention"
    break
  fi
  log "attempt $attempt: ended without adapter. last log: $(tail -1 "$RLOG" 2>/dev/null)"
done

if [ -f "$ADAPTER" ]; then
  SZ=$(du -h "$ADAPTER" | cut -f1)
  log "TRAINING DONE after $attempt attempt(s). adapter $SZ. Running base-vs-LoRA voice compare..."
  setstatus "training done ($attempt attempts); running chat-compare"
  killall_train; sleep 2
  node spike/chat-compare.js --data whatsapp --base 1.7b --owner "Thomas" > "$COMPARE" 2>&1
  log "chat-compare written -> $COMPARE"
  setstatus "ALL DONE - adapter ($SZ) + chat-compare ready. attempts=$attempt"
  log "==================== supervisor DONE (SUCCESS) ===================="
else
  setstatus "FAILED after $attempt attempts - see train/overnight-run-*.log"
  log "==================== supervisor DONE (FAILED after $attempt attempts) ===================="
fi
killall_train
