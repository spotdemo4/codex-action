import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getCodexReleaseAsset,
  getCodexReleaseAssetUrl,
  getCodexTargetTriple,
  getCodexVersionFromPackageJson,
} from "../src/codex-binary.ts";
import { decodeAuthSecret, encodeAuthSecret } from "../src/codex.ts";
import { parseOptionalBoolean, resolvePromptInput, validateSecretName } from "../src/inputs.ts";
import { detectPlatform } from "../src/platform.ts";

await test("validates auth secret names", () => {
  assert.equal(validateSecretName("CODEX_ACTION_AUTH"), "CODEX_ACTION_AUTH");
  assert.equal(validateSecretName("codex_action_auth"), "codex_action_auth");
  assert.throws(() => validateSecretName("1CODEX"), /auth-secret/);
  assert.throws(() => validateSecretName("GITHUB_TOKEN"), /GITHUB_/);
});

await test("parses optional boolean inputs", () => {
  assert.equal(parseOptionalBoolean(""), undefined);
  assert.equal(parseOptionalBoolean("true"), true);
  assert.equal(parseOptionalBoolean("OFF"), false);
  assert.throws(() => parseOptionalBoolean("maybe"), /automerge/);
});

await test("encodes and decodes auth secret values", () => {
  const authJson = JSON.stringify({ tokens: { id_token: "id" } });
  const encoded = encodeAuthSecret(authJson);

  assert.equal(decodeAuthSecret(encoded), authJson);
  assert.equal(decodeAuthSecret(authJson), authJson);
  assert.throws(() => decodeAuthSecret(""), /empty/);
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

await test("derives Codex version from package.json", () => {
  assert.equal(
    getCodexVersionFromPackageJson(
      JSON.stringify({ dependencies: { "@openai/codex-sdk": "^0.143.0" } }),
    ),
    "0.143.0",
  );
  assert.equal(
    getCodexVersionFromPackageJson(
      JSON.stringify({ dependencies: { "@openai/codex-sdk": "~0.144.0-alpha.2" } }),
    ),
    "0.144.0-alpha.2",
  );
});

await test("maps platforms to Codex release assets", () => {
  assert.equal(getCodexTargetTriple("linux", "x64"), "x86_64-unknown-linux-musl");
  assert.deepEqual(getCodexReleaseAsset("x86_64-unknown-linux-musl"), {
    assetName: "codex-x86_64-unknown-linux-musl.tar.gz",
    format: "tar",
  });
  assert.deepEqual(getCodexReleaseAsset("x86_64-pc-windows-msvc"), {
    assetName: "codex-x86_64-pc-windows-msvc.exe.zip",
    format: "zip",
  });
  assert.equal(
    getCodexReleaseAssetUrl("0.143.0", "aarch64-apple-darwin"),
    "https://github.com/openai/codex/releases/download/rust-v0.143.0/codex-aarch64-apple-darwin.tar.gz",
  );
});
