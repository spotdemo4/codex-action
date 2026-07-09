import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

import type { ActionUser, Platform, PullRequestPayload } from "./types.ts";

export async function configureGitUser(workspace: string, user: ActionUser): Promise<void> {
  await runGit(["config", "user.name", user.login], workspace);
  await runGit(["config", "user.email", user.email], workspace);
  core.info(`Configured git user as ${user.login} <${user.email}>`);
}

export async function hasGitChanges(workspace: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], workspace);
  return stdout.trim().length > 0;
}

export async function commitChanges(workspace: string, commitMessage: string): Promise<void> {
  const message = commitMessage || "Update with Codex";

  await runGit(["add", "-A"], workspace);
  await runGit(["commit", "-m", message], workspace);
  core.info("Committed Codex changes");
}

export async function pushChanges(
  workspace: string,
  platform: Platform,
  user: ActionUser,
  token: string,
): Promise<void> {
  const { stdout } = await runGit(["remote", "get-url", "origin"], workspace);
  const authenticatedUrl = buildAuthenticatedRemoteUrl(stdout.trim(), platform, user, token);

  if (!authenticatedUrl) {
    throw new Error("origin remote must be HTTP(S) or SSH-style to push with the action token");
  }

  core.setSecret(authenticatedUrl);

  const pushRef = await resolvePushRef(workspace);
  await runGit(
    [
      ...buildCredentialIsolationGitArgs(authenticatedUrl),
      "push",
      authenticatedUrl,
      `HEAD:${pushRef}`,
    ],
    workspace,
    { env: createNonInteractiveGitEnv() },
  );
  core.info("Pushed Codex changes");
}

async function resolvePushRef(workspace: string): Promise<string> {
  const payload = github.context.payload as PullRequestPayload;
  const prHeadRef = payload.pull_request?.head?.ref ?? process.env.GITHUB_HEAD_REF;

  if (prHeadRef) {
    return prHeadRef;
  }

  if (process.env.GITHUB_REF_TYPE !== "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspace);
  const branch = stdout.trim();

  if (!branch || branch === "HEAD") {
    throw new Error("Could not determine a branch to push Codex changes to");
  }

  return branch;
}

async function runGit(
  args: string[],
  workspace: string,
  options: exec.ExecOptions = {},
): Promise<exec.ExecOutput> {
  return exec.getExecOutput("git", args, { ...options, cwd: workspace, silent: true });
}

export function buildAuthenticatedRemoteUrl(
  remoteUrl: string,
  platform: Platform,
  user: ActionUser,
  token: string,
): string | null {
  const url = normalizeRemoteUrl(remoteUrl);

  if (!url) {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (platform === "github") {
    url.username = "x-access-token";
  } else {
    url.username = user.login;
  }

  url.password = token;
  return url.toString();
}

export function buildCredentialIsolationGitArgs(remoteUrl: string): string[] {
  const configUrls = buildGitCredentialConfigUrls(remoteUrl);
  const configValues = [
    "credential.helper=",
    ...configUrls.map((url) => `credential.${url}.helper=`),
    "http.extraheader=",
    ...configUrls.map((url) => `http.${url}.extraheader=`),
  ];

  return configValues.flatMap((value) => ["-c", value]);
}

function normalizeRemoteUrl(remoteUrl: string): URL | null {
  try {
    const url = new URL(remoteUrl);

    if (url.protocol === "ssh:") {
      return sshUrlToHttpsUrl(url);
    }

    return url;
  } catch {
    return scpLikeUrlToHttpsUrl(remoteUrl);
  }
}

function sshUrlToHttpsUrl(url: URL): URL | null {
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    return null;
  }

  return new URL(`https://${url.hostname}${url.pathname}`);
}

function scpLikeUrlToHttpsUrl(remoteUrl: string): URL | null {
  const match = /^(?:[^@\s]+)@([^:\s]+):(.+)$/.exec(remoteUrl);
  const host = match?.[1];
  const path = match?.[2]?.replace(/^\/+/, "");

  if (!host || !path) {
    return null;
  }

  return new URL(`https://${host}/${path}`);
}

function buildGitCredentialConfigUrls(remoteUrl: string): string[] {
  const url = normalizeRemoteUrl(remoteUrl);

  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return [];
  }

  url.username = "";
  url.password = "";

  const urls = new Set<string>([`${url.protocol}//${url.host}/`]);
  const path = url.pathname.replace(/\/+$/, "");

  if (path && path !== "/") {
    const repoUrl = `${url.protocol}//${url.host}${path}`;
    urls.add(repoUrl);

    if (repoUrl.endsWith(".git")) {
      urls.add(repoUrl.slice(0, -4));
    }
  }

  return [...urls];
}

function createNonInteractiveGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.GIT_ASKPASS = "";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
