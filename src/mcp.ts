import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as toolCache from "@actions/tool-cache";

import { getPlatformMcp } from "./platforms/index.ts";
import type {
  McpReleaseAsset,
  McpServerConfig,
  Platform,
  PlatformClient,
  PlatformMcp,
} from "./types.ts";

export async function setupCodexMcp(
  codexHome: string,
  platformClient: PlatformClient,
): Promise<Record<string, string>> {
  const executable = await resolveMcpExecutable(platformClient.mcp);
  const server = platformClient.mcp.createServerConfig(executable, getServerUrl());

  core.setSecret(platformClient.token);
  writeFileSync(path.join(codexHome, "config.toml"), buildCodexMcpConfig(server));
  core.info(`Configured ${server.name} MCP server for Codex.`);

  return {
    [server.tokenEnvVar]: platformClient.token,
  };
}

export async function resolveMcpExecutable(platformMcp: PlatformMcp): Promise<string> {
  const override = platformMcp.getExecutableOverride();

  if (override) {
    return override;
  }

  const asset = platformMcp.getReleaseAsset();
  const cachedDirectory = toolCache.find(asset.cacheName, asset.version, asset.target);

  if (cachedDirectory) {
    core.info(`Using cached ${asset.cacheName} ${asset.version} for ${asset.target}.`);
    return findMcpExecutable(cachedDirectory, asset);
  }

  const url = platformMcp.getReleaseAssetUrl();
  core.info(`Downloading ${asset.cacheName} ${asset.version} for ${asset.target}.`);
  const archivePath = await toolCache.downloadTool(url);
  const extractedDirectory =
    asset.format === "zip"
      ? await toolCache.extractZip(archivePath)
      : await toolCache.extractTar(archivePath);
  findMcpExecutable(extractedDirectory, asset);
  const cachedPath = await toolCache.cacheDir(
    extractedDirectory,
    asset.cacheName,
    asset.version,
    asset.target,
  );

  core.info(`Cached ${asset.cacheName} ${asset.version} for ${asset.target}.`);
  return findMcpExecutable(cachedPath, asset);
}

export function createMcpServerConfig(
  platform: Platform,
  executable: string,
  serverUrl: string,
): McpServerConfig {
  return getPlatformMcp(platform).createServerConfig(executable, serverUrl);
}

export function getMcpReleaseAsset(
  platform: Platform,
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): McpReleaseAsset {
  return getPlatformMcp(platform).getReleaseAsset(nodePlatform, arch);
}

export function getMcpReleaseAssetUrl(
  platform: Platform,
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return getPlatformMcp(platform).getReleaseAssetUrl(nodePlatform, arch);
}

export function findMcpExecutable(directory: string, asset: McpReleaseAsset): string {
  const executable = findFirstFile(directory, asset.executableNames);

  if (!executable) {
    throw new Error(
      `Downloaded ${asset.cacheName} archive did not contain an executable in ${directory}`,
    );
  }

  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
  }

  return executable;
}

export function buildCodexMcpConfig(server: McpServerConfig): string {
  const lines = [`[mcp_servers.${server.name}]`, `command = ${tomlString(server.command)}`];

  lines.push(`args = ${tomlArray(server.args)}`);

  if (Object.keys(server.env).length > 0) {
    lines.push(`env = ${tomlInlineTable(server.env)}`);
  }

  lines.push(`env_vars = ${tomlArray([server.tokenEnvVar])}`);
  return `${lines.join("\n")}\n`;
}

function getServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || github.context.serverUrl;
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

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
