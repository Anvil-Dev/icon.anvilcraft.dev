/** Cache entry TTLs in seconds. */
export const DOWNLOADS_TTL = 3 * 60 * 60; // 3 hours
export const CI_TTL = 60; // 60 seconds

/** Read a JSON cache entry; returns null on miss or malformed payloads. */
export async function readCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, "json");
  } catch {
    return null;
  }
}

/** Write a JSON cache entry with the given TTL. */
export async function writeCache(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}
