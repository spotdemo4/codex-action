import * as core from "@actions/core";
import * as github from "@actions/github";

import type {
  ActionUser,
  GiteaUserResponse,
  McpReleaseAsset,
  PlatformClient,
  PlatformMcp,
} from "../types.ts";
import { errorMessage } from "../utils.ts";
import { getPullRequestNumber, getServerUrl } from "./context.ts";

const FORGEJO_MCP_VERSION = "2.30.1";

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const forgejoMcp: PlatformMcp = {
  createServerConfig(executable, serverUrl) {
    return {
      name: "forgejo",
      command: executable,
      tokenEnvVar: "FORGEJO_ACCESS_TOKEN",
      args: ["--transport", "stdio", "--url", serverUrl],
      env: {
        FORGEJO_USER_AGENT: "codex-action",
      },
    };
  },

  getReleaseAsset: getForgejoMcpReleaseAsset,

  getReleaseAssetUrl(nodePlatform = process.platform, arch = process.arch) {
    const asset = getForgejoMcpReleaseAsset(nodePlatform, arch);
    return `https://codeberg.org/goern/forgejo-mcp/releases/download/v${asset.version}/${asset.assetName}`;
  },

  getExecutableOverride() {
    return process.env.FORGEJO_MCP_PATH;
  },
};

export class ForgejoPlatformClient implements PlatformClient {
  readonly type = "forgejo";
  readonly mcp = forgejoMcp;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getActionUser(): Promise<ActionUser> {
    const response = await forgejoRequest<GiteaUserResponse>("GET", "/user", this.token);
    const login = response.login ?? response.username ?? response.name;

    if (!login) {
      throw new Error("forgejo user response did not include a login");
    }

    const id = response.id ?? login;
    const host = new URL(getServerUrl()).hostname;

    return {
      login,
      id,
      email: response.email || `${id}+${login}@users.noreply.${host}`,
    };
  }

  async postPullRequestComment(body: string): Promise<void> {
    const { owner, repo } = github.context.repo;
    await forgejoRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${getPullRequestNumber()}/comments`,
      this.token,
      { body },
    );

    core.info("Posted Codex pull request comment");
  }

  async setPullRequestAutomerge(enabled: boolean): Promise<void> {
    const { owner, repo } = github.context.repo;
    const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${getPullRequestNumber()}/merge`;

    try {
      if (enabled) {
        await forgejoRequest("POST", route, this.token, {
          Do: "merge",
          merge_when_checks_succeed: true,
        });
        core.info("Enabled forgejo pull request automerge");
        return;
      }

      await forgejoRequest("DELETE", route, this.token);
      core.info("Disabled forgejo pull request automerge");
    } catch (error) {
      const suffix = error instanceof HttpError ? `HTTP ${error.status}` : errorMessage(error);
      core.warning(
        `Could not ${enabled ? "enable" : "disable"} forgejo pull request automerge: ${suffix}`,
      );
    }
  }

  async updateRepositoryAuthSecret(secretName: string, value: string): Promise<void> {
    const { owner, repo } = github.context.repo;
    await forgejoRequest(
      "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/${encodeURIComponent(secretName)}`,
      this.token,
      { data: value },
    );
  }
}

function getForgejoMcpReleaseAsset(
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): McpReleaseAsset {
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

async function forgejoRequest<T = unknown>(
  method: string,
  route: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(`api/v1${route}`, ensureTrailingSlash(getServerUrl()));
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, text || response.statusText);
  }

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
