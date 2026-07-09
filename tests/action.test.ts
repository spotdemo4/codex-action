import assert from "node:assert/strict";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  findCodexExecutable,
  getCodexReleaseAsset,
  getCodexReleaseAssetUrl,
  getCodexExecutableNames,
  getCodexTargetTriple,
  getCodexVersionFromPackageJson,
} from "../src/codex-binary.ts";
import {
  codexAuthNeedsRefresh,
  decodeAuthSecret,
  encodeAuthSecret,
  formatCodexAuthJson,
  isCodexAccountReadAuthenticated,
  persistCodexAuth,
} from "../src/codex.ts";
import {
  parseOptionalBoolean,
  parseOptionalString,
  resolvePromptInput,
  validateActionAuthentication,
  validateSecretName,
} from "../src/inputs.ts";
import {
  buildCodexMcpConfig,
  createMcpServerConfig,
  getMcpReleaseAsset,
  getMcpReleaseAssetUrl,
} from "../src/mcp.ts";
import {
  buildGitHubNoreplyEmail,
  createGitHubAppJwt,
  detectPlatform,
  getGitHubAppBotLogin,
  getGitHubActionsBotUser,
  GITHUB_APP_INSTALLATION_PERMISSIONS,
  isGitHubAppInstallationUserError,
  normalizePrivateKey,
} from "../src/platform.ts";

await test("validates auth secret names", () => {
  assert.equal(validateSecretName("CODEX_ACTION_AUTH"), "CODEX_ACTION_AUTH");
  assert.equal(validateSecretName("codex_action_auth"), "codex_action_auth");
  assert.throws(() => validateSecretName("1CODEX"), /auth-secret/);
  assert.throws(() => validateSecretName("GITHUB_TOKEN"), /GITHUB_/);
});

await test("parses optional boolean inputs", () => {
  assert.equal(parseOptionalBoolean("", "automerge"), undefined);
  assert.equal(parseOptionalBoolean("true", "automerge"), true);
  assert.equal(parseOptionalBoolean("yes", "dry-run"), true);
  assert.equal(parseOptionalBoolean("OFF", "automerge"), false);
  assert.throws(() => parseOptionalBoolean("maybe", "dry-run"), /dry-run/);
});

await test("parses optional string inputs", () => {
  assert.equal(parseOptionalString(""), undefined);
  assert.equal(parseOptionalString("  gpt-5.1-codex-max  "), "gpt-5.1-codex-max");
});

await test("validates action authentication inputs", () => {
  assert.doesNotThrow(() => validateActionAuthentication("token", undefined, undefined));
  assert.doesNotThrow(() => validateActionAuthentication(undefined, "client", "key"));
  assert.throws(() => validateActionAuthentication(undefined, undefined, undefined), /token/);
  assert.throws(() => validateActionAuthentication("token", "client", "key"), /either token/);
  assert.throws(() => validateActionAuthentication(undefined, "client", undefined), /together/);
});

await test("encodes and decodes auth secret values", () => {
  const authJson = JSON.stringify({ tokens: { id_token: "id" }, extra: true });
  const encoded = encodeAuthSecret(authJson);

  assert.equal(decodeAuthSecret(encoded), formatCodexAuthJson(authJson));
  assert.equal(decodeAuthSecret(authJson), authJson);
  assert.throws(() => decodeAuthSecret(""), /empty/);
});

await test("formats Codex auth JSON consistently", () => {
  assert.equal(
    formatCodexAuthJson('{"tokens":{"refresh_token":"r","id_token":"i"},"extra":true}'),
    '{"extra":true,"tokens":{"id_token":"i","refresh_token":"r"}}',
  );
});

