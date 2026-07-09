import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";
import { Codex } from "@openai/codex-sdk";
import { createClient } from "@redis/client";

type Platform = "github" | "gitea" | "forgejo";

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

type ActionInputs = {
  redis: string;
  secret: string;
  prompt: string;
  token: string;
  automerge: boolean | undefined;
};

type ActionUser = {
  login: string;
  id: number | string;
  email: string;
};

type ProcessOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type CodexRunMetadata = {
  commitMessage: string;
  prComment: string;
};

type PullRequestPayload = {
  number?: number;
  pull_request?: {
    number?: number;
    node_id?: string;
    head?: {
      ref?: string;
      repo?: {
        full_name?: string;
      };
    };
  };
};

type GiteaUserResponse = {
  id?: number;
  login?: string;
  username?: string;
  name?: string;
  email?: string;
  full_name?: string;
};

const require = createRequire(import.meta.url);

const REDIS_AUTH_KEY = "codex-action:v1:auth";
const ENCRYPTION_VERSION = 1;
const CODEX_PACKAGE_VERSION = "0.143.0";

const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    commit_message: {
      type: "string",
      description:
        "Concise imperative git commit message, or an empty string when no changes were made.",
    },
    pr_comment: {
      type: "string",
      description:
        "Pull request comment body, or an empty string when no comment should be posted.",
    },
  },
  required: ["commit_message", "pr_comment"],
  additionalProperties: false,
} as const;

const CODEX_AUTH_CHECK_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function validateRedisUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`redis must be a valid URL: ${errorMessage(error)}`);
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("redis must use the redis:// or rediss:// scheme");
  }

  if (!url.hostname) {
    throw new Error("redis must include a hostname");
  }

  return url.toString();
}

export function parseOptionalBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error("automerge must be true, false, or omitted");
}

export function resolvePromptInput(input: string, workspace: string): string {
  const promptPath = path.resolve(workspace, input);

  if (existsSync(promptPath) && statSync(promptPath).isFile()) {
    return readFileSync(promptPath, "utf8");
  }

  return input;
}

