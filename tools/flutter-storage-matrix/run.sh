#!/usr/bin/env bash
# flutter_secure_storage 9/10/11 三版本隔离矩阵执行器。
#
# 用法：
#   bash tools/flutter-storage-matrix/run.sh                       # 默认 9.2.2 10.3.1 11.0.0
#   bash tools/flutter-storage-matrix/run.sh 11.0.0                # CI 单档（矩阵策略每个 job 一档）
#   MATRIX_MUSIC_DIR=~/.../Music bash .../run.sh                   # 附带 Music 对照
#
# 每档做四件事（全部是真实命令、真实退出码）：
#   1) 把宿主 pubspec.yaml 的 flutter_secure_storage 约束改写成该档精确版本；
#   2) flutter pub get —— 正常依赖解析，全程不使用 dependency_overrides；
#   3) 记录实际解析到的插件与 federated 子包版本，并按档校验（check_tier.py）：
#      11 档还要对齐 Music 使用 11 的硬要求（Dart >=3.8 / Android minSdk 24 /
#      compileSdk 37 / windows 子包主版本）；
#   4) 把 flutter/feedback/test 整棵树同步到宿主 test/feedback/（同一份用例，
#      不在两处维护），然后 flutter analyze + flutter test。
#
# 证据写到 out/<档位>/（logs + resolved.json + 用例校验和），并汇总到
# out/matrix-summary.tsv。无论成败，结束时都把宿主约束还原为
# '>=9.2.2 <12.0.0' 并重新 pub get，保证工作区状态稳定。
#
# 退出码：0 = 所有档位通过；1 = 至少一档失败或校验不通过；2 = 环境问题。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
HOST="$HERE"
FEEDBACK_TEST_DIR="$REPO_ROOT/flutter/feedback/test"
DEFAULT_PIN='>=9.2.2 <12.0.0'
OUT_DIR="${MATRIX_OUT_DIR:-$HERE/out}"
MUSIC_DIR="${MATRIX_MUSIC_DIR:-$HOME/Documents/Code/Project/Personal Project/Music}"

TIERS=("$@")
if [ "${#TIERS[@]}" -eq 0 ]; then
  TIERS=(9.2.2 10.3.1 11.0.0)
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "flutter 不在 PATH：请先 export PATH=\"\$HOME/flutter/bin:\$PATH\"" >&2
  exit 2
fi
FLUTTER_SDK="$(cd "$(dirname "$(command -v flutter)")/.." && pwd)"
if [ ! -d "$FEEDBACK_TEST_DIR" ]; then
  echo "找不到组件测试目录：$FEEDBACK_TEST_DIR" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/matrix-summary.tsv"

pin_host() {
  local version="$1"
  python3 - "$HOST/pubspec.yaml" "$version" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
new, count = re.subn(
    r"(?m)^  flutter_secure_storage: .*$",
    f"  flutter_secure_storage: '{version}'",
    text,
)
if count != 1:
    sys.exit(f"期望恰好改写 1 行 flutter_secure_storage 约束，实际 {count} 行")
open(path, "w", encoding="utf-8").write(new)
PY
}

sync_feedback_tests() {
  local dest="$OUT_DIR/$1"
  rm -rf "$HOST/test/feedback"
  mkdir -p "$HOST/test/feedback"
  cp -R "$FEEDBACK_TEST_DIR/." "$HOST/test/feedback/"
  # 记录被复用用例的校验和（证明矩阵跑的就是组件包里的同一份源码）。
  python3 - "$FEEDBACK_TEST_DIR" "$dest/feedback-test-sha256.txt" <<'PY'
import hashlib, os, sys
src, out = sys.argv[1], sys.argv[2]
lines = []
for name in sorted(os.listdir(src)):
    path = os.path.join(src, name)
    if os.path.isfile(path) and name.endswith(".dart"):
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
        lines.append(f"{digest}  {name}")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"复用组件用例 {len(lines)} 个文件")
PY
}

overall=0
pub_get_exit=0
analyze_exit=0
test_exit=0
check_exit=0

