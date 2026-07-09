import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import * as core from "@actions/core";

import { errorMessage } from "../utils.ts";
import { createCodexEnv } from "./env.ts";

const CODEX_APP_SERVER_TIMEOUT_MS = 30_000;

type PendingCodexAppServerResponse = {
  method: string;
  timeout: NodeJS.Timeout;
  resolve(result: unknown): void;
  reject(error: Error): void;
};

export type CodexAppServer = {
  request(id: number, method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
};

export function startCodexAppServer(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
): CodexAppServer {
  const child = spawn(codexExecutable, ["app-server", "--stdio"], {
    cwd: workspace,
    env: createCodexEnv(codexHome),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<string, PendingCodexAppServerResponse>();
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
  pending: Map<string, PendingCodexAppServerResponse>,
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
  pending: Map<string, PendingCodexAppServerResponse>,
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
