import * as core from "@actions/core";

import { resolveCodexExecutable } from "./codex-binary.ts";
import { createCodexHome, ensureCodexAuth, persistCodexAuth, runCodexPrompt } from "./codex.ts";
import { commitAndPushChanges, configureGitUser, hasGitChanges } from "./git.ts";
import { readInputs, resolvePromptInput } from "./inputs.ts";
import { createPlatformClient, isPullRequestEvent } from "./platform.ts";

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

    const prompt = resolvePromptInput(inputs.prompt, workspace);
    const metadata = await runCodexPrompt(
      codexExecutable,
      codexHome,
      workspace,
      prompt,
      inputs.model,
    );

    if (await hasGitChanges(workspace)) {
      await commitAndPushChanges(
        workspace,
        platformClient.type,
        user,
        platformClient.token,
        metadata.commitMessage,
      );
    } else {
      core.info("Codex did not leave repository changes to commit.");
    }

    if (isPullRequestEvent() && metadata.prComment.trim()) {
      await platformClient.postPullRequestComment(metadata.prComment.trim());
    }

    if (isPullRequestEvent() && inputs.automerge !== undefined) {
      await platformClient.setPullRequestAutomerge(inputs.automerge);
    }
  } finally {
    currentAuth = (await persistCodexAuth(codexHome, currentAuth, updateAuthSecret)) ?? currentAuth;
  }
}
