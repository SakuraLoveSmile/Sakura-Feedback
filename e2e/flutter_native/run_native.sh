#!/usr/bin/env bash
# T3 verifier 独立原生验收（真实 macOS / iOS / Android，无 mock）。
#
# 子命令：
#   macos-denied     macOS 沙盒**不带** keychain-access-groups（ad-hoc 签名）→ 记录存储不可用时的错误表现
#   macos-entitled   macOS 沙盒**带** keychain-access-groups + Apple Development 签名 → 写/读(进程重启)/删
#   macos-release    Release 构建 + 签名/entitlement 核查（Debug 与 Release 配置对照）
#   android          Android 模拟器：真实构建 → 登录保存 / 进程重启读取 / 退出删除
#   android-migrate  Android 9→10→11 迁移：同一 applicationId + 同一 debug 签名，逐档升级安装
#
# 所有工作副本都在 e2e/flutter_native/work/ 下生成，不改动探针源码。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/flutter/bin:$PATH"
export JAVA_HOME="${JAVA_HOME_OVERRIDE:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"

PROBE_SRC="$HERE/keychain_probe"
WORK="$HERE/work"
OUT="$HERE/out"
BUNDLE_ID="com.feedbackverify.keychainProbe"
ANDROID_APP_ID="com.feedbackverify.keychain_probe"
IPAD_UDID="00008020-000424992241402E"
TEAM="C5Q966MAGT"

mkdir -p "$WORK" "$OUT"
log() { printf '[native] %s\n' "$*"; }

# 把探针复制到工作目录，并把 path 依赖改成绝对路径（工作副本更深一层）
prepare_probe() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  rsync -a --exclude 'build/' --exclude '.dart_tool/' \
    --exclude '.flutter-plugins-dependencies' --exclude 'pubspec.lock' \
    "$PROBE_SRC/" "$dest/"
  python3 - "$dest/pubspec.yaml" "$REPO" <<'PY'
import sys
path, repo = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
src = src.replace("path: ../../../flutter/feedback", f"path: {repo}/flutter/feedback")
open(path, "w", encoding="utf-8").write(src)
PY
}

# 给工作副本加上 keychain-access-groups 与 Apple Development 签名
sign_macos() {
  local dest="$1"
  python3 - "$dest" "$BUNDLE_ID" "$TEAM" <<'PY'
import sys
dest, bundle, team = sys.argv[1], sys.argv[2], sys.argv[3]
ents = f"""\t<key>keychain-access-groups</key>
\t<array>
\t\t<string>$(AppIdentifierPrefix){bundle}</string>
\t</array>
"""
for name in ("DebugProfile.entitlements", "Release.entitlements"):
    path = f"{dest}/macos/Runner/{name}"
    src = open(path, encoding="utf-8").read()
    if "keychain-access-groups" not in src:
        src = src.replace("</dict>", ents + "</dict>")
        open(path, "w", encoding="utf-8").write(src)
        print(f"entitlement added: {name}")
pbx = f"{dest}/macos/Runner.xcodeproj/project.pbxproj"
src = open(pbx, encoding="utf-8").read()
src = src.replace('CODE_SIGN_IDENTITY = "-";',
                  'CODE_SIGN_IDENTITY = "Apple Development";')
src = src.replace("CODE_SIGN_STYLE = Automatic;",
                  f"CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = {team};")
open(pbx, "w", encoding="utf-8").write(src)
print("pbxproj patched: Apple Development + DEVELOPMENT_TEAM")
PY
}

