import {
  findArchiveExecutable,
  resolveCachedExecutable,
  type ToolArchiveAsset,
  type ToolArchiveExecutableSpec,
} from "../tool-archive.ts";

const CODEX_VERSION = "0.144.4";

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
  const assets: Record<string, { assetName: string; format: "tar" | "zip" }> = {
    "aarch64-apple-darwin": {
      assetName: "codex-aarch64-apple-darwin.tar.gz",
      format: "tar",
    },
    "aarch64-pc-windows-msvc": {
      assetName: "codex-aarch64-pc-windows-msvc.exe.zip",
      format: "zip",
    },
    "aarch64-unknown-linux-musl": {
      assetName: "codex-aarch64-unknown-linux-musl.tar.gz",
      format: "tar",
    },
    "x86_64-apple-darwin": {
      assetName: "codex-x86_64-apple-darwin.tar.gz",
      format: "tar",
    },
    "x86_64-pc-windows-msvc": {
      assetName: "codex-x86_64-pc-windows-msvc.exe.zip",
      format: "zip",
    },
    "x86_64-unknown-linux-musl": {
      assetName: "codex-x86_64-unknown-linux-musl.tar.gz",
      format: "tar",
    },
  };
  const asset = assets[target];

  if (!asset) {
    throw new Error(`Unsupported Codex release target: ${target}`);
  }

  return asset;
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

function getCodexToolArchiveAsset(version: string, target: string): ToolArchiveAsset {
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
    cacheName: "codex",
    displayName: "Codex",
    executableNames: getCodexExecutableNames(target, platform),
  };
}
