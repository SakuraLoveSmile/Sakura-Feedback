# 第 11 轮红基线（先补回归测试，再改实现）

时间：2026-09-13 · 目标：关闭 T1-C2「停止状态无法确认仍放行」与 T1-C3「授权配置/采集结果检查不严」。

## 1. 修复前：新增用例的失败清单

命令：`python3 -m unittest e2e.test_t1c_executor.WriterStopEnforcementTests \
  e2e.test_t1c_executor.SignatureEvidenceStrictTests \
  e2e.test_t1c_executor.SignatureCaptureStrictTests`

结果：**Ran 36 tests — FAILED (failures=30, errors=0)**；另有 6 例为"必须继续通过"的正常夹具
（正常停止、阶段未启动、Keychain 顺序变化、UUID 不同但身份一致、dict 键顺序、空授权字典）。

失败的 30 例（全部为具体断言，无导入错误、无夹具缺字段）：

- FAIL: test_confirm_writer_stopped_raises_keyboard_interrupt [e2e.test_t1c_executor.WriterStopEnforcementTests]
- FAIL: test_confirm_writer_stopped_raises_oserror [e2e.test_t1c_executor.WriterStopEnforcementTests]
- FAIL: test_confirm_writer_stopped_returns_false [e2e.test_t1c_executor.WriterStopEnforcementTests]
- FAIL: test_confirm_writer_stopped_returns_none [e2e.test_t1c_executor.WriterStopEnforcementTests]
- FAIL: test_resource_manifest_reports_actual_disposition [e2e.test_t1c_executor.WriterStopEnforcementTests]
- FAIL: test_added_or_removed_entitlement_key_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_adhoc_claiming_authority_is_inconsistent [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_authority_identity_change_same_team_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_boolean_value_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_formal_signature_requires_chain_and_team [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_historical_shape_without_new_fields_is_rejected [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_keychain_groups_membership_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_missing_or_invalid_plist_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (status='empty-stdout']
- FAIL: test_missing_or_invalid_plist_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (status='invalid-plist']
- FAIL: test_nonzero_exit_on_any_command_fails_even_with_plausible_output [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (kind='details']
- FAIL: test_nonzero_exit_on_any_command_fails_even_with_plausible_output [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (kind='entitlements']
- FAIL: test_nonzero_exit_on_any_command_fails_even_with_plausible_output [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (kind='uuidCommand']
- FAIL: test_other_array_order_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_string_value_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_timeout_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_unknown_signature_format_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests]
- FAIL: test_value_type_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (left=True, right='true']
- FAIL: test_value_type_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (left=1, right=True]
- FAIL: test_value_type_change_fails [e2e.test_t1c_executor.SignatureEvidenceStrictTests) (left=['a'], right='a']
- FAIL: test_command_result_keeps_stdout_and_stderr_separate [e2e.test_t1c_executor.SignatureCaptureStrictTests]
- FAIL: test_entitlement_value_change_fails_gate [e2e.test_t1c_executor.SignatureCaptureStrictTests]
- FAIL: test_keychain_group_membership_change_fails_gate [e2e.test_t1c_executor.SignatureCaptureStrictTests]
- FAIL: test_nonzero_exit_with_plausible_output_blocks_pass [e2e.test_t1c_executor.SignatureCaptureStrictTests]
- FAIL: test_official_signature_identity_change_fails_gate [e2e.test_t1c_executor.SignatureCaptureStrictTests]
- FAIL: test_report_summary_includes_parse_status_and_identity [e2e.test_t1c_executor.SignatureCaptureStrictTests]

## 2. 目标缺陷（红基线直接体现）

- **T1-C2 误放行**：`_confirm_writer_stopped()` 抛异常 / 返回 `None` 时被当成"已停止"，
  整体仍判 **PASS（退出码 0）**：
  - `test_confirm_writer_stopped_raises_oserror` → `AssertionError: 0 != 1 : run-ws-os 必须退出 1`
  - `test_confirm_writer_stopped_raises_keyboard_interrupt` → `AssertionError: 0 != 1 : run-ws-int 必须退出 1`
  - `test_confirm_writer_stopped_returns_none` → `AssertionError: 0 != 1 : run-ws-none 必须退出 1`
  - `test_confirm_writer_stopped_returns_false` → `AssertionError: None is not False`
  - `test_resource_manifest_reports_actual_disposition` → `AssertionError: False is not true`（清单无条件 `cleaned=true`）
- **T1-C3 判定过松**：非零退出码被忽略、entitlements 只比键不比值、无 plistlib 解析、
  Authority 身份链与签名详情流向未校验（详见上表）。

## 3. 修复后：红检（旁路每处修复，确认测试确实抓住缺陷）

| 被旁路的修复 | 对应用例 | 结果 |
|---|---|---|
| 清理异常不再拦下整体（误放行） | `WriterStopEnforcementTests.test_confirm_writer_stopped_returns_none` | 红 ✅ |
| 资源清单无条件标已清理 | `WriterStopEnforcementTests.test_resource_manifest_reports_actual_disposition` | 红 ✅ |
| 忽略命令非零退出 | `SignatureEvidenceStrictTests.test_nonzero_exit_on_any_command_fails_even_with_plausible_output` | 红 ✅ |
| 不比较授权值（只看键） | `SignatureEvidenceStrictTests.test_boolean_value_change_fails` | 红 ✅ |
| 签名详情从 stdout 解析（流向错误） | `SignatureCaptureStrictTests.test_details_are_parsed_from_stderr_not_stdout` | 红 ✅ |
| 不比较 Authority 身份链 | `SignatureEvidenceStrictTests.test_authority_identity_change_same_team_fails` | 红 ✅ |
| 残留键名不再记录 | `WriterStopEnforcementTests.test_unconfirmed_writer_skips_fallback_cleanup_when_token_may_remain` | 红 ✅ |

## 4. 实测发现（真实命令行为）

真实 `codesign` 的输出流与直觉不同，本轮的"分开保存 stdout/stderr"直接暴露了它：

- `codesign -dv --verbose=4`：显示输出在 **stderr**（stdout 为空）；
- `codesign -d --entitlements :-`：plist 在 **stdout**（stderr 只有 `Executable=` 与弃用警告）；
- `codesign --verify --deep --strict`：诊断在 stderr，判定只看退出码。

因此解析固定走"权威流"并在证据里记录 `parsedFrom`；若按 stdout 解析签名详情，真实采集会退化为
`signatureFormat=unknown` 而被门禁拦下（`test_details_are_parsed_from_stderr_not_stdout` 固定该行为）。