# 运行一个探针阶段；$1=工作副本 $2=tag $3=phase $4=expect $5=token $6=plaintext_root
run_phase() {
  local dest="$1" tag="$2" phase="$3" expect="$4" token="$5" root="${6:-}"
  local outdir="$OUT/native"
  mkdir -p "$outdir"
  log "run $tag phase=$phase expect=$expect"
  ( cd "$dest" && flutter test integration_test/probe_test.dart -d macos \
      --dart-define=PHASE="$phase" --dart-define=EXPECT="$expect" \
      --dart-define=TAG="$tag" --dart-define=TOKEN="$token" \
      --dart-define=PLAINTEXT_ROOT="$root" ) \
      > "$outdir/$tag.log" 2>&1
  local rc=$?
  echo "exit=$rc" > "$outdir/$tag.exit"
  grep -h '^PROBE_RESULT ' "$outdir/$tag.log" | tail -1 > "$outdir/$tag.result.json" || true
  grep -h '^PROBE_FILE ' "$outdir/$tag.log" | tail -1 >> "$outdir/$tag.result.json" || true
  # 真实 macOS 应用进程的 stdout 不一定回传到测试日志：直接从沙盒容器 tmp 取产物
  local container="$HOME/Library/Containers/$BUNDLE_ID/Data/tmp/probe-$tag.json"
  if [ -f "$container" ]; then
    cp "$container" "$outdir/$tag.result.json"
    echo "collected_from_container=$container" >> "$outdir/$tag.exit"
  fi
  tail -3 "$outdir/$tag.log"
  return $rc
}

macos_denied() {
  local dest="$WORK/macos-denied/keychain_probe"
  prepare_probe "$dest"
  mkdir -p "$OUT/native"
  {
    echo "variant=denied (ad-hoc 签名，无 keychain-access-groups)"
    grep -n 'CODE_SIGN_IDENTITY\|CODE_SIGN_STYLE\|DEVELOPMENT_TEAM' "$dest/macos/Runner.xcodeproj/project.pbxproj" | head -8
    echo "--- DebugProfile.entitlements"; cat "$dest/macos/Runner/DebugProfile.entitlements"
  } > "$OUT/native/macos-denied.config.txt" 2>&1
  local root="$HOME/Library/Containers/$BUNDLE_ID/Data"
  run_phase "$dest" macos-denied-errorprobe errorprobe denied "token-denied-probe" "$root" || true
  echo "--- 签名核查（构建产物）"
  ( cd "$dest" && flutter build macos --debug ) > "$OUT/native/macos-denied.build.log" 2>&1
  echo "build_exit=$?" >> "$OUT/native/macos-denied.build.log"
  local app="$dest/build/macos/Build/Products/Debug/keychain_probe.app"
  if [ -d "$app" ]; then
    codesign -dv --entitlements - "$app" > "$OUT/native/macos-denied.codesign.txt" 2>&1
    codesign -dv "$app" >> "$OUT/native/macos-denied.codesign.txt" 2>&1
  fi
}

# 受限 entitlement（keychain-access-groups）需要 Xcode 托管描述文件。
# flutter build 不传 -allowProvisioningUpdates，这里先用 xcodebuild 触发一次
# 描述文件生成（Flutter Assemble 阶段会失败，不影响签名解析，失败可忽略）。
prime_profile() {
  local dest="$1"
  ( cd "$dest/macos" && xcodebuild -workspace Runner.xcworkspace -scheme Runner \
      -configuration Debug -allowProvisioningUpdates -derivedDataPath /tmp/probe-dd build ) \
      > "$OUT/native/macos-prime.log" 2>&1
  echo "prime_exit=$?" >> "$OUT/native/macos-prime.log"
  ls -la "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/" \
      > "$OUT/native/macos-profiles.txt" 2>&1
  for p in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/"*.provisionprofile; do
    {
      echo "=== $p"
      security cms -D -i "$p" 2>/dev/null | plutil -p - 2>/dev/null \
        | grep -E 'AppIDName|application-identifier|keychain-access-groups|"[A-Za-z0-9.-]*C5Q966MAGT[^"]*"|ExpirationDate'
    } >> "$OUT/native/macos-profiles.txt" 2>&1
  done
}

