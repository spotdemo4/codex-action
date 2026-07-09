import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import * as core from "@actions/core";
import { Codex } from "@openai/codex-sdk";

import { isPullRequestEvent } from "./platform.ts";
import { runInheritedProcess } from "./process.ts";
import type { CodexRunMetadata } from "./types.ts";
import { errorMessage } from "./utils.ts";

const CODEX_APP_SERVER_TIMEOUT_MS = 30_000;
const CODEX_AUTH_REFRESH_SKEW_MS = 10 * 60 * 1000;

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

export function createCodexHome(): string {
  const base = process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const codexHome = mkdtempSync(path.join(base, "codex-action-"));
  chmodSync(codexHome, 0o700);
  return codexHome;
}

export async function ensureCodexAuth(
  auth: string,
  codexHome: string,
  codexExecutable: string,
  workspace: string,
  updateAuthSecret: (value: string) => Promise<void>,
): Promise<string | undefined> {
  let loadedAuthFromSecret = false;

  if (auth) {
    try {
      const authJson = formatCodexAuthJson(decodeAuthSecret(auth));
      validateCodexAuthJson(authJson);
      maskCodexAuth(authJson);
      writeCodexAuthJson(codexHome, authJson);
      loadedAuthFromSecret = true;
      core.info("Loaded valid Codex auth from repository secret.");
    } catch (error) {
      core.warning(
        `Repository secret Codex auth is unavailable or invalid: ${errorMessage(error)}`,
      );
    }
  } else {
    core.info("No Codex auth was provided by repository secret.");
  }

  if (!loadedAuthFromSecret) {
    await runCodexDeviceLogin(codexExecutable, codexHome, workspace);
  }

  const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));

  if (codexAuthNeedsRefresh(authJson)) {
    try {
      await refreshCodexAuth(codexExecutable, codexHome, workspace);
    } catch (error) {
      if (!loadedAuthFromSecret) {
        throw error;
      }

      core.warning(`Stored Codex auth could not be refreshed: ${errorMessage(error)}`);
      await runCodexDeviceLogin(codexExecutable, codexHome, workspace);
      await refreshCodexAuth(codexExecutable, codexHome, workspace);
    }
  } else {
    core.info("Codex auth token is still fresh; refresh skipped.");
  }

  return persistCodexAuth(codexHome, auth, updateAuthSecret, { required: true });
}

export async function runCodexPrompt(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
  prompt: string,
  model: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<CodexRunMetadata> {
  const codex = new Codex({
    codexPathOverride: codexExecutable,
    env: createCodexEnv(codexHome, extraEnv),
  });
  const thread = codex.startThread({
    workingDirectory: workspace,
    model,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    additionalDirectories: getAdditionalWritableDirectories(workspace),
  });
  const codexPrompt = buildPrompt(prompt);

  logCodexText("Codex prompt", codexPrompt);
  const turn = await thread.run(codexPrompt, {
    outputSchema: CODEX_OUTPUT_SCHEMA,
  });
  logCodexActivity(turn.items);
  logCodexText("Codex response", turn.finalResponse);

  return parseCodexMetadata(turn.finalResponse);
}

export async function persistCodexAuth(
  codexHome: string,
  previousAuth: string,
  updateAuthSecret: (value: string) => Promise<void>,
  options: { required?: boolean } = {},
): Promise<string | undefined> {
  const authPath = path.join(codexHome, "auth.json");

  if (!existsSync(authPath)) {
    return undefined;
  }

  try {
    const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));
    validateCodexAuthJson(authJson);
    maskCodexAuth(authJson);
    const encodedAuth = encodeAuthSecret(authJson);

    if (authJson === getPreviousAuthJson(previousAuth)) {
      writeCodexAuthJson(codexHome, authJson);
      core.info("Codex auth did not change; repository secret update skipped.");
      return encodedAuth;
    }

    writeCodexAuthJson(codexHome, authJson);
    await updateAuthSecret(encodedAuth);
    core.info("Stored refreshed Codex auth in repository secret.");
    return encodedAuth;
  } catch (error) {
    const message = `Could not persist refreshed Codex auth: ${errorMessage(error)}`;

    if (options.required) {
      throw new Error(message);
    }

    core.warning(message);
    return undefined;
  }
}

export function encodeAuthSecret(authJson: string): string {
  return Buffer.from(formatCodexAuthJson(authJson), "utf8").toString("base64");
}

export function decodeAuthSecret(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("auth secret is empty");
  }

  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  return Buffer.from(trimmed, "base64").toString("utf8");
}

export function formatCodexAuthJson(authJson: string): string {
  const parsed = JSON.parse(authJson) as unknown;

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex auth.json must be a JSON object");
  }

  const formatted = JSON.stringify(sortJsonValue(parsed));

  if (formatted === undefined) {
    throw new Error("Codex auth.json could not be serialized");
  }

  return formatted;
}

export function isCodexAccountReadAuthenticated(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }

  const account = (result as { account?: unknown }).account;
  return account !== null && typeof account === "object" && !Array.isArray(account);
}

