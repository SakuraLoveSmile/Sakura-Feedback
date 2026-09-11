/** 进程内滑动窗口限流。单实例部署足够，不引入 Redis。 */
export interface RateLimiter {
  /** 返回 null 表示允许；否则为建议等待秒数。 */
  check(key: string): number | null;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): number | null {
      const now = Date.now();
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return Math.ceil((windowMs - (now - (list[0] ?? now))) / 1000);
      }
      list.push(now);
      hits.set(key, list);
      // 防止内存无限增长
      if (hits.size > 10_000) {
        for (const [k, v] of hits) {
          if (!v.some((t) => now - t < windowMs)) hits.delete(k);
        }
      }
      return null;
    },
  };
}
