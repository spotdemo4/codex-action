import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import type { ActionInputs } from "./types.ts";
import { errorMessage } from "./utils.ts";

export function readInputs(): ActionInputs {
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
