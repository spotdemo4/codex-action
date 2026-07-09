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

export function createPlatformClient(token: string): PlatformClient {
  const platform = detectPlatform();

  if (platform === "github") {
    return new GitHubPlatformClient(token);
  }

  return new ForgejoPlatformClient(platform, token);
}

export function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}

class GitHubPlatformClient implements PlatformClient {
  readonly type = "github";
  private readonly octokit: ReturnType<typeof github.getOctokit>;

  constructor(token: string) {
    this.octokit = github.getOctokit(token);
  }

  async getActionUser(): Promise<ActionUser> {
    const { data } = await this.octokit.rest.users.getAuthenticated();

    return {
      login: data.login,
      id: data.id,
      email: data.email ?? `${data.id}+${data.login}@users.noreply.github.com`,
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
  private readonly token: string;

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

async function encryptGithubSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const binaryPublicKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(value, binaryPublicKey);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
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
