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
