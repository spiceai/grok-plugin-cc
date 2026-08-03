/**
 * A small bounded key/value cache with FIFO eviction and per-entry TTL.
 */
export class Cache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.entries = new Map();
  }

  set(key, value, ttlMs = 60_000) {
    this.entries.set(key, { value, expiresAt: ttlMs });
    this.evictIfNeeded();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  size() {
    return this.entries.size;
  }

  evictIfNeeded() {
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }
}
