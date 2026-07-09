import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import type { ActionInputs } from "./types.ts";

const DEFAULT_AUTH_SECRET = "CODEX_ACTION_AUTH";

export function readInputs(): ActionInputs {
  const auth = core.getInput("auth");
  const authSecret = validateSecretName(core.getInput("auth-secret") || DEFAULT_AUTH_SECRET);
  const prompt = core.getInput("prompt", { required: true });
  const model = parseOptionalString(core.getInput("model"));
  const token = core.getInput("token", { required: true });
  const automerge = parseOptionalBoolean(core.getInput("automerge"));

  if (auth) {
    core.setSecret(auth);
  }

  core.setSecret(token);

  return {
    auth,
    authSecret,
    prompt,
    model,
    token,
    automerge,
  };
}

export function parseOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function validateSecretName(value: string): string {
  const name = value.trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      "auth-secret must contain only letters, numbers, and underscores, and cannot start with a number",
    );
  }

  if (name.toUpperCase().startsWith("GITHUB_")) {
    throw new Error("auth-secret must not start with GITHUB_");
  }

  return name;
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
