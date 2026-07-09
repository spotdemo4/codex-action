import * as core from "@actions/core";
import * as github from "@actions/github";

import type { ActionUser, GiteaUserResponse, Platform, PullRequestPayload } from "./types.ts";
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

export async function getActionUser(platform: Platform, token: string): Promise<ActionUser> {
  if (platform === "github") {
    const octokit = github.getOctokit(token);
    const { data } = await octokit.rest.users.getAuthenticated();

    return {
      login: data.login,
      id: data.id,
      email: data.email ?? `${data.id}+${data.login}@users.noreply.github.com`,
    };
  }

  const response = await forgejoRequest<GiteaUserResponse>("GET", "/user", token);
  const login = response.login ?? response.username ?? response.name;

  if (!login) {
    throw new Error(`${platform} user response did not include a login`);
  }

  const id = response.id ?? login;
  const host = new URL(getServerUrl()).hostname;

  return {
    login,
    id,
    email: response.email || `${id}+${login}@users.noreply.${host}`,
  };
}

export async function postPullRequestComment(
  platform: Platform,
  token: string,
  body: string,
): Promise<void> {
  const issueNumber = getPullRequestNumber();

  if (platform === "github") {
    const octokit = github.getOctokit(token);
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: issueNumber,
      body,
    });
  } else {
    const { owner, repo } = github.context.repo;
    await forgejoRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      token,
      { body },
    );
  }

  core.info("Posted Codex pull request comment.");
}

export async function setPullRequestAutomerge(
  platform: Platform,
  token: string,
  enabled: boolean,
): Promise<void> {
  if (platform === "github") {
    await setGithubPullRequestAutomerge(token, enabled);
    return;
  }

  await setForgejoPullRequestAutomerge(platform, token, enabled);
}

export function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}

async function setGithubPullRequestAutomerge(token: string, enabled: boolean): Promise<void> {
  const octokit = github.getOctokit(token);
  const pullRequestId = await getGithubPullRequestNodeId(token);

  if (enabled) {
    await octokit.graphql(
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
    await octokit.graphql(
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

async function getGithubPullRequestNodeId(token: string): Promise<string> {
  const payload = github.context.payload as PullRequestPayload;

  if (payload.pull_request?.node_id) {
    return payload.pull_request.node_id;
  }

  const octokit = github.getOctokit(token);
  const { data } = await octokit.rest.pulls.get({
    ...github.context.repo,
    pull_number: getPullRequestNumber(),
  });

  return data.node_id;
}

async function setForgejoPullRequestAutomerge(
  platform: Platform,
  token: string,
  enabled: boolean,
): Promise<void> {
  const { owner, repo } = github.context.repo;
  const issueNumber = getPullRequestNumber();
  const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issueNumber}/merge`;

  try {
    if (enabled) {
      await forgejoRequest("POST", route, token, {
        Do: "merge",
        merge_when_checks_succeed: true,
      });
      core.info(`Enabled ${platform} pull request automerge.`);
      return;
    }

    await forgejoRequest("DELETE", route, token);
    core.info(`Disabled ${platform} pull request automerge.`);
  } catch (error) {
    const suffix = error instanceof HttpError ? `HTTP ${error.status}` : errorMessage(error);
    core.warning(
      `Could not ${enabled ? "enable" : "disable"} ${platform} pull request automerge: ${suffix}`,
    );
  }
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
