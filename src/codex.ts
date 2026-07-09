import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as core from "@actions/core";
import { Codex } from "@openai/codex-sdk";

import { isPullRequestEvent } from "./platform.ts";
import { runInheritedProcess } from "./process.ts";
import type { CodexRunMetadata } from "./types.ts";
import { errorMessage } from "./utils.ts";

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
): Promise<void> {
  if (auth) {
    try {
      const authJson = formatCodexAuthJson(decodeAuthSecret(auth));
      validateCodexAuthJson(authJson);
      maskCodexAuth(authJson);
      writeCodexAuthJson(codexHome, authJson);
      await validateCodexSdkAuth(codexExecutable, codexHome, workspace);
      core.info("Loaded valid Codex auth from repository secret.");
      return;
    } catch (error) {
      core.warning(
        `Repository secret Codex auth is unavailable or invalid: ${errorMessage(error)}`,
      );
    }
  } else {
    core.info("No Codex auth was provided by repository secret.");
  }

  core.info("Starting Codex device authorization. Complete the browser flow shown below.");
  await runInheritedProcess(codexExecutable, ["login", "--device-auth"], {
    cwd: workspace,
    env: createCodexEnv(codexHome),
  });

  const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));
  validateCodexAuthJson(authJson);
  maskCodexAuth(authJson);
  writeCodexAuthJson(codexHome, authJson);
  await validateCodexSdkAuth(codexExecutable, codexHome, workspace);
}

export async function runCodexPrompt(
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

export async function persistCodexAuth(
  codexHome: string,
  previousAuth: string,
  updateAuthSecret: (value: string) => Promise<void>,
): Promise<void> {
  const authPath = path.join(codexHome, "auth.json");

  if (!existsSync(authPath)) {
    return;
  }

  try {
    const authJson = formatCodexAuthJson(readCodexAuthJson(codexHome));
    validateCodexAuthJson(authJson);
    maskCodexAuth(authJson);

    if (authJson === getPreviousAuthJson(previousAuth)) {
      writeCodexAuthJson(codexHome, authJson);
      core.info("Codex auth did not change; repository secret update skipped.");
      return;
    }

    writeCodexAuthJson(codexHome, authJson);
    await updateAuthSecret(encodeAuthSecret(authJson));
    core.info("Stored refreshed Codex auth in repository secret.");
  } catch (error) {
    core.warning(`Could not persist refreshed Codex auth: ${errorMessage(error)}`);
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