export function codexAuthNeedsRefresh(authJson: string, nowMs: number = Date.now()): boolean {
  const accessToken = getCodexAccessToken(authJson);

  if (!accessToken) {
    return true;
  }

  const expiresAtMs = getJwtExpirationMs(accessToken);

  if (expiresAtMs === undefined) {
    return true;
  }

  return expiresAtMs - nowMs <= CODEX_AUTH_REFRESH_SKEW_MS;
}

function getCodexAccessToken(authJson: string): string | undefined {
  try {
    const parsed = JSON.parse(authJson) as {
      tokens?: Partial<Record<"access_token", unknown>>;
    };
    const accessToken = parsed.tokens?.access_token;
    return typeof accessToken === "string" && accessToken ? accessToken : undefined;
  } catch {
    return undefined;
  }
}

function getJwtExpirationMs(token: string): number | undefined {
  const payload = parseJwtPayload(token);

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const exp = (payload as { exp?: unknown }).exp;

  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return undefined;
  }

  return exp * 1000;
}

function parseJwtPayload(token: string): unknown {
  const payload = token.split(".")[1];

  if (!payload) {
    return undefined;
  }

  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function runCodexDeviceLogin(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
): Promise<void> {
  core.info("Starting Codex device authorization. Complete the browser flow shown below.");
  await runInheritedProcess(codexExecutable, ["login", "--device-auth"], {
    cwd: workspace,
    env: createCodexEnv(codexHome),
  });

  const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));
  validateCodexAuthJson(authJson);
  maskCodexAuth(authJson);
  writeCodexAuthJson(codexHome, authJson);
}

async function refreshCodexAuth(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
): Promise<void> {
  core.info("Refreshing Codex auth before running the prompt.");

  const appServer = startCodexAppServer(codexExecutable, codexHome, workspace);

  try {
    await appServer.request(0, "initialize", {
      clientInfo: {
        name: "codex-action",
        title: "codex-action",
        version: "0.0.1",
      },
    });
    appServer.notify("initialized", {});
    const result = await appServer.request(1, "account/read", { refreshToken: true });

    if (!isCodexAccountReadAuthenticated(result)) {
      throw new Error("Codex account/read did not return an authenticated account");
    }

    const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));
    validateCodexAuthJson(authJson);
    maskCodexAuth(authJson);
    writeCodexAuthJson(codexHome, authJson);
    core.info("Refreshed Codex auth before running the prompt.");
  } finally {
    await appServer.close();
  }
}

