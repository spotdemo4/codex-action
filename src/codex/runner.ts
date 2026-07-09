import { Codex } from "@openai/codex-sdk";

import type { CodexRunMetadata } from "../types.ts";
import { createCodexEnv, getAdditionalWritableDirectories } from "./env.ts";
import { logCodexStream, logCodexText } from "./logging.ts";
import { buildPrompt, CODEX_OUTPUT_SCHEMA, parseCodexMetadata } from "./prompt.ts";

export async function runCodexPrompt(
  codexExecutable: string,
  codexHome: string,
  workspace: string,
  prompt: string,
  model: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<CodexRunMetadata> {
  const codex = new Codex({
    codexPathOverride: codexExecutable,
    env: createCodexEnv(codexHome, extraEnv),
  });
  const thread = codex.startThread({
    workingDirectory: workspace,
    model,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    additionalDirectories: getAdditionalWritableDirectories(workspace),
  });
  const codexPrompt = buildPrompt(prompt);

  logCodexText("Codex prompt", codexPrompt);
  const { events } = await thread.runStreamed(codexPrompt, {
    outputSchema: CODEX_OUTPUT_SCHEMA,
  });
  const turn = await logCodexStream(events);

  return parseCodexMetadata(turn.finalResponse);
}
