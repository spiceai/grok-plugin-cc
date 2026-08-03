import assert from "node:assert/strict";
import test from "node:test";

import { Cache } from "../src/cache.js";

test("stores and returns a value", () => {
  const cache = new Cache();
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
});

test("evicts the oldest entry past maxSize", () => {
  const cache = new Cache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("a"), undefined);
});

test("returns a value before its ttl elapses", () => {
  const cache = new Cache();
  cache.set("a", 1, 60_000);
  assert.equal(cache.get("a"), 1);
});

test("drops a value after its ttl elapses", async () => {
  const cache = new Cache();
  cache.set("a", 1, 5);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cache.get("a"), undefined);
});
