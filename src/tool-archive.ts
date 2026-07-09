import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";

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
  const cachedDirectory = toolCache.find(asset.cacheName, asset.version, asset.target);

  if (cachedDirectory) {
    core.info(`Using cached ${name} ${asset.version} for ${asset.target}`);
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
