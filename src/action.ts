import * as core from "@actions/core";
import { createClient } from "@redis/client";

import { resolveCodexExecutable } from "./codex-binary.ts";
import { createCodexHome, ensureCodexAuth, persistCodexAuth, runCodexPrompt } from "./codex.ts";
import { commitAndPushChanges, configureGitUser, hasGitChanges } from "./git.ts";
import { readInputs, resolvePromptInput } from "./inputs.ts";
import {
  detectPlatform,
  getActionUser,
  isPullRequestEvent,
  postPullRequestComment,
  setPullRequestAutomerge,
} from "./platform.ts";
import { errorMessage } from "./utils.ts";

export async function run(): Promise<void> {
  const inputs = readInputs();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const platform = detectPlatform();
  const codexHome = createCodexHome();
  const codexExecutable = await resolveCodexExecutable();
  const redis = createClient({ url: inputs.redis });

  redis.on("error", (error) => {
    core.warning(`Redis client error: ${errorMessage(error)}`);
  });

  await redis.connect();

  try {
    await ensureCodexAuth(redis, inputs.secret, codexHome, codexExecutable, workspace);

    const user = await getActionUser(platform, inputs.token);
    await configureGitUser(workspace, user);

    const prompt = resolvePromptInput(inputs.prompt, workspace);
    const metadata = await runCodexPrompt(codexExecutable, codexHome, workspace, prompt);

    if (await hasGitChanges(workspace)) {
      await commitAndPushChanges(workspace, platform, user, inputs.token, metadata.commitMessage);
    } else {
      core.info("Codex did not leave repository changes to commit.");
    }

    if (isPullRequestEvent() && metadata.prComment.trim()) {
      await postPullRequestComment(platform, inputs.token, metadata.prComment.trim());
    }

    if (isPullRequestEvent() && inputs.automerge !== undefined) {
      await setPullRequestAutomerge(platform, inputs.token, inputs.automerge);
    }
  } finally {
    await persistCodexAuth(redis, inputs.secret, codexHome);
    await redis.quit();
  }
}
