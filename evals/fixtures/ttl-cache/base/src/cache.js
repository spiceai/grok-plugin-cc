/**
 * A small bounded key/value cache with FIFO eviction.
 */
export class Cache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.entries = new Map();
  }

  set(key, value) {
    this.entries.set(key, { value });
    this.evictIfNeeded();
  }

  get(key) {
    const entry = this.entries.get(key);
    return entry ? entry.value : undefined;
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
