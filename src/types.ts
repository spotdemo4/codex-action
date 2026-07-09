export type Platform = "github" | "gitea" | "forgejo";

export type ActionInputs = {
  auth: string;
  authSecret: string;
  prompt: string;
  token: string;
  automerge: boolean | undefined;
};

export type ActionUser = {
  login: string;
  id: number | string;
  email: string;
};

export type CodexRunMetadata = {
  commitMessage: string;
  prComment: string;
};

export type PullRequestPayload = {
  number?: number;
  pull_request?: {
    number?: number;
    node_id?: string;
    head?: {
      ref?: string;
      repo?: {
        full_name?: string;
      };
    };
  };
};

export type GiteaUserResponse = {
  id?: number;
  login?: string;
  username?: string;
  name?: string;
  email?: string;
  full_name?: string;
};
