import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as toolCache from "@actions/tool-cache";

import type { Platform } from "./types.ts";

const GITHUB_MCP_VERSION = "1.5.0";
const GITEA_MCP_VERSION = "1.3.0";
const FORGEJO_MCP_VERSION = "2.30.1";
const GITHUB_MCP_TOOLSETS = "repos,issues,pull_requests,actions";

type McpReleaseAsset = {
  cacheName: string;
  version: string;
  target: string;
  assetName: string;
  format: "tar" | "zip";
  executableNames: string[];
};

type McpServerConfig = {
  name: string;
  command: string;
  tokenEnvVar: string;
  args: string[];
  env: Record<string, string>;
};

export async function setupCodexMcp(
  codexHome: string,
  platform: Platform,
  token: string,
): Promise<Record<string, string>> {
  const executable = await resolveMcpExecutable(platform);
  const server = createMcpServerConfig(platform, executable, getServerUrl());

  core.setSecret(token);
  writeFileSync(path.join(codexHome, "config.toml"), buildCodexMcpConfig(server));
  core.info(`Configured ${server.name} MCP server for Codex.`);

  return {
    [server.tokenEnvVar]: token,
  };
}

export async function resolveMcpExecutable(platform: Platform): Promise<string> {
  const override = getMcpExecutableOverride(platform);

  if (override) {
    return override;
  }

  const asset = getMcpReleaseAsset(platform);
  const cachedDirectory = toolCache.find(asset.cacheName, asset.version, asset.target);

  if (cachedDirectory) {
    core.info(`Using cached ${asset.cacheName} ${asset.version} for ${asset.target}.`);
    return findMcpExecutable(cachedDirectory, asset);
  }

  const url = getMcpReleaseAssetUrl(platform);
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
  if (platform === "github") {
    return {
      name: "github",
      command: executable,
      tokenEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      args: ["stdio"],
      env: {
        GITHUB_HOST: serverUrl,
        GITHUB_TOOLSETS: GITHUB_MCP_TOOLSETS,
        GITHUB_READ_ONLY: "1",
      },
    };
  }

  if (platform === "gitea") {
    return {
      name: "gitea",
      command: executable,
      tokenEnvVar: "GITEA_ACCESS_TOKEN",
      args: ["-t", "stdio", "--host", serverUrl],
      env: {},
    };
  }

  return {
    name: "forgejo",
    command: executable,
    tokenEnvVar: "FORGEJO_ACCESS_TOKEN",
    args: ["--transport", "stdio", "--url", serverUrl],
    env: {
      FORGEJO_USER_AGENT: "codex-action",
    },
  };
}

export function getMcpReleaseAsset(
  platform: Platform,
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): McpReleaseAsset {
  if (platform === "github") {
    return getGitHubMcpReleaseAsset(nodePlatform, arch);
  }

  if (platform === "gitea") {
    return getGiteaMcpReleaseAsset(nodePlatform, arch);
  }

  return getForgejoMcpReleaseAsset(nodePlatform, arch);
}

export function getMcpReleaseAssetUrl(
  platform: Platform,
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const asset = getMcpReleaseAsset(platform, nodePlatform, arch);

  if (asset.cacheName === "github-mcp-server") {
    return `https://github.com/github/github-mcp-server/releases/download/v${asset.version}/${asset.assetName}`;
  }

  if (asset.cacheName === "gitea-mcp") {
    return `https://gitea.com/gitea/gitea-mcp/releases/download/v${asset.version}/${asset.assetName}`;
  }

  return `https://codeberg.org/goern/forgejo-mcp/releases/download/v${asset.version}/${asset.assetName}`;
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

function getGitHubMcpReleaseAsset(nodePlatform: NodeJS.Platform, arch: string): McpReleaseAsset {
  const os = getGitHubMcpOs(nodePlatform);
  const releaseArch = getGitHubMcpArch(arch);

  if (!os || !releaseArch) {
    throw new Error(`Unsupported GitHub MCP platform: ${nodePlatform} (${arch})`);
  }

  const format = nodePlatform === "win32" ? "zip" : "tar";
  const extension = format === "zip" ? "zip" : "tar.gz";

  return {
    cacheName: "github-mcp-server",
    version: GITHUB_MCP_VERSION,
    target: `${os}-${releaseArch}`,
    assetName: `github-mcp-server_${os}_${releaseArch}.${extension}`,
    format,
    executableNames: nodePlatform === "win32" ? ["github-mcp-server.exe"] : ["github-mcp-server"],
  };
}

function getGiteaMcpReleaseAsset(nodePlatform: NodeJS.Platform, arch: string): McpReleaseAsset {
  const os = getGitHubMcpOs(nodePlatform);
  const releaseArch = getGitHubMcpArch(arch);

  if (!os || !releaseArch) {
    throw new Error(`Unsupported Gitea MCP platform: ${nodePlatform} (${arch})`);
  }

  const format = nodePlatform === "win32" ? "zip" : "tar";
  const extension = format === "zip" ? "zip" : "tar.gz";

  return {
    cacheName: "gitea-mcp",
    version: GITEA_MCP_VERSION,
    target: `${os}-${releaseArch}`,
    assetName: `gitea-mcp_${os}_${releaseArch}.${extension}`,
    format,
    executableNames: nodePlatform === "win32" ? ["gitea-mcp.exe"] : ["gitea-mcp"],
  };
}

function getForgejoMcpReleaseAsset(nodePlatform: NodeJS.Platform, arch: string): McpReleaseAsset {
  const os = getForgejoMcpOs(nodePlatform);
  const releaseArch = getForgejoMcpArch(arch);

  if (!os || !releaseArch) {
    throw new Error(`Unsupported Forgejo MCP platform: ${nodePlatform} (${arch})`);
  }

  return {
    cacheName: "forgejo-mcp",
    version: FORGEJO_MCP_VERSION,
    target: `${os}-${releaseArch}`,
    assetName: `forgejo-mcp_${FORGEJO_MCP_VERSION}_${os}_${releaseArch}.tar.gz`,
    format: "tar",
    executableNames: ["forgejo-mcp"],
  };
}

function getGitHubMcpOs(platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    return "Linux";
  }

  if (platform === "darwin") {
    return "Darwin";
  }

  if (platform === "win32") {
    return "Windows";
  }

  return null;
}

function getGitHubMcpArch(arch: string): string | null {
  if (arch === "x64") {
    return "x86_64";
  }

  if (arch === "arm64") {
    return "arm64";
  }

  return null;
}

function getForgejoMcpOs(platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    return "linux";
  }

  if (platform === "darwin") {
    return "darwin";
  }

  return null;
}

function getForgejoMcpArch(arch: string): string | null {
  if (arch === "x64") {
    return "amd64";
  }

  if (arch === "arm64") {
    return "arm64";
  }

  return null;
}

function getMcpExecutableOverride(platform: Platform): string | undefined {
  if (platform === "github") {
    return process.env.GITHUB_MCP_SERVER_PATH;
  }

  if (platform === "gitea") {
    return process.env.GITEA_MCP_PATH;
  }

  return process.env.FORGEJO_MCP_PATH;
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
