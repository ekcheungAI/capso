export type RateLimitResult = { allowed: true; retryAfterSeconds: 0 } | { allowed: false; retryAfterSeconds: number };

export function createRateLimiter({
  windowMs,
  userLimit,
  globalLimit,
  now = Date.now,
}: {
  windowMs: number;
  userLimit: number;
  globalLimit: number;
  now?: () => number;
}) {
  let global: number[] = [];
  const users = new Map<string, number[]>();

  const prune = (timestamps: number[], time: number) => timestamps.filter((stamp) => time - stamp < windowMs);

  return {
    take(userId: string): RateLimitResult {
      const time = now();
      global = prune(global, time);
      const user = prune(users.get(userId) ?? [], time);
      if (user.length > 0) users.set(userId, user);
      else users.delete(userId);

      const userWait = user.length >= userLimit ? windowMs - (time - user[0]!) : 0;
      const globalWait = global.length >= globalLimit ? windowMs - (time - global[0]!) : 0;
      const wait = Math.max(userWait, globalWait);
      if (wait > 0) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1_000)) };
      }

      user.push(time);
      users.set(userId, user);
      global.push(time);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
