import 'dart:math';

Random? _random;

Random _rng() {
  if (_random != null) return _random!;
  try {
    return _random = Random.secure();
  } on UnsupportedError {
    // 极少数环境不支持 CSPRNG：退回时间种子。
    final seed = DateTime.now().microsecondsSinceEpoch ^
        DateTime.now().millisecondsSinceEpoch;
    return _random = Random(seed);
  }
}

String _hexDigits(int n) {
  final r = _rng();
  final buf = StringBuffer();
  for (var i = 0; i < n; i++) {
    buf.write(r.nextInt(16).toRadixString(16));
  }
  return buf.toString();
}

/// 生成 RFC-4122 v4 形态的幂等键（自制 uuid：DateTime + Random，无额外依赖）。
///
/// 形如 `550e8400-e29b-41d4-a716-446655440000`，36 字符，
/// 满足契约 `idempotencyKey ≤ 200 字符` 的要求。
String generateFeedbackIdempotencyKey() {
  final variant = (0x8 + _rng().nextInt(4)).toRadixString(16); // 8|9|a|b
  // time_low - time_mid - 4time_hi - variant+clock_seq - node
  return '${_hexDigits(8)}-${_hexDigits(4)}-4${_hexDigits(3)}'
      '-$variant${_hexDigits(3)}-${_hexDigits(12)}';
}
