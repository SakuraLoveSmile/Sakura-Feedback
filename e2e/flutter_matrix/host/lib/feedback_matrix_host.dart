/// T3 verifier 独立隔离宿主的共享期望表。
///
/// 这里只放“三档家族形态”的期望值，由 [test/matrix_host_contract_test.dart]
/// 对着本档实际解析出来的 pubspec.lock 断言；期望值的来源是 flutter_secure_storage
/// 自身的版本线（9→10 换 federated 形态：darwin 取代 macos、windows 3.x→4.x、
/// platform_interface 1.x→2.x），不是实现者的转述。
class TierExpectation {
  /// 构造期望。
  const TierExpectation({
    required this.tier,
    required this.major,
    required this.expectDarwin,
    required this.expectMacos,
    required this.windowsMajor,
    required this.platformInterfaceMajor,
  });

  /// 档位版本号（精确）。
  final String tier;

  /// 主版本号。
  final int major;

  /// 该档是否应出现 `flutter_secure_storage_darwin`。
  final bool expectDarwin;

  /// 该档是否应出现 `flutter_secure_storage_macos`。
  final bool expectMacos;

  /// `flutter_secure_storage_windows` 的期望主版本。
  final int windowsMajor;

  /// `flutter_secure_storage_platform_interface` 的期望主版本。
  final int platformInterfaceMajor;
}

/// 三档期望表。
const Map<String, TierExpectation> kTierExpectations = <String, TierExpectation>{
  '9.2.2': TierExpectation(
    tier: '9.2.2',
    major: 9,
    expectDarwin: false,
    expectMacos: true,
    windowsMajor: 3,
    platformInterfaceMajor: 1,
  ),
  '10.3.1': TierExpectation(
    tier: '10.3.1',
    major: 10,
    expectDarwin: true,
    expectMacos: false,
    windowsMajor: 4,
    platformInterfaceMajor: 2,
  ),
  '11.0.0': TierExpectation(
    tier: '11.0.0',
    major: 11,
    expectDarwin: true,
    expectMacos: false,
    windowsMajor: 4,
    platformInterfaceMajor: 2,
  ),
};

/// 取期望；未知档位返回 null。
TierExpectation? expectationFor(String tier) => kTierExpectations[tier];