# 安全网：任何中断（包括 set -u 触发的退出）都必须把宿主约束还原，
# 免得把“某一档固定版本”的中间状态留在工作区里。
ensure_default_pin() {
  if grep -q "flutter_secure_storage: '$DEFAULT_PIN'" "$HOST/pubspec.yaml"; then
    return 0
  fi
  pin_host "$DEFAULT_PIN" >/dev/null 2>&1 || true
  ( cd "$HOST" && flutter pub get ) > "$OUT_DIR/restore-pub-get.log" 2>&1 || true
}
trap ensure_default_pin EXIT

printf 'tier\tdart\tflutter_secure_storage\twindows\tplatform_interface\tdarwin\tpub_get\tanalyze\ttest\tresult\n' > "$SUMMARY"

for tier in "${TIERS[@]}"; do
  tier_dir="$OUT_DIR/$tier"
  mkdir -p "$tier_dir"
  echo
  echo "################ 档位 $tier ################"

  if ! pin_host "$tier" > "$tier_dir/pin.log" 2>&1; then
    echo "改写宿主约束失败（见 $tier_dir/pin.log）" >&2
    overall=1
    continue
  fi

  ( cd "$HOST" && flutter pub get ) > "$tier_dir/pub-get.log" 2>&1
  pub_get_exit=$?
  echo "flutter pub get exit=${pub_get_exit} 日志 $tier_dir/pub-get.log"
  ( cd "$HOST" && flutter pub deps --json ) > "$tier_dir/deps.json" 2>/dev/null \
    || rm -f "$tier_dir/deps.json"

  sync_feedback_tests "$tier" | tee "$tier_dir/test-provenance.log"

  ( cd "$HOST" && flutter analyze ) > "$tier_dir/analyze.log" 2>&1
  analyze_exit=$?
  echo "flutter analyze exit=${analyze_exit}"

  ( cd "$HOST" && flutter test \
      --dart-define=MATRIX_EXPECTED_SECURE_STORAGE_VERSION="$tier" ) \
    > "$tier_dir/test.log" 2>&1
  test_exit=$?
  echo "flutter test exit=${test_exit}"

  check_exit=0
  python3 "$HERE/check_tier.py" \
    --tier "$tier" \
    --host "$HOST" \
    --music "$MUSIC_DIR" \
    --flutter-sdk "$FLUTTER_SDK" \
    --example-gradle "$REPO_ROOT/examples/flutter/android/app/build.gradle.kts" \
    --json-out "$tier_dir/resolved.json" \
    | tee "$tier_dir/check.log"
  check_exit=${PIPESTATUS[0]}

  dart_version="$(python3 -c "
import json, os
path = '$tier_dir/deps.json'
if os.path.exists(path):
    data = json.load(open(path))
    for sdk in data.get('sdks', []):
        if sdk.get('name') == 'Dart':
            print(sdk.get('version', ''))
" 2>/dev/null)"
  read -r resolved windows interface darwin < <(python3 - "$HOST/pubspec.lock" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
def version(name):
    m = re.search(rf"(?m)^  {name}:\n(?:.*\n)*?    version: \"?([^\"\n]+)\"?$", text)
    return m.group(1) if m else "-"
print(version("flutter_secure_storage"), version("flutter_secure_storage_windows"),
      version("flutter_secure_storage_platform_interface"),
      version("flutter_secure_storage_darwin"))
PY
)

  result="PASS"
  if [ "$pub_get_exit" -ne 0 ] || [ "$analyze_exit" -ne 0 ] || [ "$test_exit" -ne 0 ] || [ "$check_exit" -ne 0 ]; then
    result="FAIL"
    overall=1
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$tier" "${dart_version:--}" "$resolved" "$windows" "$interface" "$darwin" \
    "$pub_get_exit" "$analyze_exit" "$test_exit" "$result" >> "$SUMMARY"
  echo "档位 $tier 结论：${result} check_exit=${check_exit}"
done

echo
echo "还原宿主约束为 $DEFAULT_PIN 并重新 pub get"
ensure_default_pin

echo
echo "================ 矩阵汇总 ${SUMMARY} ================"
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
echo
if [ "$overall" -eq 0 ]; then
  echo "矩阵结果：全部通过"
else
  echo "矩阵结果：存在失败档位" >&2
fi
exit "$overall"
