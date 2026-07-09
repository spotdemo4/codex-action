import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

import type { ActionUser, Platform, PullRequestPayload } from "./types.ts";

export async function configureGitUser(workspace: string, user: ActionUser): Promise<void> {
  await runGit(["config", "user.name", user.login], workspace);
  await runGit(["config", "user.email", user.email], workspace);
  core.info(`Configured git user as ${user.login} <${user.email}>.`);
}

export async function hasGitChanges(workspace: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], workspace);
  return stdout.trim().length > 0;
}

export async function commitChanges(workspace: string, commitMessage: string): Promise<void> {
  const message = commitMessage || "Update with Codex";

  await runGit(["add", "-A"], workspace);
  await runGit(["commit", "-m", message], workspace);
  core.info("Committed Codex changes.");
}

export async function pushChanges(
  workspace: string,
  platform: Platform,
  user: ActionUser,
  token: string,
): Promise<void> {
  await withAuthenticatedOrigin(workspace, platform, user, token, async () => {
    const pushRef = await resolvePushRef(workspace);
    await runGit(["push", "origin", `HEAD:${pushRef}`], workspace);
  });
  core.info("Pushed Codex changes.");
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

async function withAuthenticatedOrigin(
  workspace: string,
  platform: Platform,
  user: ActionUser,
  token: string,
  callback: () => Promise<void>,
): Promise<void> {
  const { stdout } = await runGit(["remote", "get-url", "origin"], workspace);
  const originalUrl = stdout.trim();
  const authenticatedUrl = buildAuthenticatedRemoteUrl(originalUrl, platform, user, token);

  if (!authenticatedUrl) {
    await callback();
    return;
  }

  core.setSecret(authenticatedUrl);
  await runGit(["remote", "set-url", "origin", authenticatedUrl], workspace);

  try {
    await callback();
  } finally {
    await runGit(["remote", "set-url", "origin", originalUrl], workspace);
  }
}

async function runGit(args: string[], workspace: string): Promise<exec.ExecOutput> {
  return exec.getExecOutput("git", args, { cwd: workspace, silent: true });
}

function buildAuthenticatedRemoteUrl(
  remoteUrl: string,
  platform: Platform,
  user: ActionUser,
  token: string,
): string | null {
  let url: URL;

  try {
    url = new URL(remoteUrl);
  } catch {
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
