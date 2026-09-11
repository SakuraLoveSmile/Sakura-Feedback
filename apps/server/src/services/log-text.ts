/**
 * 日志文本工具（docs/api.md L2 / L3 / L6 / L7 的共享实现）。
 *
 * 为什么单独成模块：同一套解码与码点规则同时被
 * 1) 提交校验（routes/feedback.ts，严格 UTF-8 + 无 NUL + 非空）、
 * 2) 管理端 `LogMeta.truncated` / `totalCodepoints`（routes/admin.ts）、
 * 3) AI 输入 `AiLogInput.tail`（pipeline/worker.ts）
 * 使用。三处必须完全一致，因此只允许存在这一份实现。
 */

/** 单份日志送入 AI 的末尾码点数上限（L1）。 */
export const MAX_LOG_TAIL_CODEPOINTS = 8000;
/** 全部日志送入 AI 的码点总数上限（L1）。 */
export const MAX_LOGS_TAIL_CODEPOINTS = 24000;

/** 剥离至多一个开头的 UTF-8 BOM（L7 解码规则第 1 条）。 */
export function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

/**
 * 严格 UTF-8 解码（剥单个 BOM 后 fatal 解码）。
 * 返回 null 表示字节序列不是合法 UTF-8；返回 "" 表示（剥 BOM 后）空文本。
 */
export function decodeLogStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stripUtf8Bom(bytes));
  } catch {
    return null;
  }
}

/**
 * 一份日志的客观码点属性（L6）：按已落库字节 + L7 解码规则计算，与是否送过 AI 无关。
 * 无法解码的字节（理论上不会落库）按「无可读文本」返回 0 / false，绝不抛错。
 */
export function logCodepointStats(bytes: Uint8Array): { totalCodepoints: number; truncated: boolean } {
  const text = decodeLogStrict(bytes);
  if (text === null) return { totalCodepoints: 0, truncated: false };
  const totalCodepoints = Array.from(text).length;
  return { totalCodepoints, truncated: totalCodepoints > MAX_LOG_TAIL_CODEPOINTS };
}

/**
 * 取文本末尾至多 `budget` 个码点（L7 码点预算；截取一律取末尾）。
 * `truncated` **只由该份日志自身的总码点数决定**（> 8000），与 `budget` 及「本次实际送出多少」
 * 完全解耦——绝不能用预算裁剪后的长度反推，否则预算不足的最后一份会被误记为「未截取」。
 */
export function takeTail(
  text: string,
  budget: number,
): { tail: string; truncated: boolean; totalCodepoints: number; includedCodepoints: number } {
  const codepoints = Array.from(text);
  const totalCodepoints = codepoints.length;
  const take = Math.max(0, Math.min(MAX_LOG_TAIL_CODEPOINTS, totalCodepoints, budget));
  const tail = codepoints.slice(totalCodepoints - take).join("");
  return {
    tail,
    truncated: totalCodepoints > MAX_LOG_TAIL_CODEPOINTS,
    totalCodepoints,
    includedCodepoints: take,
  };
}
