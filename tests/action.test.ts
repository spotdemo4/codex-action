import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  decryptText,
  detectPlatform,
  encryptText,
  parseOptionalBoolean,
  resolvePromptInput,
  validateRedisUrl,
} from "../src/action.ts";

await test("validates Redis URLs", () => {
  assert.equal(validateRedisUrl("redis://localhost:6379/0"), "redis://localhost:6379/0");
  assert.equal(validateRedisUrl("rediss://cache.example.com"), "rediss://cache.example.com");
  assert.throws(() => validateRedisUrl("https://cache.example.com"), /redis:\/\/ or rediss:\/\//);
});

await test("parses optional boolean inputs", () => {
  assert.equal(parseOptionalBoolean(""), undefined);
  assert.equal(parseOptionalBoolean("true"), true);
  assert.equal(parseOptionalBoolean("OFF"), false);
  assert.throws(() => parseOptionalBoolean("maybe"), /automerge/);
});

await test("encrypts and decrypts text", () => {
  const encrypted = encryptText("hello", "secret");

  assert.equal(decryptText(encrypted, "secret"), "hello");
  assert.throws(() => decryptText(encrypted, "wrong"));
});

await test("resolves prompt file paths", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-action-test-"));
  const promptPath = path.join(directory, "prompt.txt");
  writeFileSync(promptPath, "from file");

  assert.equal(resolvePromptInput("prompt.txt", directory), "from file");
  assert.equal(resolvePromptInput("literal prompt", directory), "literal prompt");
});

await test("detects action platform", () => {
  assert.equal(detectPlatform({}), "github");
  assert.equal(detectPlatform({ GITEA_ACTIONS: "true" }), "gitea");
  assert.equal(detectPlatform({ FORGEJO_ACTIONS: "true" }), "forgejo");
});
