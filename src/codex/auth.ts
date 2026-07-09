import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import { errorMessage } from "../utils.ts";
import { startCodexAppServer } from "./app-server.ts";
import { createCodexEnv } from "./env.ts";

const CODEX_AUTH_REFRESH_SKEW_MS = 10 * 60 * 1000;

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
  await exec.exec(codexExecutable, ["login", "--device-auth"], {
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