macos_entitled() {
  local dest="$WORK/macos-entitled/keychain_probe"
  prepare_probe "$dest"
  sign_macos "$dest" | tee "$OUT/native/macos-entitled.patch.txt"
  mkdir -p "$OUT/native"
  {
    echo "variant=entitled (Apple Development 签名 + keychain-access-groups)"
    grep -n 'CODE_SIGN_IDENTITY\|CODE_SIGN_STYLE\|DEVELOPMENT_TEAM' "$dest/macos/Runner.xcodeproj/project.pbxproj" | head -8
    echo "--- DebugProfile.entitlements"; cat "$dest/macos/Runner/DebugProfile.entitlements"
    echo "--- Release.entitlements"; cat "$dest/macos/Runner/Release.entitlements"
  } > "$OUT/native/macos-entitled.config.txt" 2>&1
  local root="$HOME/Library/Containers/$BUNDLE_ID/Data"
  prime_profile "$dest"
  # 三次独立进程启动：write → read（真实进程重启）→ delete
  run_phase "$dest" macos-write write entitled "token-macos-v11" "$root" || true
  run_phase "$dest" macos-read read entitled "token-macos-v11" "$root" || true
  run_phase "$dest" macos-delete delete entitled "token-macos-v11" "$root" || true
  # 独立进程复核：删除后必须读不到
  run_phase "$dest" macos-absent absent entitled "token-macos-v11" "$root" || true
}

# 清理本轮测试数据：macOS 只删本探针自己的键；Android 直接卸载测试应用。
cleanup_all() {
  local dest="$WORK/macos-entitled/keychain_probe"
  mkdir -p "$OUT/native"
  prepare_probe "$dest"
  sign_macos "$dest" > /dev/null
  prime_profile "$dest"
  run_phase "$dest" macos-cleanup cleanup entitled "token-macos-cleanup" \
      "$HOME/Library/Containers/$BUNDLE_ID/Data" || true
  # 测试应用容器（探针自己的产物目录）也一并移除
  rm -rf "$HOME/Library/Containers/$BUNDLE_ID" 2>/dev/null
  echo "container_removed=$([ -d "$HOME/Library/Containers/$BUNDLE_ID" ] && echo no || echo yes)" \
      >> "$OUT/native/macos-cleanup.exit"
  # Android：卸载测试应用，data/shared_prefs/keystore 条目随之清除
  "$ADB" uninstall "$ANDROID_APP_ID" > "$OUT/native/android-cleanup.txt" 2>&1
  echo "uninstall_exit=$?" >> "$OUT/native/android-cleanup.txt"
  "$ADB" shell pm list packages | grep -c "$ANDROID_APP_ID" >> "$OUT/native/android-cleanup.txt" 2>&1 || true
}

macos_release() {
  local dest="$WORK/macos-entitled/keychain_probe"
  [ -d "$dest" ] || { prepare_probe "$dest"; sign_macos "$dest" >/dev/null; }
  log "Release 构建 + 签名/entitlement 核查"
  ( cd "$dest" && flutter build macos --release ) > "$OUT/native/macos-release.build.log" 2>&1
  echo "build_exit=$?" >> "$OUT/native/macos-release.build.log"
  local app="$dest/build/macos/Build/Products/Release/keychain_probe.app"
  if [ -d "$app" ]; then
    codesign -dv --entitlements - "$app" > "$OUT/native/macos-release.codesign.txt" 2>&1
    codesign -dv "$app" >> "$OUT/native/macos-release.codesign.txt" 2>&1
  fi
  # Release 运行：flutter drive（integration_test 的 release 通道）
  mkdir -p "$dest/test_driver"
  cat > "$dest/test_driver/integration_test.dart" <<'DART'
import 'package:integration_test/integration_test_driver.dart';
Future<void> main() => integrationDriver();
DART
  ( cd "$dest" && flutter drive --release -d macos \
      --driver=test_driver/integration_test.dart \
      --target=integration_test/probe_test.dart \
      --dart-define=PHASE=roundtrip --dart-define=EXPECT=entitled \
      --dart-define=TAG=macos-release --dart-define=TOKEN=token-macos-release \
      --dart-define=PLAINTEXT_ROOT="$HOME/Library/Containers/$BUNDLE_ID/Data" ) \
      > "$OUT/native/macos-release.drive.log" 2>&1
  echo "drive_exit=$?" >> "$OUT/native/macos-release.drive.log"
  tail -5 "$OUT/native/macos-release.drive.log"
}