export function encryptText(plaintext: string, secret: string): string {
  if (!secret) {
    throw new Error("secret must not be empty");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    version: ENCRYPTION_VERSION,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

export function decryptText(encrypted: string, secret: string): string {
  if (!secret) {
    throw new Error("secret must not be empty");
  }

  const payload = JSON.parse(encrypted) as {
    version?: number;
    cipher?: string;
    kdf?: string;
    salt?: string;
    iv?: string;
    tag?: string;
    data?: string;
  };

  if (
    payload.version !== ENCRYPTION_VERSION ||
    payload.cipher !== "aes-256-gcm" ||
    payload.kdf !== "scrypt" ||
    !payload.salt ||
    !payload.iv ||
    !payload.tag ||
    !payload.data
  ) {
    throw new Error("encrypted Redis value has an unsupported format");
  }

  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.data, "base64");
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  if (env.FORGEJO_ACTIONS) {
    return "forgejo";
  }

  if (env.GITEA_ACTIONS) {
    return "gitea";
  }

  return "github";
}

export async function run(): Promise<void> {
  const inputs = readInputs();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const platform = detectPlatform();
  const codexHome = createCodexHome();
  const codexExecutable = resolveCodexExecutable(codexHome);
  const redis = createClient({ url: inputs.redis });

  redis.on("error", (error) => {
    core.warning(`Redis client error: ${errorMessage(error)}`);
  });

  await redis.connect();

  try {
    await ensureCodexAuth(redis, inputs.secret, codexHome, codexExecutable, workspace);

    const user = await getActionUser(platform, inputs.token);
    await configureGitUser(workspace, user);

    const prompt = resolvePromptInput(inputs.prompt, workspace);
    const metadata = await runCodexPrompt(codexExecutable, codexHome, workspace, prompt);

    if (await hasGitChanges(workspace)) {
      await commitAndPushChanges(workspace, platform, user, inputs.token, metadata.commitMessage);
    } else {
      core.info("Codex did not leave repository changes to commit.");
    }

    if (isPullRequestEvent() && metadata.prComment.trim()) {
      await postPullRequestComment(platform, inputs.token, metadata.prComment.trim());
    }

    if (isPullRequestEvent() && inputs.automerge !== undefined) {
      await setPullRequestAutomerge(platform, inputs.token, inputs.automerge);
    }
  } finally {
    await persistCodexAuth(redis, inputs.secret, codexHome);
    await redis.quit();
  }
}

function readInputs(): ActionInputs {
  const redis = core.getInput("redis", { required: true });
  const secret = core.getInput("secret", { required: true });
  const prompt = core.getInput("prompt", { required: true });
  const token = core.getInput("token", { required: true });
  const automerge = parseOptionalBoolean(core.getInput("automerge"));

  core.setSecret(redis);
  core.setSecret(secret);
  core.setSecret(token);

  return {
    redis: validateRedisUrl(redis),
    secret,
    prompt,
    token,
    automerge,
  };
}

async function ensureCodexAuth(
  redis: RedisClient,
  secret: string,
  codexHome: string,
  codexExecutable: string,
  workspace: string,
): Promise<void> {
  const encrypted = await redis.get(REDIS_AUTH_KEY);

  if (encrypted) {
    try {
      const authJson = decryptText(encrypted, secret);
      validateCodexAuthJson(authJson);
      maskCodexAuth(authJson);
      writeCodexAuthJson(codexHome, authJson);
      await validateCodexSdkAuth(codexExecutable, codexHome, workspace);
      core.info("Loaded valid Codex auth from Redis.");
      return;
    } catch (error) {
      core.warning(`Stored Codex auth is unavailable or invalid: ${errorMessage(error)}`);
    }
  } else {
    core.info("No Codex auth was found in Redis.");
  }

  core.info("Starting Codex device authorization. Complete the browser flow shown below.");
  await runInheritedProcess(codexExecutable, ["login", "--device-auth"], {
    cwd: workspace,
    env: createCodexEnv(codexHome),
  });

  const authJson = readCodexAuthJson(codexHome);
  validateCodexAuthJson(authJson);
  maskCodexAuth(authJson);
  await validateCodexSdkAuth(codexExecutable, codexHome, workspace);
  await storeCodexAuth(redis, secret, authJson);
}

async function validateCodexSdkAuth(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
): Promise<void> {
  const codex = new Codex({
    codexPathOverride: codexExecutable,
    env: createCodexEnv(codexHome),
  });
  const thread = codex.startThread({
    workingDirectory: workspace,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });

  await thread.run("Return ok true.", {
    outputSchema: CODEX_AUTH_CHECK_SCHEMA,
  });
}

async function runCodexPrompt(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
  prompt: string,
): Promise<CodexRunMetadata> {
  const codex = new Codex({
    codexPathOverride: codexExecutable,
    env: createCodexEnv(codexHome),
  });
  const thread = codex.startThread({
    workingDirectory: workspace,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });
  const turn = await thread.run(buildPrompt(prompt), {
    outputSchema: CODEX_OUTPUT_SCHEMA,
  });

  return parseCodexMetadata(turn.finalResponse);
}

function buildPrompt(prompt: string): string {
  const prInstructions = isPullRequestEvent()
    ? "If a pull request comment would be useful, set pr_comment to concise Markdown. Otherwise set it to an empty string."
    : "This event is not a pull request. Set pr_comment to an empty string.";

  return `${prompt.trim()}

Codex action footer:
- Make any requested repository changes directly in the working tree.
- Do not commit, push, or post comments yourself; this action handles that after you finish.
- When finished, return structured output matching the provided JSON schema.
- If you made repository changes, set commit_message to a concise imperative commit message. If not, set it to an empty string.
- ${prInstructions}`;
}

function parseCodexMetadata(response: string): CodexRunMetadata {
  const parsed = JSON.parse(response) as {
    commit_message?: unknown;
    pr_comment?: unknown;
  };

  return {
    commitMessage: typeof parsed.commit_message === "string" ? parsed.commit_message.trim() : "",
    prComment: typeof parsed.pr_comment === "string" ? parsed.pr_comment.trim() : "",
  };
}

function createCodexHome(): string {
  const base = process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const codexHome = mkdtempSync(path.join(base, "codex-action-"));
  chmodSync(codexHome, 0o700);
  return codexHome;
}

function resolveCodexExecutable(codexHome: string): string {
  if (process.env.CODEX_PATH) {
    return process.env.CODEX_PATH;
  }

  const nativeExecutable = findNativeCodexExecutable();

  if (nativeExecutable) {
    return nativeExecutable;
  }

  return writeNpxCodexWrapper(codexHome);
}

function findNativeCodexExecutable(): string | null {
  const target = getCodexTargetTriple();

  if (!target) {
    return null;
  }

  const platformPackageByTarget: Record<string, string> = {
    "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
    "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
    "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
    "x86_64-apple-darwin": "@openai/codex-darwin-x64",
    "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
    "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  };
  const platformPackage = platformPackageByTarget[target];

  if (!platformPackage) {
    return null;
  }

  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    const executable = path.join(
      path.dirname(packageJsonPath),
      "vendor",
      target,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );

    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

function getCodexTargetTriple(): string | null {
  if (process.platform === "linux" || process.platform === "android") {
    if (process.arch === "x64") {
      return "x86_64-unknown-linux-musl";
    }

    if (process.arch === "arm64") {
      return "aarch64-unknown-linux-musl";
    }
  }

  if (process.platform === "darwin") {
    if (process.arch === "x64") {
      return "x86_64-apple-darwin";
    }

    if (process.arch === "arm64") {
      return "aarch64-apple-darwin";
    }
  }

  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "x86_64-pc-windows-msvc";
    }

    if (process.arch === "arm64") {
      return "aarch64-pc-windows-msvc";
    }
  }

  return null;
}

function writeNpxCodexWrapper(codexHome: string): string {
  const wrapper = path.join(codexHome, process.platform === "win32" ? "codex.cmd" : "codex");

  if (process.platform === "win32") {
    writeFileSync(
      wrapper,
      `@echo off\r\nnpm exec --yes --silent --package @openai/codex@${CODEX_PACKAGE_VERSION} -- codex %*\r\n`,
      { mode: 0o700 },
    );
  } else {
    writeFileSync(
      wrapper,
      `#!/usr/bin/env sh\nexec npm exec --yes --silent --package @openai/codex@${CODEX_PACKAGE_VERSION} -- codex "$@"\n`,
      { mode: 0o700 },
    );
  }

  core.info("Using npx to resolve the Codex CLI because no local native Codex binary was found.");
  return wrapper;
}

function createCodexEnv(codexHome: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.CODEX_HOME = codexHome;
  env.NO_COLOR = "1";
  env.npm_config_loglevel = "error";
  return env;
}

function validateCodexAuthJson(authJson: string): void {
  const parsed = JSON.parse(authJson) as {
    tokens?: Partial<Record<"id_token" | "access_token" | "refresh_token" | "account_id", unknown>>;
  };

  for (const key of ["id_token", "access_token", "refresh_token", "account_id"] as const) {
    if (typeof parsed.tokens?.[key] !== "string" || !parsed.tokens[key]) {
      throw new Error(`Codex auth.json is missing tokens.${key}`);
    }
  }
}

function maskCodexAuth(authJson: string): void {
  core.setSecret(authJson);

  try {
    const parsed = JSON.parse(authJson) as {
      tokens?: Record<string, unknown>;
    };

    for (const value of Object.values(parsed.tokens ?? {})) {
      if (typeof value === "string" && value) {
        core.setSecret(value);
      }
    }
  } catch {}
}

function writeCodexAuthJson(codexHome: string, authJson: string): void {
  mkdirSync(codexHome, { recursive: true });
  chmodSync(codexHome, 0o700);
  const authPath = path.join(codexHome, "auth.json");
  writeFileSync(authPath, authJson, { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function readCodexAuthJson(codexHome: string): string {
  const authPath = path.join(codexHome, "auth.json");

  if (!existsSync(authPath)) {
    throw new Error("Codex login did not produce auth.json");
  }

  return readFileSync(authPath, "utf8");
}

async function storeCodexAuth(redis: RedisClient, secret: string, authJson: string): Promise<void> {
  await redis.set(REDIS_AUTH_KEY, encryptText(authJson, secret));
  core.info("Stored encrypted Codex auth in Redis.");
}

async function persistCodexAuth(
  redis: RedisClient,
  secret: string,
  codexHome: string,
): Promise<void> {
  const authPath = path.join(codexHome, "auth.json");

  if (!existsSync(authPath)) {
    return;
  }

  try {
    const authJson = readCodexAuthJson(codexHome);
    validateCodexAuthJson(authJson);
    maskCodexAuth(authJson);
    await storeCodexAuth(redis, secret, authJson);
  } catch (error) {
    core.warning(`Could not persist refreshed Codex auth: ${errorMessage(error)}`);
  }
}

async function getActionUser(platform: Platform, token: string): Promise<ActionUser> {
  if (platform === "github") {
    const octokit = github.getOctokit(token);
    const { data } = await octokit.rest.users.getAuthenticated();

    return {
      login: data.login,
      id: data.id,
      email: data.email ?? `${data.id}+${data.login}@users.noreply.github.com`,
    };
  }

  const response = await forgejoRequest<GiteaUserResponse>("GET", "/user", token);
  const login = response.login ?? response.username ?? response.name;

  if (!login) {
    throw new Error(`${platform} user response did not include a login`);
  }

  const id = response.id ?? login;
  const host = new URL(getServerUrl()).hostname;

  return {
    login,
    id,
    email: response.email || `${id}+${login}@users.noreply.${host}`,
  };
}

async function configureGitUser(workspace: string, user: ActionUser): Promise<void> {
  await runCapturedProcess("git", ["config", "user.name", user.login], { cwd: workspace });
  await runCapturedProcess("git", ["config", "user.email", user.email], { cwd: workspace });
  core.info(`Configured git user as ${user.login} <${user.email}>.`);
}

async function hasGitChanges(workspace: string): Promise<boolean> {
  const { stdout } = await runCapturedProcess("git", ["status", "--porcelain"], { cwd: workspace });
  return stdout.trim().length > 0;
}

async function commitAndPushChanges(
  workspace: string,
  platform: Platform,
  user: ActionUser,
  token: string,
  commitMessage: string,
): Promise<void> {
  const message = commitMessage || "Update with Codex";

  await runCapturedProcess("git", ["add", "-A"], { cwd: workspace });
  await runCapturedProcess("git", ["commit", "-m", message], { cwd: workspace });
  await withAuthenticatedOrigin(workspace, platform, user, token, async () => {
    const pushRef = await resolvePushRef(workspace);
    await runCapturedProcess("git", ["push", "origin", `HEAD:${pushRef}`], { cwd: workspace });
  });
  core.info("Committed and pushed Codex changes.");
}

async function resolvePushRef(workspace: string): Promise<string> {
  const payload = github.context.payload as PullRequestPayload;
  const prHeadRef = payload.pull_request?.head?.ref ?? process.env.GITHUB_HEAD_REF;

  if (prHeadRef) {
    return prHeadRef;
  }

  if (process.env.GITHUB_REF_TYPE !== "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const { stdout } = await runCapturedProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspace,
  });
  const branch = stdout.trim();

  if (!branch || branch === "HEAD") {
    throw new Error("Could not determine a branch to push Codex changes to");
  }

  return branch;
}

async function withAuthenticatedOrigin(
  workspace: string,
  platform: Platform,
  user: ActionUser,
  token: string,
  callback: () => Promise<void>,
): Promise<void> {
  const { stdout } = await runCapturedProcess("git", ["remote", "get-url", "origin"], {
    cwd: workspace,
  });
  const originalUrl = stdout.trim();
  const authenticatedUrl = buildAuthenticatedRemoteUrl(originalUrl, platform, user, token);

  if (!authenticatedUrl) {
    await callback();
    return;
  }

  core.setSecret(authenticatedUrl);
  await runCapturedProcess("git", ["remote", "set-url", "origin", authenticatedUrl], {
    cwd: workspace,
  });

  try {
    await callback();
  } finally {
    await runCapturedProcess("git", ["remote", "set-url", "origin", originalUrl], {
      cwd: workspace,
    });
  }
}

function buildAuthenticatedRemoteUrl(
  remoteUrl: string,
  platform: Platform,
  user: ActionUser,
  token: string,
): string | null {
  let url: URL;

  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (platform === "github") {
    url.username = "x-access-token";
  } else {
    url.username = user.login;
  }

  url.password = token;
  return url.toString();
}

async function postPullRequestComment(
  platform: Platform,
  token: string,
  body: string,
): Promise<void> {
  const issueNumber = getPullRequestNumber();

  if (platform === "github") {
    const octokit = github.getOctokit(token);
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: issueNumber,
      body,
    });
  } else {
    const { owner, repo } = github.context.repo;
    await forgejoRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      token,
      { body },
    );
  }

  core.info("Posted Codex pull request comment.");
}

