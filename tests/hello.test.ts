import assert from "node:assert/strict";
import { test } from "node:test";

import { hello } from "../src/hello.ts";

await test("says hello", () => {
  assert.equal(hello(), "Hello, world!");
});
