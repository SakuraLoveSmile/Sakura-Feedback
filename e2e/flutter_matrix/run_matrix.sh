#!/usr/bin/env bash
# 独立验证矩阵（T3 verifier 自建，不复用实现者的 tools/flutter-storage-matrix）。
#
# 每档做两件事，两条路径互相独立：
#  A) SUT 副本：把 flutter/feedback 原样复制到 work/<tier>/feedback（只改 pubspec 的一行
#     版本约束为精确版本），在副本里跑 flutter analyze + flutter test。复制前后记录
#     lib/ 与 test/ 的 sha256 清单，证明测试的就是工作区里的那份源码。
#  B) 隔离宿主：e2e/flutter_matrix/host（flutter create 生成）用 path 依赖引用
#     ../../flutter/feedback，把 flutter_secure_storage 固定为同一档位，
#     跑 host 自己的契约测试 —— 这条路径证明工作区真实 pubspec.yaml 的约束在
#     三档下都能解析（不改工作区文件）。
#
# 用法：run_matrix.sh [tier ...]   默认三档全跑
# 产物：out/<tier>/{pub_get.log,resolved.json,pub_deps.txt,analyze.log,test.log,host/*}
#       out/matrix-summary.tsv
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/flutter/bin:$PATH"
export PUB_CACHE="${PUB_CACHE:-$HOME/.pub-cache}"

WORK="$HERE/work"
OUT="$HERE/out"
SUT_SRC="$REPO/flutter/feedback"
HOST_DIR="$HERE/host"
CONSTRAINT_LINE="  flutter_secure_storage: '>=9.2.2 <12.0.0'"