async function setPullRequestAutomerge(
  platform: Platform,
  token: string,
  enabled: boolean,
): Promise<void> {
  if (platform === "github") {
    await setGithubPullRequestAutomerge(token, enabled);
    return;
  }

  await setForgejoPullRequestAutomerge(platform, token, enabled);
}

async function setGithubPullRequestAutomerge(token: string, enabled: boolean): Promise<void> {
  const octokit = github.getOctokit(token);
  const pullRequestId = await getGithubPullRequestNodeId(token);

  if (enabled) {
    await octokit.graphql(
      `mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
          pullRequest { id }
        }
      }`,
      { pullRequestId },
    );
    core.info("Enabled GitHub pull request automerge.");
    return;
  }

  try {
    await octokit.graphql(
      `mutation($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
          pullRequest { id }
        }
      }`,
      { pullRequestId },
    );
    core.info("Disabled GitHub pull request automerge.");
  } catch (error) {
    core.warning(`Could not disable GitHub pull request automerge: ${errorMessage(error)}`);
  }
}

async function getGithubPullRequestNodeId(token: string): Promise<string> {
  const payload = github.context.payload as PullRequestPayload;

  if (payload.pull_request?.node_id) {
    return payload.pull_request.node_id;
  }

  const octokit = github.getOctokit(token);
  const { data } = await octokit.rest.pulls.get({
    ...github.context.repo,
    pull_number: getPullRequestNumber(),
  });

  return data.node_id;
}

