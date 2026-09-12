/**
 * 宿主侧内存日志环形缓冲（示例用）。
 *
 * 这里**只有宿主自己已经掌握的内存数据**：不扫描磁盘、不拦截 console、不读系统日志。
 * 真实项目把「最近 N 条应用日志」交给组件即可；组件只在**新草稿首次打开**时
 * 调用一次 `logProvider`（3 秒超时 → 面板给出「重试 / 不带日志继续提交」），
 * 拿到的是这次导出的**原始字节**，组件自己再做大小 / 扩展名 / UTF-8 校验。
 */
export interface HostLogBuffer {
  push(line: string): void;
  dump(): string;
  size(): number;
}

export function createHostLogBuffer(capacity = 200): HostLogBuffer {
  const lines: string[] = [
    '[boot] host demo started',
    '[boot] logProvider 读取的就是本内存缓冲区（不落盘）',
  ];

  return {
    push(line: string): void {
      lines.push(`${new Date().toISOString()} ${line}`);
      // 环形：超出容量丢最旧的行
      while (lines.length > capacity) lines.shift();
    },
    dump(): string {
      return `${lines.join('\n')}\n`;
    },
    size(): number {
      return lines.length;
    },
  };
}

/**
 * 导出成组件需要的 `{ name, bytes }`。
 * 文件名用 `.log`（组件与服务的白名单：`.log / .txt / .json / .jsonl`），
 * 内容按字节交给组件——宿主负责在交给组件**之前**去掉凭据等敏感内容。
 */
export function exportHostLog(
  buffer: HostLogBuffer,
  name = 'host-app.log',
): { name: string; bytes: Uint8Array } {
  return { name, bytes: new TextEncoder().encode(buffer.dump()) };
}
