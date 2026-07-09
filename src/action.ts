import * as core from "@actions/core";

import { ensureCodexAuth, persistCodexAuth } from "./codex/auth.ts";
import { resolveCodexExecutable } from "./codex/binary.ts";
import { createCodexHome } from "./codex/home.ts";
import { runCodexPrompt } from "./codex/runner.ts";
import { commitChanges, configureGitUser, hasGitChanges, pushChanges } from "./git.ts";
import { readInputs, resolvePromptInput } from "./inputs.ts";
import { setupCodexMcp } from "./mcp.ts";
import { createPlatformClient, isPullRequestEvent } from "./platforms/index.ts";

export async function run(): Promise<void> {
  const inputs = readInputs();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const platformClient = await createPlatformClient({
    token: inputs.token,
    githubAppClientId: inputs.githubAppClientId,
    githubAppPrivateKey: inputs.githubAppPrivateKey,
  });
  const codexHome = createCodexHome();
  const codexExecutable = await resolveCodexExecutable();
  const updateAuthSecret = (value: string) =>
    platformClient.updateRepositoryAuthSecret(inputs.authSecret, value);
  let currentAuth = inputs.auth;

  try {
    currentAuth =
      (await ensureCodexAuth(
        inputs.auth,
        codexHome,
        codexExecutable,
        workspace,
        updateAuthSecret,
      )) ?? currentAuth;

    const user = await platformClient.getActionUser();
    await configureGitUser(workspace, user);
    const codexEnv = await setupCodexMcp(codexHome, platformClient);

    const prompt = resolvePromptInput(inputs.prompt, workspace);
    const metadata = await runCodexPrompt(
      codexExecutable,
      codexHome,
      workspace,
      prompt,
      inputs.model,
      codexEnv,
    );

    const pullRequestEvent = isPullRequestEvent();
    const prComment = metadata.prComment.trim();

    if (await hasGitChanges(workspace)) {
      await commitChanges(workspace, metadata.commitMessage);

      if (inputs.dryRun) {
        core.info("Dry run enabled; skipping push of Codex changes");
      } else {
        await pushChanges(workspace, platformClient.type, user, platformClient.token);
      }
    } else {
      core.info("Codex did not leave repository changes to commit");
    }

    if (pullRequestEvent && prComment) {
      if (inputs.dryRun) {
        core.info("Dry run enabled; skipping Codex pull request comment");
      } else {
        await platformClient.postPullRequestComment(prComment);
      }
    }

    if (pullRequestEvent && inputs.automerge !== undefined) {
      if (inputs.dryRun) {
        core.info("Dry run enabled; skipping pull request automerge update");
      } else {
        await platformClient.setPullRequestAutomerge(inputs.automerge);
      }
    }
  } finally {
    await persistCodexAuth(codexHome, currentAuth, updateAuthSecret);
  }
}
