#!/bin/bash
# Self-healing training supervisor (generalized). Usage: train-supervisor.sh <base> <dataset>
#   e.g. bash spike/train-supervisor.sh 4b whatsapp
# Why this exists: on the bigger bases a fine-tune can HANG right after an intermediate
# checkpoint save (an SDK worker locks up). Mitigation: run with NO intermediate checkpoints
# (finetune.js defaults checkpointSaveSteps very high). This supervisor adds the safety net:
# it watches for a HANG (no log progress) or a death, kills + restarts from scratch, caps
# attempts, and on success runs the base-vs-LoRA voice compare. Runs under caffeinate (no sleep).
set -u
BASE="${1:-4b}"
DATASET="${2:-whatsapp}"
DIR="/Users/thomasblanc/Documents/PRO/QVAC/QVAC-agent/test/23-second-self"
cd "$DIR" || exit 1
export PATH="$HOME/.bun/bin:$PATH"

ADAPTER="$DIR/train/results-${DATASET}-${BASE}/trained-lora-adapter.gguf"
SLOG="$DIR/train/supervisor-${BASE}.log"
STATUS="$DIR/train/status-${BASE}.txt"
COMPARE="$DIR/train/chat-compare-${BASE}.txt"
MAX_ATTEMPTS=6
HANG_SECS=420          # no new bytes in the run log for 7 min => hung (bigger base = slower steps)
POLL=30

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$SLOG"; }
setstatus(){ echo "$(date '+%Y-%m-%d %H:%M:%S') | $*" > "$STATUS"; }
killall_train(){ pkill -9 -f "finetune.js" 2>/dev/null; pkill -9 -f "spike/finetune" 2>/dev/null; pkill -9 -f "bare-runtime" 2>/dev/null; }

log "==================== supervisor START (base=$BASE dataset=$DATASET) ===================="
log "target adapter: $ADAPTER"

attempt=0
while [ ! -f "$ADAPTER" ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt+1))
  RLOG="$DIR/train/run-${BASE}-$attempt.log"
  log "---- attempt $attempt / $MAX_ATTEMPTS ----"
  setstatus "attempt $attempt: cleaning + launching"
  killall_train; sleep 2
  rm -rf "$DIR/train/results-${DATASET}-${BASE}" "$DIR/train/checkpoints-${DATASET}-${BASE}"

  node spike/finetune.js --data "$DATASET" --base "$BASE" --ctx 256 --epochs 1 > "$RLOG" 2>&1 &
  TPID=$!
  log "attempt $attempt: pid $TPID, log $RLOG"

  # Hang detection: the real failure mode was a worker LOCK *after* a checkpoint, i.e. once
  # training had started. Model download + load are legitimately silent for minutes (the
  # registry client does not log per-chunk), so a log-byte stall before the first step is NOT
  # a hang. So: only stall-kill once a training step has appeared; before that, allow a long
  # load/download phase (45 min) before giving up.
  last_size=0; stall=0; started=0; elapsed=0
  while kill -0 "$TPID" 2>/dev/null; do
    sleep "$POLL"; elapsed=$((elapsed+POLL))
    cur_size=$(wc -c < "$RLOG" 2>/dev/null || echo 0)
    if [ "$cur_size" -ne "$last_size" ]; then stall=0; last_size=$cur_size; else stall=$((stall+POLL)); fi
    step=$(grep -oE "step [0-9]+" "$RLOG" 2>/dev/null | tail -1)
    [ -n "$step" ] && started=1
    setstatus "attempt $attempt: ${step:-loading} | stall ${stall}s | elapsed ${elapsed}s | started=${started} | $(date '+%H:%M:%S')"
    if [ "$started" -eq 1 ] && [ "$stall" -ge "$HANG_SECS" ]; then
      log "attempt $attempt: HUNG post-step at ${step} (no progress ${stall}s). killing + retrying."
      kill -9 "$TPID" 2>/dev/null; killall_train; break
    fi
    if [ "$started" -eq 0 ] && [ "$elapsed" -ge 2700 ]; then
      log "attempt $attempt: stuck in load/download >45min with no first step. killing + retrying."
      kill -9 "$TPID" 2>/dev/null; killall_train; break
    fi
  done
  wait "$TPID" 2>/dev/null

  if [ -f "$ADAPTER" ]; then log "attempt $attempt: SUCCESS (adapter written)."; break; fi
  if grep -q "DIVERGED_NAN" "$RLOG" 2>/dev/null; then
    log "attempt $attempt: DIVERGED to NaN. Stopping (needs a lower lr, not a blind retry)."
    setstatus "DIVERGED on attempt $attempt - needs attention"; break
  fi
  log "attempt $attempt: ended without adapter. last log: $(tail -1 "$RLOG" 2>/dev/null)"
done

if [ -f "$ADAPTER" ]; then
  SZ=$(du -h "$ADAPTER" | cut -f1)
  log "TRAINING DONE after $attempt attempt(s). adapter $SZ. Running base-vs-LoRA voice compare..."
  setstatus "training done ($attempt attempts); running chat-compare"
  killall_train; sleep 2
  node spike/chat-compare.js --data "$DATASET" --base "$BASE" --owner "Thomas" > "$COMPARE" 2>&1
  # version the adapter so the app's Chat Voice toggle can load it
  STAMP=$(date '+%Y-%m-%d-%H-%M')
  mkdir -p "$DIR/adapters"; cp "$ADAPTER" "$DIR/adapters/${BASE}-${STAMP}.gguf" 2>/dev/null
  log "chat-compare -> $COMPARE ; versioned adapter -> adapters/${BASE}-${STAMP}.gguf"
  setstatus "ALL DONE - adapter ($SZ) + chat-compare ready. attempts=$attempt"
  log "==================== supervisor DONE (SUCCESS) ===================="
else
  setstatus "FAILED after $attempt attempts - see train/run-${BASE}-*.log"
  log "==================== supervisor DONE (FAILED after $attempt attempts) ===================="
fi
killall_train
