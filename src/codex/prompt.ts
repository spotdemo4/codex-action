import { isPullRequestEvent } from "../platforms/index.ts";
import type { CodexRunMetadata } from "../types.ts";

export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    commit_message: {
      type: "string",
      description:
        "Concise imperative git commit message, or an empty string when no changes were made.",
    },
    pr_comment: {
      type: "string",
      description:
        "Pull request comment body, or an empty string when no comment should be posted.",
    },
  },
  required: ["commit_message", "pr_comment"],
  additionalProperties: false,
} as const;

export function buildPrompt(prompt: string): string {
  const prInstructions = isPullRequestEvent()
    ? "If a pull request comment would be useful, set pr_comment to concise Markdown. Otherwise set it to an empty string."
    : "This event is not a pull request. Set pr_comment to an empty string.";

  return `${prompt.trim()}

Codex action instructions:
- Make any requested repository changes directly in the working tree.
- Do not commit, push, or post comments yourself; this action handles that after you finish.
- When finished, return structured output matching the provided JSON schema.
- If you made repository changes, set commit_message to a concise imperative commit message. If not, set it to an empty string.
- ${prInstructions}
- Platform MCP tools are available for read-only repository, pull request, issue, and workflow context. Use them when helpful, but do not create, update, merge, comment, or otherwise write through MCP.`;
}

export function parseCodexMetadata(response: string): CodexRunMetadata {
  const parsed = JSON.parse(response) as {
    commit_message?: unknown;
    pr_comment?: unknown;
  };

  return {
    commitMessage: typeof parsed.commit_message === "string" ? parsed.commit_message.trim() : "",
    prComment: typeof parsed.pr_comment === "string" ? parsed.pr_comment.trim() : "",
  };
}