TIERS=("$@")
if [ ${#TIERS[@]} -eq 0 ]; then
  TIERS=("9.2.2" "10.3.1" "11.0.0")
fi

mkdir -p "$WORK" "$OUT"

log() { printf '[matrix] %s\n' "$*"; }

# 把 pubspec.yaml 里的 flutter_secure_storage 约束改写成精确版本，写回 pubspec.pin.diff
pin_pubspec() {
  local pubspec="$1" tier="$2" out="$3"
  cp "$pubspec" "$pubspec.orig"
  python3 - "$pubspec" "$tier" <<'PY'
import re, sys
path, tier = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
pat = re.compile(r"^  flutter_secure_storage: .*$", re.M)
new, n = pat.subn(f"  flutter_secure_storage: '{tier}'", src)
if n != 1:
    sys.exit(f"expected exactly 1 flutter_secure_storage line, found {n}")
open(path, "w", encoding="utf-8").write(new)
PY
  local rc=$?
  diff -u "$pubspec.orig" "$pubspec" > "$out" 2>&1
  rm -f "$pubspec.orig"
  return $rc
}

sha_manifest() {
  local dir="$1" out="$2"
  ( cd "$dir" && find lib test -type f -name '*.dart' -print0 \
      | sort -z | xargs -0 shasum -a 256 > "$out" ) 2>/dev/null
  # 汇总哈希：整棵 lib/ + test/ 是否与工作区一致
  shasum -a 256 "$out" | awk '{print $1}'
}

run_tier() {
  local tier="$1"
  local tierdir="$WORK/$tier"
  local out="$OUT/$tier"
  mkdir -p "$tierdir" "$out"
  log "=== tier $tier ==="

  if [ "${SKIP_SUT:-0}" = "1" ]; then
    log "tier $tier: SKIP_SUT=1，复用已有 SUT 结果，只跑隔离宿主"
  else
  # --- A) SUT 副本 ---
  rsync -a --delete \
    --exclude 'build/' --exclude '.dart_tool/' --exclude '.mimosa/' \
    --exclude '.flutter-plugins-dependencies' --exclude 'pubspec.lock' \
    "$SUT_SRC/" "$tierdir/feedback/"
  local sut_hash_written
  sut_hash_written=$(sha_manifest "$tierdir/feedback" "$out/sut-source.sha256")
  local sut_hash_ws
  sut_hash_ws=$(sha_manifest "$SUT_SRC" "$out/workspace-source.sha256")
  {
    echo "tier=$tier"
    echo "sut_source_sha256=$sut_hash_written"
    echo "workspace_source_sha256=$sut_hash_ws"
    echo "identical=$([ "$sut_hash_written" = "$sut_hash_ws" ] && echo yes || echo NO)"
  } > "$out/source-identity.txt"

  pin_pubspec "$tierdir/feedback/pubspec.yaml" "$tier" "$out/pubspec.pin.diff"
  echo "pin_exit=$?" >> "$out/source-identity.txt"

  ( cd "$tierdir/feedback" && flutter pub get ) > "$out/pub_get.log" 2>&1
  echo "pub_get_exit=$?" > "$out/exitcodes.txt"

  python3 "$HERE/collect_versions.py" "$tierdir/feedback/pubspec.lock" "$tier" > "$out/resolved.json" 2> "$out/resolved.err"
  echo "collect_exit=$?" >> "$out/exitcodes.txt"

  ( cd "$tierdir/feedback" && flutter pub deps --style=compact ) > "$out/pub_deps.txt" 2>&1

  ( cd "$tierdir/feedback" && flutter analyze ) > "$out/analyze.log" 2>&1
  echo "analyze_exit=$?" >> "$out/exitcodes.txt"

  ( cd "$tierdir/feedback" && flutter test --reporter expanded ) > "$out/test.log" 2>&1
  echo "test_exit=$?" >> "$out/exitcodes.txt"

  grep -E '^\+[0-9]+.*(All tests passed|Some tests failed)|^[0-9]+:[0-9]+ \+[0-9]+' "$out/test.log" | tail -1 >> "$out/exitcodes.txt"
  fi

  # --- B) 隔离宿主（path 依赖工作区实现，不改工作区文件）---
  mkdir -p "$out/host"
  cp "$HOST_DIR/pubspec.yaml" "$tierdir/host.pubspec"
  pin_pubspec "$tierdir/host.pubspec" "$tier" "$out/host/pubspec.pin.diff"
  # 用临时宿主目录（宿主源码本身复用 host/，只有 pubspec 是每档生成的）
  rm -rf "$tierdir/host"
  mkdir -p "$tierdir/host"
  rsync -a --exclude 'build/' --exclude '.dart_tool/' \
    --exclude '.flutter-plugins-dependencies' --exclude 'pubspec.lock' \
    "$HOST_DIR/" "$tierdir/host/"
  cp "$tierdir/host.pubspec" "$tierdir/host/pubspec.yaml"
  # 工作副本比源目录深一层，path 依赖改写成绝对路径（只改工作副本）
  python3 - "$tierdir/host/pubspec.yaml" "$REPO" <<'PY'
import sys
path, repo = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
src = src.replace("path: ../../../flutter/feedback",
                  f"path: {repo}/flutter/feedback")
open(path, "w", encoding="utf-8").write(src)
PY
  { echo '--- pinned tier'; cat "$out/host/pubspec.pin.diff"; echo '--- absolute path dep'; grep -n 'path:' "$tierdir/host/pubspec.yaml"; } > "$out/host/pubspec.pin.diff.tmp"
  mv "$out/host/pubspec.pin.diff.tmp" "$out/host/pubspec.pin.diff"

  ( cd "$tierdir/host" && flutter pub get ) > "$out/host/pub_get.log" 2>&1
  echo "host_pub_get_exit=$?" >> "$out/exitcodes.txt"
  python3 "$HERE/collect_versions.py" "$tierdir/host/pubspec.lock" "$tier" > "$out/host/resolved.json" 2> "$out/host/resolved.err"

  ( cd "$tierdir/host" && flutter analyze ) > "$out/host/analyze.log" 2>&1
  echo "host_analyze_exit=$?" >> "$out/exitcodes.txt"

  ( cd "$tierdir/host" && flutter test --reporter expanded --dart-define=MATRIX_TIER="$tier" ) > "$out/host/test.log" 2>&1
  echo "host_test_exit=$?" >> "$out/exitcodes.txt"

  log "tier $tier done: $(tr '\n' ' ' < "$out/exitcodes.txt")"
}

for t in "${TIERS[@]}"; do
  run_tier "$t"
done

python3 "$HERE/summarize.py" "$OUT" "${TIERS[@]}" | tee "$OUT/matrix-summary.tsv"
