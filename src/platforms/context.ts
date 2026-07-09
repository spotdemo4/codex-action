import * as github from "@actions/github";

import type { PullRequestPayload } from "../types.ts";

export function getPullRequestNumber(): number {
  const payload = github.context.payload as PullRequestPayload;
  const issueNumber = payload.pull_request?.number ?? payload.number ?? github.context.issue.number;

  if (!issueNumber) {
    throw new Error("This action is not running for a pull request event");
  }

  return issueNumber;
}

export function getServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || github.context.serverUrl;
}

export function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}