# ---------------------------------------------------------------- Android ----

ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
ANDROID_ROOT="/data/user/0/$ANDROID_APP_ID"

# 把探针工作副本的 flutter_secure_storage 固定到精确档位
pin_probe_tier() {
  local dest="$1" tier="$2"
  python3 - "$dest/pubspec.yaml" "$tier" <<'PY'
import re, sys
path, tier = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
new, n = re.subn(r"^  flutter_secure_storage: .*$",
                 f"  flutter_secure_storage: '{tier}'", src, flags=re.M)
if n != 1:
    sys.exit(f"expected 1 flutter_secure_storage line, found {n}")
open(path, "w", encoding="utf-8").write(new)
PY
}

# 跑一个 Android 探针阶段：真实构建 APK → adb 升级安装（-r，保留数据）→
# 真实应用进程启动（--dart-define 编译进 APK）→ 从应用 cache 取结构化结果 → 停止进程。
#
# 为什么不用 `flutter test integration_test -d <android>`：那条路径会在跑完后
# 卸载应用，跨档（9→10→11）与"进程重启后读取"的数据无法保留。
run_phase_android() {
  local dest="$1" tag="$2" phase="$3" token="$4" post_delay="${5:-0}"
  local outdir="$OUT/native"
  mkdir -p "$outdir"
  log "android $tag phase=$phase token=$token post_delay=$post_delay"
  ( cd "$dest" && flutter build apk --debug \
      --dart-define=PHASE="$phase" --dart-define=EXPECT=entitled \
      --dart-define=TAG="$tag" --dart-define=TOKEN="$token" \
      --dart-define=POST_DELAY_MS="$post_delay" \
      --dart-define=PLAINTEXT_ROOT="$ANDROID_ROOT" ) \
      > "$outdir/$tag.build.log" 2>&1
  echo "build_exit=$?" > "$outdir/$tag.exit"
  local apk="$dest/build/app/outputs/flutter-apk/app-debug.apk"
  "$ADB" install -r -t "$apk" >> "$outdir/$tag.build.log" 2>&1
  echo "install_exit=$?" >> "$outdir/$tag.exit"
  "$ADB" shell run-as "$ANDROID_APP_ID" rm -f "cache/probe-$tag.json" 2>/dev/null
  "$ADB" logcat -c 2>/dev/null
  "$ADB" shell am force-stop "$ANDROID_APP_ID"
  "$ADB" shell am start -n "$ANDROID_APP_ID/.MainActivity" >> "$outdir/$tag.build.log" 2>&1
  # Dart 的 Directory.systemTemp 在 Android 上是应用的 code_cache 目录；
  # 老版本/其他路径下可能在 cache。两处都找。
  local rel=""
  local waited=0
  while [ "$waited" -lt 40 ]; do
    sleep 2
    waited=$((waited + 2))
    for cand in "code_cache/probe-$tag.json" "cache/probe-$tag.json"; do
      if "$ADB" shell run-as "$ANDROID_APP_ID" ls "$cand" >/dev/null 2>&1; then
        rel="$cand"; break
      fi
    done
    [ -n "$rel" ] && break
  done
  echo "waited_seconds=$waited" >> "$outdir/$tag.exit"
  echo "result_path=${rel:-<missing>}" >> "$outdir/$tag.exit"
  if [ "$post_delay" != "0" ]; then
    # 探针删除后会停留 post_delay 毫秒再退出：等它把延迟后的复读结果写进 JSON
    sleep $((post_delay / 1000 + 3))
  fi
  "$ADB" shell run-as "$ANDROID_APP_ID" rm -f "cache/probe-$tag.json" 2>/dev/null
  if [ -n "$rel" ]; then
    "$ADB" shell run-as "$ANDROID_APP_ID" cat "$rel" \
        > "$outdir/$tag.result.json" 2>> "$outdir/$tag.exit" || true
  fi
  "$ADB" logcat -d -s flutter 2>/dev/null | grep -h 'PROBE_RESULT\|PROBE_VERDICT' \
      > "$outdir/$tag.logcat.txt" 2>&1 || true
  "$ADB" shell am force-stop "$ANDROID_APP_ID"
  local verdict
  verdict=$(python3 -c "
import json,sys
try:
    print(json.load(open('$outdir/$tag.result.json'))['verdict'])
except Exception as e:
    print('NO_RESULT')
")
  echo "verdict=$verdict" >> "$outdir/$tag.exit"
  log "android $tag verdict=$verdict"
  [ "$verdict" = "PASS" ]
}

android_roundtrip() {
  local dest="$WORK/android-11/keychain_probe"
  prepare_probe "$dest"
  pin_probe_tier "$dest" "11.0.0"
  mkdir -p "$OUT/native"
  # 一轮内 写/读/删 + 宿主凭据共存 + 明文扫描
  run_phase_android "$dest" android-v11-roundtrip roundtrip "token-android-v11" 5000 || true
  # 独立进程复核：删除已落盘（无令牌）
  run_phase_android "$dest" android-v11-roundtrip-absent absent "token-android-v11" || true
  android_inspect
}

android_inspect() {
  mkdir -p "$OUT/native"
  {
    echo "=== adb devices"; "$ADB" devices
    echo "=== installed package"; "$ADB" shell dumpsys package "$ANDROID_APP_ID" 2>/dev/null | \
      grep -E "versionName|versionCode|firstInstallTime|lastUpdateTime|signatures|pkgFlags" | head -12
    echo "=== data dir"; "$ADB" shell run-as "$ANDROID_APP_ID" ls -la . 2>&1
    echo "=== code_cache"; "$ADB" shell run-as "$ANDROID_APP_ID" ls -la code_cache 2>&1
    echo "=== shared_prefs"; "$ADB" shell run-as "$ANDROID_APP_ID" ls -la shared_prefs 2>&1
    for f in $("$ADB" shell run-as "$ANDROID_APP_ID" ls shared_prefs 2>/dev/null); do
      echo "--- $f"; "$ADB" shell run-as "$ANDROID_APP_ID" cat "shared_prefs/$f" 2>&1
    done
    echo "=== keystore/permissions"; "$ADB" shell dumpsys package "$ANDROID_APP_ID" 2>/dev/null | \
      grep -A3 "requested permissions" | head -12
  } > "$OUT/native/android-inspect.txt" 2>&1
  wc -l "$OUT/native/android-inspect.txt"
}

android_migrate() {
  mkdir -p "$OUT/native"
  local d9="$WORK/android-9/keychain_probe"
  local d10="$WORK/android-10/keychain_probe"
  local d11="$WORK/android-11/keychain_probe"
  prepare_probe "$d9";  pin_probe_tier "$d9" "9.2.2"
  prepare_probe "$d10"; pin_probe_tier "$d10" "10.3.1"
  prepare_probe "$d11"; pin_probe_tier "$d11" "11.0.0"
  {
    echo "同一 applicationId=${ANDROID_APP_ID}，同一 debug keystore（~/.android/debug.keystore）"
    keytool -list -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey 2>/dev/null \
      | grep -E "Certificate fingerprints|SHA256|owner" | head -6
  } > "$OUT/native/android-signature.txt" 2>&1

  # 9 → 写入测试令牌（登录保存）
  run_phase_android "$d9" android-mig-9-write write "token-android-v9" 5000 || true
  android_inspect
  # 10 → 读取 9 写的令牌（迁移读取）→ 再写 10 自己的令牌
  run_phase_android "$d10" android-mig-10-read read "token-android-v9" || true
  run_phase_android "$d10" android-mig-10-write write "token-android-v10" 5000 || true
  android_inspect
  # 11 → 读取 10 写的令牌 → 删除（退出登出）
  run_phase_android "$d11" android-mig-11-read read "token-android-v10" || true
  run_phase_android "$d11" android-mig-11-delete delete "token-android-v10" 5000 || true
  android_inspect
  # 独立进程复核：11 档删除后令牌必须读不到（登出/401 清理耐久）
  run_phase_android "$d11" android-mig-11-absent absent "token-android-v10" || true
}

# 迁移后的残留探针：11 档在迁移后的状态下 能否读到 9 档遗留行 / 自有写删是否干净
android_post_probe() {
  local d="$WORK/android-11/keychain_probe"
  mkdir -p "$OUT/native"
  # 期望失败：11 读 9 档写的令牌（此前已 delete 过）
  run_phase_android "$d" android-post-read-leftover read "token-android-v10" || true
  # 11 档自己的 写 → 删 是否干净
  run_phase_android "$d" android-post-write write "token-v11-cleanup" || true
  run_phase_android "$d" android-post-delete delete "token-v11-cleanup" || true
  android_inspect
  cp "$OUT/native/android-inspect.txt" "$OUT/native/android-post-inspect.txt" 2>/dev/null || true
}

# ------------------------------------------------------------------- iOS ----

ios_probe() {
  local dest="$WORK/ios/keychain_probe"
  prepare_probe "$dest"
  mkdir -p "$OUT/native"
  {
    echo "=== Xcode / 模拟器运行时"
    xcodebuild -version
    xcrun simctl list runtimes
    xcrun simctl list devices available
    echo "=== 可用设备（flutter devices）"
    flutter devices
    echo "=== iOS 签名身份"
    security find-identity -v -p codesigning
    echo "=== iOS 描述文件"
    ls -la "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/" 2>&1
    echo "=== 探针 iOS entitlements（flutter create 默认：无）"
    find "$dest/ios" -name '*.entitlements' 2>&1
    grep -n 'CODE_SIGN_ENTITLEMENTS\|DEVELOPMENT_TEAM\|PRODUCT_BUNDLE_IDENTIFIER' \
      "$dest/ios/Runner.xcodeproj/project.pbxproj" | head -10
    echo "=== 示例 iOS entitlements（只读核对）"
    find "$REPO/examples/flutter/ios" -name '*.entitlements' 2>&1
    grep -n 'CODE_SIGN_ENTITLEMENTS\|DEVELOPMENT_TEAM' \
      "$REPO/examples/flutter/ios/Runner.xcodeproj/project.pbxproj" | head -10
  } > "$OUT/native/ios-env.txt" 2>&1

  # 1) 无签名构建（契约 verify 命令）
  ( cd "$dest" && flutter build ios --no-codesign --debug ) > "$OUT/native/ios-probe-nocodesign.log" 2>&1
  echo "probe_nocodesign_exit=$?" >> "$OUT/native/ios-probe-nocodesign.log"
  ( cd "$REPO/examples/flutter" && flutter build ios --no-codesign ) > "$OUT/native/ios-example-nocodesign.log" 2>&1
  echo "example_nocodesign_exit=$?" >> "$OUT/native/ios-example-nocodesign.log"

  # 2) 真机签名尝试：用 -allowProvisioningUpdates 触发 Xcode 托管描述文件
  #    （探针的 iOS 工程由 flutter create 生成，已带 DEVELOPMENT_TEAM）
  local ipad="$IPAD_UDID"
  ( cd "$dest/ios" && xcodebuild -workspace Runner.xcworkspace -scheme Runner \
      -configuration Debug -allowProvisioningUpdates \
      -destination "id=$ipad" build ) \
      > "$OUT/native/ios-prime.log" 2>&1
  echo "ios_prime_exit=$?" >> "$OUT/native/ios-prime.log"
  ls -la "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/" \
      > "$OUT/native/ios-profiles-after-prime.txt" 2>&1
  for p in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/"*.provisionprofile; do
    {
      echo "=== $p"
      security cms -D -i "$p" 2>/dev/null | plutil -p - 2>/dev/null \
        | grep -E 'AppIDName|Platform|application-identifier|ExpirationDate|ProvisionedDevices|"[0-9A-F-]{16,}"'
    } >> "$OUT/native/ios-profiles-after-prime.txt" 2>&1
  done

  # 3) 真机构建 + 安装 + 真机进程运行（写 / 重启读取 / 删除）
  if grep -q "iPhone\|iOS" "$OUT/native/ios-profiles-after-prime.txt" 2>/dev/null; then
    ios_device_phases "$dest" "$ipad"
  else
    echo "no iOS provisioning profile after prime; 真机运行未执行" \
      >> "$OUT/native/ios-profiles-after-prime.txt"
  fi
  ( cd "$dest" && flutter build ios --debug ) > "$OUT/native/ios-probe-signed-debug.log" 2>&1
  echo "probe_signed_debug_exit=$?" >> "$OUT/native/ios-probe-signed-debug.log"
  tail -12 "$OUT/native/ios-probe-signed-debug.log"
}

# 真机三阶段：每次重新构建（--dart-define 是编译期注入）→ devicectl 安装 → 启动并抓 stdout
ios_device_phases() {
  local dest="$1" ipad="$2"
  local bundle="com.feedbackverify.keychainProbe"
  for pair in "write:token-ios-v11" "read:token-ios-v11" "delete:token-ios-v11"; do
    local phase="${pair%%:*}" token="${pair##*:}"
    local tag="ios-$phase"
    log "ios $tag (device $ipad)"
    ( cd "$dest" && flutter build ios --debug \
        --dart-define=PHASE="$phase" --dart-define=EXPECT=entitled \
        --dart-define=TAG="$tag" --dart-define=TOKEN="$token" \
        --dart-define=PLAINTEXT_ROOT= ) > "$OUT/native/$tag.build.log" 2>&1
    echo "build_exit=$?" > "$OUT/native/$tag.exit"
    xcrun devicectl device install app --device "$ipad" \
        "$dest/build/ios/iphoneos/Runner.app" > "$OUT/native/$tag.install.log" 2>&1
    echo "install_exit=$?" >> "$OUT/native/$tag.exit"
    xcrun devicectl device process launch --console --terminate-existing \
        --device "$ipad" "$bundle" > "$OUT/native/$tag.log" 2>&1
    echo "launch_exit=$?" >> "$OUT/native/$tag.exit"
    grep -h 'PROBE_RESULT' "$OUT/native/$tag.log" | tail -1 > "$OUT/native/$tag.result.json" || true
    grep -h 'PROBE_VERDICT' "$OUT/native/$tag.log" | tail -1 >> "$OUT/native/$tag.exit" || true
    tail -3 "$OUT/native/$tag.log"
  done
}

case "${1:-}" in
  macos-denied) macos_denied ;;
  macos-entitled) macos_entitled ;;
  macos-release) macos_release ;;
  android-roundtrip) android_roundtrip ;;
  android-migrate) android_migrate ;;
  android-inspect) android_inspect ;;
  android-post) android_post_probe ;;
  android-flush-test)
    d="$WORK/android-11/keychain_probe"
    prepare_probe "$d"; pin_probe_tier "$d" "11.0.0"
    run_phase_android "$d" android-flush-write write "token-flush-test" || true
    run_phase_android "$d" android-flush-delete delete "token-flush-test" 5000 || true
    run_phase_android "$d" android-flush-readback read "token-flush-test" || true ;;
  android-read-token)
    d="$WORK/android-11/keychain_probe"
    run_phase_android "$d" "android-read-$2" read "$3" || true ;;
  ios) ios_probe ;;
  cleanup) cleanup_all ;;
  *) echo "usage: $0 {macos-denied|macos-entitled|macos-release|android-roundtrip|android-migrate|android-inspect|ios}" >&2; exit 2 ;;
esac
