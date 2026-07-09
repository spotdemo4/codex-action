import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";

import * as actionCache from "@actions/cache";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";

export type ToolArchiveExecutableSpec = {
  cacheName: string;
  displayName?: string;
  executableNames: string[];
};

export type ToolArchiveAsset = ToolArchiveExecutableSpec & {
  version: string;
  target: string;
  format: "tar" | "zip";
};

export async function resolveCachedExecutable(
  asset: ToolArchiveAsset,
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const name = formatToolArchiveName(asset);
  let cachedDirectory = toolCache.find(asset.cacheName, asset.version, asset.target);

  if (cachedDirectory) {
    core.info(`Using cached ${name} ${asset.version} for ${asset.target}`);
    return findArchiveExecutable(cachedDirectory, asset, platform);
  }

  await restoreToolArchiveCache(asset);
  cachedDirectory = toolCache.find(asset.cacheName, asset.version, asset.target);

  if (cachedDirectory) {
    core.info(`Using action-cached ${name} ${asset.version} for ${asset.target}`);
    return findArchiveExecutable(cachedDirectory, asset, platform);
  }

  core.info(`Downloading ${name} ${asset.version} for ${asset.target}`);
  const archivePath = await toolCache.downloadTool(url);
  const extractedDirectory =
    asset.format === "zip"
      ? await toolCache.extractZip(archivePath)
      : await toolCache.extractTar(archivePath);
  findArchiveExecutable(extractedDirectory, asset, platform);
  const cachedPath = await toolCache.cacheDir(
    extractedDirectory,
    asset.cacheName,
    asset.version,
    asset.target,
  );

  core.info(`Cached ${name} ${asset.version} for ${asset.target}`);
  await saveToolArchiveCache(asset, cachedPath);
  return findArchiveExecutable(cachedPath, asset, platform);
}

export function findArchiveExecutable(
  directory: string,
  spec: ToolArchiveExecutableSpec,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = findFirstFile(directory, spec.executableNames);

  if (!executable) {
    throw new Error(
      `Downloaded ${formatToolArchiveName(spec)} archive did not contain an executable in ${directory}`,
    );
  }

  if (platform !== "win32") {
    chmodSync(executable, 0o755);
  }

  return executable;
}

function formatToolArchiveName(spec: ToolArchiveExecutableSpec): string {
  return spec.displayName ?? spec.cacheName;
}

async function restoreToolArchiveCache(asset: ToolArchiveAsset): Promise<void> {
  if (!actionCache.isFeatureAvailable()) {
    core.debug("Actions cache service is not available; skipping tool archive restore");
    return;
  }

  const name = formatToolArchiveName(asset);
  const key = getToolArchiveCacheKey(asset);

  try {
    core.info(`Restoring cached ${name} ${asset.version} for ${asset.target}`);
    const restoredKey = await actionCache.restoreCache(getToolArchiveCachePaths(asset), key);

    if (restoredKey) {
      core.info(`Restored ${name} cache: ${restoredKey}`);
    } else {
      core.info(`No ${name} action cache found for ${asset.version} ${asset.target}`);
    }
  } catch (error) {
    core.warning(`Failed to restore ${name} action cache: ${formatErrorMessage(error)}`);
  }
}

async function saveToolArchiveCache(asset: ToolArchiveAsset, cachedPath: string): Promise<void> {
  if (!actionCache.isFeatureAvailable()) {
    core.debug("Actions cache service is not available; skipping tool archive save");
    return;
  }

  const name = formatToolArchiveName(asset);
  const key = getToolArchiveCacheKey(asset);

  try {
    const cacheId = await actionCache.saveCache(getToolArchiveCachePaths(asset, cachedPath), key);

    if (cacheId > 0) {
      core.info(`Saved ${name} action cache: ${key}`);
    }
  } catch (error) {
    core.warning(`Failed to save ${name} action cache: ${formatErrorMessage(error)}`);
  }
}

export function getToolArchiveCacheKey(asset: ToolArchiveAsset): string {
  return `codex-action-tool-cache-v1-${asset.cacheName}-${asset.version}-${asset.target}`;
}

export function getToolArchiveCachePaths(asset: ToolArchiveAsset, cachedPath?: string): string[] {
  const cachePath =
    cachedPath ??
    path.join(getRunnerToolCacheDirectory(), asset.cacheName, asset.version, asset.target);

  return [cachePath, `${cachePath}.complete`];
}

function getRunnerToolCacheDirectory(): string {
  const cacheDirectory = process.env.RUNNER_TOOL_CACHE;

  if (!cacheDirectory) {
    throw new Error("Expected RUNNER_TOOL_CACHE to be defined");
  }

  return cacheDirectory;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findFirstFile(directory: string, fileNames: string[]): string | null {
  for (const fileName of fileNames) {
    const found = findFile(directory, fileName);

    if (found) {
      return found;
    }
  }

  return null;
}

function findFile(directory: string, fileName: string): string | null {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const found = findFile(entryPath, fileName);

      if (found) {
        return found;
      }
    }
  }

  return null;
}