await test("detects authenticated Codex account/read responses", () => {
  assert.equal(
    isCodexAccountReadAuthenticated({
      account: { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: true,
    }),
    true,
  );
  assert.equal(isCodexAccountReadAuthenticated({ account: null, requiresOpenaiAuth: true }), false);
});

await test("detects when Codex auth needs refresh", () => {
  const nowMs = 1_700_000_000_000;
  const authJson = (accessToken: string) =>
    JSON.stringify({ tokens: { access_token: accessToken } });

  assert.equal(
    codexAuthNeedsRefresh(authJson(createJwt(Math.floor((nowMs + 20 * 60 * 1000) / 1000))), nowMs),
    false,
  );
  assert.equal(
    codexAuthNeedsRefresh(authJson(createJwt(Math.floor((nowMs + 5 * 60 * 1000) / 1000))), nowMs),
    true,
  );
  assert.equal(
    codexAuthNeedsRefresh(authJson(createJwt(Math.floor((nowMs - 1000) / 1000))), nowMs),
    true,
  );
  assert.equal(codexAuthNeedsRefresh(authJson("not-a-jwt"), nowMs), true);
});

await test("skips auth secret updates when auth is unchanged", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-action-test-"));
  const authJson = JSON.stringify({
    tokens: {
      refresh_token: "refresh",
      id_token: "id",
      account_id: "account",
      access_token: "access",
    },
  });
  writeFileSync(path.join(directory, "auth.json"), authJson);

  let updates = 0;
  await persistCodexAuth(directory, encodeAuthSecret(authJson), async () => {
    updates += 1;
  });

  assert.equal(updates, 0);

  const changedAuthJson = JSON.stringify({
    tokens: {
      refresh_token: "refresh",
      id_token: "id",
      account_id: "account",
      access_token: "changed",
    },
  });
  let updatedSecret = "";
  writeFileSync(path.join(directory, "auth.json"), changedAuthJson);
  await persistCodexAuth(directory, encodeAuthSecret(authJson), async (value) => {
    updates += 1;
    updatedSecret = value;
  });

  assert.equal(updates, 1);
  assert.equal(decodeAuthSecret(updatedSecret), formatCodexAuthJson(changedAuthJson));
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

await test("detects GitHub App installation /user errors", () => {
  assert.equal(
    isGitHubAppInstallationUserError({
      status: 403,
      message: "Resource not accessible by integration",
    }),
    true,
  );
  assert.equal(
    isGitHubAppInstallationUserError({ status: 401, message: "Bad credentials" }),
    false,
  );
});

await test("builds GitHub Actions bot user", () => {
  assert.deepEqual(getGitHubActionsBotUser(), {
    login: "github-actions[bot]",
    id: 41898282,
    email: "41898282+github-actions[bot]@users.noreply.github.com",
  });
});

await test("builds GitHub App bot identity values", () => {
  assert.equal(getGitHubAppBotLogin("my-app"), "my-app[bot]");
  assert.equal(
    buildGitHubNoreplyEmail(123, "my-app[bot]"),
    "123+my-app[bot]@users.noreply.github.com",
  );
});

await test("defines GitHub App installation token permissions", () => {
  assert.deepEqual(GITHUB_APP_INSTALLATION_PERMISSIONS, {
    actions: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    secrets: "write",
  });
});

await test("builds GitHub MCP config without embedding the token", () => {
  const server = createMcpServerConfig("github", "/tools/github-mcp-server", "https://github.com");
  const config = buildCodexMcpConfig(server);

  assert.match(config, /\[mcp_servers\.github\]/);
  assert.match(config, /command = "\/tools\/github-mcp-server"/);
  assert.match(config, /args = \["stdio"\]/);
  assert.match(config, /GITHUB_TOOLSETS = "repos,issues,pull_requests,actions"/);
  assert.match(config, /GITHUB_READ_ONLY = "1"/);
  assert.match(config, /env_vars = \["GITHUB_PERSONAL_ACCESS_TOKEN"\]/);
  assert.doesNotMatch(config, /secret-token/);
});

await test("builds Forgejo MCP config without embedding the token", () => {
  const server = createMcpServerConfig("forgejo", "/tools/forgejo-mcp", "https://codeberg.org");
  const config = buildCodexMcpConfig(server);

  assert.match(config, /\[mcp_servers\.forgejo\]/);
  assert.match(config, /command = "\/tools\/forgejo-mcp"/);
  assert.match(config, /--transport/);
  assert.match(config, /https:\/\/codeberg\.org/);
  assert.match(config, /env_vars = \["FORGEJO_ACCESS_TOKEN"\]/);
  assert.doesNotMatch(config, /secret-token/);
});

await test("builds Gitea MCP config without embedding the token", () => {
  const server = createMcpServerConfig("gitea", "/tools/gitea-mcp", "https://gitea.com");
  const config = buildCodexMcpConfig(server);

  assert.match(config, /\[mcp_servers\.gitea\]/);
  assert.match(config, /command = "\/tools\/gitea-mcp"/);
  assert.match(config, /-t/);
  assert.match(config, /https:\/\/gitea\.com/);
  assert.match(config, /env_vars = \["GITEA_ACCESS_TOKEN"\]/);
  assert.doesNotMatch(config, /secret-token/);
});

await test("maps platforms to GitHub MCP release assets", () => {
  assert.deepEqual(getMcpReleaseAsset("github", "linux", "x64"), {
    cacheName: "github-mcp-server",
    version: "1.5.0",
    target: "Linux-x86_64",
    assetName: "github-mcp-server_Linux_x86_64.tar.gz",
    format: "tar",
    executableNames: ["github-mcp-server"],
  });

  assert.equal(
    getMcpReleaseAssetUrl("github", "win32", "arm64"),
    "https://github.com/github/github-mcp-server/releases/download/v1.5.0/github-mcp-server_Windows_arm64.zip",
  );
});

await test("maps platforms to Gitea MCP release assets", () => {
  assert.deepEqual(getMcpReleaseAsset("gitea", "linux", "x64"), {
    cacheName: "gitea-mcp",
    version: "1.3.0",
    target: "Linux-x86_64",
    assetName: "gitea-mcp_Linux_x86_64.tar.gz",
    format: "tar",
    executableNames: ["gitea-mcp"],
  });

  assert.equal(
    getMcpReleaseAssetUrl("gitea", "win32", "arm64"),
    "https://gitea.com/gitea/gitea-mcp/releases/download/v1.3.0/gitea-mcp_Windows_arm64.zip",
  );
});

await test("maps platforms to Forgejo MCP release assets", () => {
  assert.deepEqual(getMcpReleaseAsset("forgejo", "darwin", "arm64"), {
    cacheName: "forgejo-mcp",
    version: "2.30.1",
    target: "darwin-arm64",
    assetName: "forgejo-mcp_2.30.1_darwin_arm64.tar.gz",
    format: "tar",
    executableNames: ["forgejo-mcp"],
  });

  assert.equal(
    getMcpReleaseAssetUrl("forgejo", "linux", "x64"),
    "https://codeberg.org/goern/forgejo-mcp/releases/download/v2.30.1/forgejo-mcp_2.30.1_linux_amd64.tar.gz",
  );
  assert.throws(() => getMcpReleaseAsset("forgejo", "win32", "x64"), /Unsupported Forgejo/);
});

await test("creates GitHub App JWTs", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const jwt = createGitHubAppJwt(
    "Iv1.client",
    privateKeyPem.replace(/\n/g, "\\n"),
    1_700_000_000_000,
  );
  const [header, payload, signature] = jwt.split(".");

  assert.ok(header);
  assert.ok(payload);
  assert.ok(signature);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: "Iv1.client",
  });
  assert.equal(normalizePrivateKey(privateKeyPem.replace(/\n/g, "\\n")), privateKeyPem);
  assert.equal(
    verifySignature(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
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

await test("finds target-named Codex release executables", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-action-test-"));
  const nestedDirectory = path.join(directory, "nested");
  const executable = path.join(nestedDirectory, "codex-x86_64-unknown-linux-musl");
  mkdirSync(nestedDirectory);
  writeFileSync(executable, "#!/bin/sh\n");

  assert.deepEqual(getCodexExecutableNames("x86_64-unknown-linux-musl", "linux"), [
    "codex",
    "codex-x86_64-unknown-linux-musl",
  ]);
  assert.equal(findCodexExecutable(directory, "x86_64-unknown-linux-musl", "linux"), executable);
});

function createJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}