function startCodexAppServer(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
): {
  request(id: number, method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
} {
  const child = spawn(codexExecutable, ["app-server", "--stdio"], {
    cwd: workspace,
    env: createCodexEnv(codexHome),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    string,
    {
      method: string;
      timeout: NodeJS.Timeout;
      resolve(result: unknown): void;
      reject(error: Error): void;
    }
  >();
  let stderr = "";
  let closed = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    handleCodexAppServerLine(line, pending, writeMessage);
  });

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      stdout.close();
      rejectPendingCodexAppServerRequests(
        pending,
        new Error(formatCodexAppServerExit(code, signal, stderr)),
      );
      resolve();
    });
  });

  child.once("error", (error) => {
    rejectPendingCodexAppServerRequests(pending, error);
  });

  function writeMessage(message: unknown): void {
    if (closed || !child.stdin.writable) {
      throw new Error("Codex app-server stdin is closed");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const key = String(id);
        const timeout = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Timed out waiting for Codex app-server ${method} response`));
          child.kill();
        }, CODEX_APP_SERVER_TIMEOUT_MS);

        pending.set(key, { method, timeout, resolve, reject });

        try {
          writeMessage({ method, id, params });
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(key);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      writeMessage({ method, params });
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      child.stdin.end();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }

      await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    },
  };
}

function handleCodexAppServerLine(
  line: string,
  pending: Map<
    string,
    {
      method: string;
      timeout: NodeJS.Timeout;
      resolve(result: unknown): void;
      reject(error: Error): void;
    }
  >,
  writeMessage: (message: unknown) => void,
): void {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  let message: unknown;

  try {
    message = JSON.parse(trimmed) as unknown;
  } catch {
    core.debug(`Ignoring non-JSON Codex app-server output: ${trimmed}`);
    return;
  }

  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return;
  }

  const id = (message as { id?: unknown }).id;

  if (typeof id !== "number" && typeof id !== "string") {
    return;
  }

  const method = (message as { method?: unknown }).method;

  if (typeof method === "string") {
    try {
      writeMessage({
        id,
        error: {
          code: -32000,
          message: `codex-action cannot handle app-server request ${method}`,
        },
      });
    } catch (error) {
      core.debug(`Could not reject Codex app-server request ${method}: ${errorMessage(error)}`);
    }

    return;
  }

  const key = String(id);
  const pendingResponse = pending.get(key);

  if (!pendingResponse) {
    return;
  }

  pending.delete(key);
  clearTimeout(pendingResponse.timeout);

  const error = (message as { error?: unknown }).error;

  if (error !== undefined) {
    pendingResponse.reject(new Error(formatCodexAppServerError(pendingResponse.method, error)));
    return;
  }

  pendingResponse.resolve((message as { result?: unknown }).result);
}

function rejectPendingCodexAppServerRequests(
  pending: Map<
    string,
    {
      method: string;
      timeout: NodeJS.Timeout;
      resolve(result: unknown): void;
      reject(error: Error): void;
    }
  >,
  error: Error,
): void {
  for (const pendingResponse of pending.values()) {
    clearTimeout(pendingResponse.timeout);
    pendingResponse.reject(error);
  }

  pending.clear();
}

function formatCodexAppServerError(method: string, error: unknown): string {
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;

    if (typeof message === "string") {
      const codeSuffix = typeof code === "string" || typeof code === "number" ? ` (${code})` : "";
      return `Codex app-server ${method} failed${codeSuffix}: ${message}`;
    }
  }

  return `Codex app-server ${method} failed: ${JSON.stringify(error)}`;
}

function formatCodexAppServerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
  return `Codex app-server exited with ${status}${suffix}`;
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
- ${prInstructions}
- Platform MCP tools are available for repository, pull request, issue, and workflow context. Use them when helpful, but do not perform external writes through MCP.`;
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

function logCodexText(title: string, text: string): void {
  core.startGroup(title);
  core.info(text);
  core.endGroup();
}

function logCodexActivity(items: unknown[]): void {
  const summaries = items
    .map(formatCodexActivityItem)
    .filter((value): value is string => value !== undefined);

  if (summaries.length === 0) {
    core.info("Codex reported no file changes, commands, MCP calls, web searches, or errors.");
    return;
  }

  core.startGroup("Codex activity");
  for (const summary of summaries) {
    core.info(summary);
  }
  core.endGroup();
}

function formatCodexActivityItem(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  switch (item.type) {
    case "file_change":
      return formatCodexFileChangeItem(item);
    case "command_execution":
      return formatCodexCommandExecutionItem(item);
    case "mcp_tool_call":
      return formatCodexMcpToolCallItem(item);
    case "web_search":
      return `web_search: ${getString(item, "query") ?? "unknown query"}`;
    case "todo_list":
      return formatCodexTodoListItem(item);
    case "error":
      return `error: ${getString(item, "message") ?? "unknown error"}`;
    default:
      return undefined;
  }
}

function formatCodexFileChangeItem(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes)
    ? item.changes
        .map((change) => {
          if (!isRecord(change)) {
            return undefined;
          }

          const kind = getString(change, "kind") ?? "change";
          const filePath = getString(change, "path") ?? "unknown path";
          return `${kind} ${filePath}`;
        })
        .filter((value): value is string => value !== undefined)
        .join(", ")
    : "";
  const suffix = changes ? `: ${changes}` : "";
  return `file_change ${getString(item, "status") ?? "unknown"}${suffix}`;
}

function formatCodexCommandExecutionItem(item: Record<string, unknown>): string {
  const command = getString(item, "command") ?? "unknown command";
  const exitCode = getNumber(item, "exit_code");
  const exitSuffix = exitCode === undefined ? "" : ` exit ${exitCode}`;
  const output = truncateLogText(getString(item, "aggregated_output")?.trim() ?? "");
  const outputSuffix = output ? `\noutput: ${output}` : "";

  return `command ${getString(item, "status") ?? "unknown"}${exitSuffix}: ${command}${outputSuffix}`;
}

function formatCodexMcpToolCallItem(item: Record<string, unknown>): string {
  const server = getString(item, "server") ?? "unknown-server";
  const tool = getString(item, "tool") ?? "unknown-tool";
  const error = isRecord(item.error) ? getString(item.error, "message") : undefined;
  const errorSuffix = error ? `: ${error}` : "";

  return `mcp_tool_call ${getString(item, "status") ?? "unknown"}: ${server}/${tool}${errorSuffix}`;
}

function formatCodexTodoListItem(item: Record<string, unknown>): string {
  const todos = Array.isArray(item.items) ? item.items.filter(isRecord) : [];
  const completed = todos.filter((todo) => todo.completed === true).length;
  const pending = todos.length - completed;
  return `todo_list: ${completed} completed, ${pending} pending`;
}

function truncateLogText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();

  if (singleLine.length <= 500) {
    return singleLine;
  }

  return `${singleLine.slice(0, 497)}...`;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getAdditionalWritableDirectories(workspace: string): string[] {
  const directories = [workspace];

  try {
    const realWorkspace = realpathSync(workspace);
    directories.push(realWorkspace);
  } catch {
    // Keep the original workspace path when realpath resolution is unavailable.
  }

  return [...new Set(directories)];
}

function createCodexEnv(
  codexHome: string,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.CODEX_HOME = codexHome;
  env.NO_COLOR = "1";
  env.npm_config_loglevel = "error";
  Object.assign(env, extraEnv);
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

function getPreviousAuthJson(auth: string): string | undefined {
  if (!auth) {
    return undefined;
  }

  try {
    const authJson = formatCodexAuthJson(decodeAuthSecret(auth));
    validateCodexAuthJson(authJson);
    return authJson;
  } catch {
    return undefined;
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }

    return sorted;
  }

  return value;
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
