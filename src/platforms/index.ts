import type { Platform, PlatformClient, PlatformMcp } from "../types.ts";
import { ForgejoPlatformClient, forgejoMcp } from "./forgejo.ts";
import { GiteaPlatformClient, giteaMcp } from "./gitea.ts";
import {
  createGitHubAppInstallationAuthentication,
  GitHubPlatformClient,
  githubMcp,
} from "./github.ts";

type PlatformClientOptions = {
  token: string | undefined;
  githubAppClientId: string | undefined;
  githubAppPrivateKey: string | undefined;
};

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

  if (platform === "gitea") {
    return new GiteaPlatformClient(options.token);
  }

  return new ForgejoPlatformClient(options.token);
}

export function getPlatformMcp(platform: Platform): PlatformMcp {
  if (platform === "github") {
    return githubMcp;
  }

  if (platform === "gitea") {
    return giteaMcp;
  }

  return forgejoMcp;
}

export { isPullRequestEvent } from "./context.ts";
export { ForgejoPlatformClient } from "./forgejo.ts";
export { GiteaPlatformClient } from "./gitea.ts";
export {
  buildGitHubNoreplyEmail,
  createGitHubAppJwt,
  getGitHubActionsBotUser,
  getGitHubAppBotLogin,
  GITHUB_APP_INSTALLATION_PERMISSIONS,
  GitHubPlatformClient,
  isGitHubAppInstallationUserError,
  normalizePrivateKey,
} from "./github.ts";
