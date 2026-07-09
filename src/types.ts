export type Platform = "github" | "gitea" | "forgejo";

export type McpReleaseAsset = {
  cacheName: string;
  version: string;
  target: string;
  assetName: string;
  format: "tar" | "zip";
  executableNames: string[];
};

export type McpServerConfig = {
  name: string;
  command: string;
  tokenEnvVar: string;
  args: string[];
  env: Record<string, string>;
};

export type PlatformMcp = {
  createServerConfig(executable: string, serverUrl: string): McpServerConfig;
  getReleaseAsset(nodePlatform?: NodeJS.Platform, arch?: string): McpReleaseAsset;
  getReleaseAssetUrl(nodePlatform?: NodeJS.Platform, arch?: string): string;
  getExecutableOverride(): string | undefined;
};

export type ActionInputs = {
  auth: string | undefined;
  authSecret: string;
  prompt: string;
  model: string | undefined;
  token: string | undefined;
  githubAppClientId: string | undefined;
  githubAppPrivateKey: string | undefined;
  automerge: boolean | undefined;
  dryRun: boolean;
};

export type ActionUser = {
  login: string;
  id: number | string;
  email: string;
};

export type PlatformClient = {
  type: Platform;
  token: string;
  mcp: PlatformMcp;
  getActionUser(): Promise<ActionUser>;
  postPullRequestComment(body: string): Promise<void>;
  setPullRequestAutomerge(enabled: boolean): Promise<void>;
  updateRepositoryAuthSecret(secretName: string, value: string): Promise<void>;
};

export type CodexRunMetadata = {
  commitMessage: string;
  prComment: string;
};

export type PullRequestPayload = {
  number?: number;
  pull_request?: {
    number?: number;
    node_id?: string;
    head?: {
      ref?: string;
      repo?: {
        full_name?: string;
      };
    };
  };
};

export type GiteaUserResponse = {
  id?: number;
  login?: string;
  username?: string;
  name?: string;
  email?: string;
  full_name?: string;
};
