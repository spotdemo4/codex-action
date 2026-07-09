import { createSign } from "node:crypto";

import * as core from "@actions/core";
import * as github from "@actions/github";
import sodium from "libsodium-wrappers";

import type {
  ActionUser,
  GiteaUserResponse,
  Platform,
  PlatformClient,
  PullRequestPayload,
} from "./types.ts";
import { errorMessage } from "./utils.ts";

export const GITHUB_APP_INSTALLATION_PERMISSIONS = {
  actions: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  secrets: "write",
} as const;

type PlatformClientOptions = {
  token: string | undefined;
  githubAppClientId: string | undefined;
  githubAppPrivateKey: string | undefined;
};

type GitHubAppInstallationAuthentication = {
  token: string;
  appSlug: string;
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  if (env.FORGEJO_ACTIONS) {
    return "forgejo";
  }

  if (env.GITEA_ACTIONS) {
    return "gitea";
  }

  return "github";
}

export async function createPlatformClient(
  options: PlatformClientOptions,
): Promise<PlatformClient> {
  const platform = detectPlatform();

  if (platform === "github") {
    if (options.githubAppClientId && options.githubAppPrivateKey) {
      const auth = await createGitHubAppInstallationAuthentication(
        options.githubAppClientId,
        options.githubAppPrivateKey,
      );

      return new GitHubPlatformClient(auth.token, auth.appSlug);
    }

    if (!options.token) {
      throw new Error("token is required for GitHub unless client-id and private-key are provided");
    }

    return new GitHubPlatformClient(options.token);
  }

  if (options.githubAppClientId || options.githubAppPrivateKey) {
    throw new Error("client-id and private-key are only supported on GitHub");
  }

  if (!options.token) {
    throw new Error("token is required for Gitea and Forgejo");
  }

  return new ForgejoPlatformClient(platform, options.token);
}

export function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}

class GitHubPlatformClient implements PlatformClient {
  readonly type = "github";
  readonly token: string;
  private readonly appSlug: string | undefined;
  private readonly octokit: ReturnType<typeof github.getOctokit>;

  constructor(token: string, appSlug?: string) {
    this.token = token;
    this.appSlug = appSlug;
    this.octokit = github.getOctokit(token);
  }

  async getActionUser(): Promise<ActionUser> {
    if (this.appSlug) {
      return this.getGitHubAppBotUser(this.appSlug);
    }

    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();

      return {
        login: data.login,
        id: data.id,
        email: data.email ?? `${data.id}+${data.login}@users.noreply.github.com`,
      };
    } catch (error) {
      if (!isGitHubAppInstallationUserError(error)) {
        throw error;
      }

      core.info("GitHub installation token cannot read /user; using github-actions[bot].");
      return getGitHubActionsBotUser();
    }
  }

  private async getGitHubAppBotUser(appSlug: string): Promise<ActionUser> {
    const { data } = await this.octokit.rest.users.getByUsername({
      username: getGitHubAppBotLogin(appSlug),
    });

    return {
      login: data.login,
      id: data.id,
      email: buildGitHubNoreplyEmail(data.id, data.login),
    };
  }

  async postPullRequestComment(body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: getPullRequestNumber(),
      body,
    });

    core.info("Posted Codex pull request comment.");
  }

  async setPullRequestAutomerge(enabled: boolean): Promise<void> {
    const pullRequestId = await this.getPullRequestNodeId();

    if (enabled) {
      await this.octokit.graphql(
        `mutation($pullRequestId: ID!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
            pullRequest { id }
          }
        }`,
        { pullRequestId },
      );
      core.info("Enabled GitHub pull request automerge.");
      return;
    }

    try {
      await this.octokit.graphql(
        `mutation($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
            pullRequest { id }
          }
        }`,
        { pullRequestId },
      );
      core.info("Disabled GitHub pull request automerge.");
    } catch (error) {
      core.warning(`Could not disable GitHub pull request automerge: ${errorMessage(error)}`);
    }
  }

  async updateRepositoryAuthSecret(secretName: string, value: string): Promise<void> {
    const publicKey = await this.octokit.rest.actions.getRepoPublicKey(github.context.repo);
    const encryptedValue = await encryptGithubSecret(value, publicKey.data.key);

    await this.octokit.rest.actions.createOrUpdateRepoSecret({
      ...github.context.repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: publicKey.data.key_id,
    });
  }

  private async getPullRequestNodeId(): Promise<string> {
    const payload = github.context.payload as PullRequestPayload;

    if (payload.pull_request?.node_id) {
      return payload.pull_request.node_id;
    }

    const { data } = await this.octokit.rest.pulls.get({
      ...github.context.repo,
      pull_number: getPullRequestNumber(),
    });

    return data.node_id;
  }
}

