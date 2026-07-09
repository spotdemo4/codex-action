import { writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import { getServerUrl } from "./platforms/context.ts";
import { getPlatformMcp } from "./platforms/index.ts";
import { findArchiveExecutable, resolveCachedExecutable } from "./tool-archive.ts";
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
  core.info(`Configured ${server.name} MCP server for Codex`);

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
  return resolveCachedExecutable(asset, platformMcp.getReleaseAssetUrl());
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
  return findArchiveExecutable(directory, asset);
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
