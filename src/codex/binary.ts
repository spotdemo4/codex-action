import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  findArchiveExecutable,
  resolveCachedExecutable,
  type ToolArchiveAsset,
  type ToolArchiveExecutableSpec,
} from "../tool-archive.ts";

export const CODEX_VERSION = "0.152.1";

export async function resolveCodexExecutable(): Promise<string> {
  if (process.env.CODEX_PATH) {
    return process.env.CODEX_PATH;
  }

  const version = CODEX_VERSION;
  const target = getCodexTargetTriple();

  if (!target) {
    throw new Error(`Unsupported Codex platform: ${process.platform} (${process.arch})`);
  }

  const asset = getCodexToolArchiveAsset(version, target);
  const url = getCodexReleaseAssetUrl(version, target);

  return resolveCachedExecutable(asset, url);
}

export function getCodexTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") {
      return "x86_64-unknown-linux-musl";
    }

    if (arch === "arm64") {
      return "aarch64-unknown-linux-musl";
    }
  }

  if (platform === "darwin") {
    if (arch === "x64") {
      return "x86_64-apple-darwin";
    }

    if (arch === "arm64") {
      return "aarch64-apple-darwin";
    }
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return "x86_64-pc-windows-msvc";
    }

    if (arch === "arm64") {
      return "aarch64-pc-windows-msvc";
    }
  }

  return null;
}

export function getCodexReleaseAsset(target: string): { assetName: string; format: "tar" | "zip" } {
  const supportedTargets = new Set([
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-musl",
  ]);

  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported Codex release target: ${target}`);
  }

  return {
    assetName: `codex-package-${target}.tar.gz`,
    format: "tar",
  };
}

export function getCodexReleaseAssetUrl(version: string, target: string): string {
  const { assetName } = getCodexReleaseAsset(target);
  return `https://github.com/openai/codex/releases/download/rust-v${version}/${assetName}`;
}

export function findCodexExecutable(
  directory: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return findArchiveExecutable(directory, getCodexExecutableSpec(target, platform), platform);
}

export function getCodexExecutableNames(
  target: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32" ? ["codex.exe", `codex-${target}.exe`] : ["codex", `codex-${target}`];
}

export function getCodexToolArchiveAsset(version: string, target: string): ToolArchiveAsset {
  return {
    ...getCodexExecutableSpec(target),
    ...getCodexReleaseAsset(target),
    version,
    target,
  };
}

function getCodexExecutableSpec(
  target: string,
  platform: NodeJS.Platform = process.platform,
): ToolArchiveExecutableSpec {
  return {
    cacheName: "codex-package",
    displayName: "Codex",
    executableNames: getCodexExecutableNames(target, platform),
    validateExecutable: validateCodexPackage,
  };
}

function validateCodexPackage(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const hostName = platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const host = path.join(path.dirname(executable), hostName);

  if (!existsSync(host) || !statSync(host).isFile()) {
    throw new Error(`Downloaded Codex package did not contain ${hostName} next to ${executable}`);
  }

  if (platform !== "win32") {
    chmodSync(host, 0o755);
  }
}