class ForgejoPlatformClient implements PlatformClient {
  readonly type: "gitea" | "forgejo";
  readonly token: string;

  constructor(type: "gitea" | "forgejo", token: string) {
    this.type = type;
    this.token = token;
  }

  async getActionUser(): Promise<ActionUser> {
    const response = await forgejoRequest<GiteaUserResponse>("GET", "/user", this.token);
    const login = response.login ?? response.username ?? response.name;

    if (!login) {
      throw new Error(`${this.type} user response did not include a login`);
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

    core.info("Posted Codex pull request comment.");
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
        core.info(`Enabled ${this.type} pull request automerge.`);
        return;
      }

      await forgejoRequest("DELETE", route, this.token);
      core.info(`Disabled ${this.type} pull request automerge.`);
    } catch (error) {
      const suffix = error instanceof HttpError ? `HTTP ${error.status}` : errorMessage(error);
      core.warning(
        `Could not ${enabled ? "enable" : "disable"} ${this.type} pull request automerge: ${suffix}`,
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

export function getGitHubActionsBotUser(): ActionUser {
  const login = "github-actions[bot]";
  const id = 41898282;

  return {
    login,
    id,
    email: buildGitHubNoreplyEmail(id, login),
  };
}

export function getGitHubAppBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}

export function buildGitHubNoreplyEmail(id: number | string, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export function createGitHubAppJwt(
  clientId: string,
  privateKey: string,
  nowMs = Date.now(),
): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: clientId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(normalizePrivateKey(privateKey), "base64url");

  return `${signingInput}.${signature}`;
}

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

export function isGitHubAppInstallationUserError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  const message = (error as { message?: unknown }).message;

  return (
    status === 403 &&
    typeof message === "string" &&
    message.includes("Resource not accessible by integration")
  );
}

async function encryptGithubSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const binaryPublicKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(value, binaryPublicKey);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

async function createGitHubAppInstallationAuthentication(
  clientId: string,
  privateKey: string,
): Promise<GitHubAppInstallationAuthentication> {
  core.setSecret(normalizePrivateKey(privateKey));
  const jwt = createGitHubAppJwt(clientId, privateKey);
  core.setSecret(jwt);

  const appOctokit = github.getOctokit(jwt);
  const [{ data: app }, { data: installation }] = await Promise.all([
    appOctokit.rest.apps.getAuthenticated(),
    appOctokit.rest.apps.getRepoInstallation(github.context.repo),
  ]);

  if (!app?.slug) {
    throw new Error("GitHub App response did not include a slug");
  }
  const appSlug = app.slug;

  const { data: installationAccessToken } =
    await appOctokit.rest.apps.createInstallationAccessToken({
      installation_id: installation.id,
      repositories: [github.context.repo.repo],
      permissions: GITHUB_APP_INSTALLATION_PERMISSIONS,
    });

  core.setSecret(installationAccessToken.token);
  core.info(`Created GitHub App installation token for ${appSlug}.`);

  return {
    token: installationAccessToken.token,
    appSlug,
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
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

function getPullRequestNumber(): number {
  const payload = github.context.payload as PullRequestPayload;
  const issueNumber = payload.pull_request?.number ?? payload.number ?? github.context.issue.number;

  if (!issueNumber) {
    throw new Error("This action is not running for a pull request event");
  }

  return issueNumber;
}

function getServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || github.context.serverUrl;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
