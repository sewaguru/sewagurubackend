interface CacheItem<T> {
  data: T;
  expiresAt: number;
}

const cacheStore = new Map<string, CacheItem<any>>();

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export function setCache<T>(key: string, data: T, ttlMs = DEFAULT_TTL) {
  cacheStore.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCache<T>(key: string): T | null {
  const item = cacheStore.get(key);

  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    cacheStore.delete(key);
    return null;
  }

  return item.data as T;
}

export function clearCache(key: string) {
  cacheStore.delete(key);
}

/* ===== ADDRESS CACHE ===== */

export function clearAddressCache(userId: string) {
  cacheStore.delete(`addresses:${userId}`);
}

/* ===== USER CACHE ===== */

export function clearUserCache(userId: string) {
  cacheStore.delete(`user:${userId}`);
  clearAddressCache(userId);
}

/* ===== GLOBAL CACHE RESET (optional) ===== */

export function clearAllCache() {
  cacheStore.clear();
}
