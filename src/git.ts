import * as core from "@actions/core";
import * as github from "@actions/github";

import { runCapturedProcess } from "./process.ts";
import type { ActionUser, Platform, PullRequestPayload } from "./types.ts";

export async function configureGitUser(workspace: string, user: ActionUser): Promise<void> {
  await runCapturedProcess("git", ["config", "user.name", user.login], { cwd: workspace });
  await runCapturedProcess("git", ["config", "user.email", user.email], { cwd: workspace });
  core.info(`Configured git user as ${user.login} <${user.email}>.`);
}

export async function hasGitChanges(workspace: string): Promise<boolean> {
  const { stdout } = await runCapturedProcess("git", ["status", "--porcelain"], { cwd: workspace });
  return stdout.trim().length > 0;
}

export async function commitChanges(workspace: string, commitMessage: string): Promise<void> {
  const message = commitMessage || "Update with Codex";

  await runCapturedProcess("git", ["add", "-A"], { cwd: workspace });
  await runCapturedProcess("git", ["commit", "-m", message], { cwd: workspace });
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
    await runCapturedProcess("git", ["push", "origin", `HEAD:${pushRef}`], { cwd: workspace });
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

  const { stdout } = await runCapturedProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspace,
  });
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
  const { stdout } = await runCapturedProcess("git", ["remote", "get-url", "origin"], {
    cwd: workspace,
  });
  const originalUrl = stdout.trim();
  const authenticatedUrl = buildAuthenticatedRemoteUrl(originalUrl, platform, user, token);

  if (!authenticatedUrl) {
    await callback();
    return;
  }

  core.setSecret(authenticatedUrl);
  await runCapturedProcess("git", ["remote", "set-url", "origin", authenticatedUrl], {
    cwd: workspace,
  });

  try {
    await callback();
  } finally {
    await runCapturedProcess("git", ["remote", "set-url", "origin", originalUrl], {
      cwd: workspace,
    });
  }
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