async function setForgejoPullRequestAutomerge(
  platform: Platform,
  token: string,
  enabled: boolean,
): Promise<void> {
  const { owner, repo } = github.context.repo;
  const issueNumber = getPullRequestNumber();
  const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issueNumber}/merge`;

  try {
    if (enabled) {
      await forgejoRequest("POST", route, token, {
        Do: "merge",
        merge_when_checks_succeed: true,
      });
      core.info(`Enabled ${platform} pull request automerge.`);
      return;
    }

    await forgejoRequest("DELETE", route, token);
    core.info(`Disabled ${platform} pull request automerge.`);
  } catch (error) {
    const suffix = error instanceof HttpError ? `HTTP ${error.status}` : errorMessage(error);
    core.warning(
      `Could not ${enabled ? "enable" : "disable"} ${platform} pull request automerge: ${suffix}`,
    );
  }
}

async function forgejoRequest<T = unknown>(
  method: string,
  route: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(`api/v1${route}`, ensureTrailingSlash(getServerUrl()));
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, text || response.statusText);
  }

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}

function getPullRequestNumber(): number {
  const payload = github.context.payload as PullRequestPayload;
  const issueNumber = payload.pull_request?.number ?? payload.number ?? github.context.issue.number;

  if (!issueNumber) {
    throw new Error("This action is not running for a pull request event");
  }

  return issueNumber;
}

function getServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || github.context.serverUrl;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function runCapturedProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");

      if (code !== 0 || signal) {
        reject(new Error(`${command} failed with ${signal ?? `code ${code ?? 1}`}: ${stderrText}`));
        return;
      }

      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

async function runInheritedProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`${command} failed with ${signal ?? `code ${code ?? 1}`}`));
        return;
      }

      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
