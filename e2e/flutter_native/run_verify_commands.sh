#!/usr/bin/env bash
# T3 契约 verify 命令 + 队长收敛后的矩阵复跑（一次跑完，逐条记录真实退出码）。
#
# 用法：bash run_verify_commands.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out/verify"
export PATH="$HOME/flutter/bin:$PATH"
export JAVA_HOME="${JAVA_HOME_OVERRIDE:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT_OVERRIDE:-$HOME/Library/Android/sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"

mkdir -p "$OUT"
RESULT="$OUT/exitcodes.tsv"
: > "$RESULT"
log() { printf '[verify] %s\n' "$*"; }

record() { # name exit_code
  printf '%s\t%s\n' "$1" "$2" | tee -a "$RESULT"
}

# ---- 队长收敛：复跑实现者的三档矩阵脚本 ----
log "1) tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0"
( cd "$REPO" && bash tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0 ) \
  > "$OUT/matrix-replay.log" 2>&1
record "tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0" "$?"
cp "$REPO/tools/flutter-storage-matrix/out/matrix-summary.tsv" \
   "$OUT/matrix-summary.replay.tsv" 2>/dev/null || true

# ---- 契约 verify 命令 ----
log "2) flutter/feedback: flutter test"
( cd "$REPO/flutter/feedback" && flutter test --reporter expanded ) \
  > "$OUT/feedback-flutter-test.log" 2>&1
record "cd flutter/feedback && flutter test" "$?"

log "3) examples/flutter: flutter test"
( cd "$REPO/examples/flutter" && flutter test --reporter expanded ) \
  > "$OUT/examples-flutter-test.log" 2>&1
record "cd examples/flutter && flutter test" "$?"

log "4) examples/flutter: flutter build apk --debug"
( cd "$REPO/examples/flutter" && flutter build apk --debug ) \
  > "$OUT/examples-build-apk-debug.log" 2>&1
record "cd examples/flutter && flutter build apk --debug" "$?"

log "5) examples/flutter: flutter build ios --no-codesign"
( cd "$REPO/examples/flutter" && flutter build ios --no-codesign ) \
  > "$OUT/examples-build-ios-nocodesign.log" 2>&1
record "cd examples/flutter && flutter build ios --no-codesign" "$?"

log "6) security find-identity -v -p codesigning"
security find-identity -v -p codesigning > "$OUT/security-find-identity.txt" 2>&1
record "security find-identity -v -p codesigning" "$?"

# 记录 verify 期间被工具自动改写的 out-of-scope 生成物（随后还原）
log "7) 记录生成的 Podfile.lock 差异（examples/flutter/{ios,macos}）"
{
  for f in examples/flutter/ios/Podfile.lock examples/flutter/macos/Podfile.lock; do
    echo "=== $f"; git -C "$REPO" diff -- "$f"
  done
} > "$OUT/generated-lock-diffs.txt" 2>&1
wc -l "$OUT/generated-lock-diffs.txt"
log "done"
cat "$RESULT"
