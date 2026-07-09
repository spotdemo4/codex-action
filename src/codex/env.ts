import { realpathSync } from "node:fs";

export function getAdditionalWritableDirectories(workspace: string): string[] {
  const directories = [workspace];

  try {
    const realWorkspace = realpathSync(workspace);
    directories.push(realWorkspace);
  } catch {
    // Keep the original workspace path when realpath resolution is unavailable.
  }

  return [...new Set(directories)];
}

export function createCodexEnv(
  codexHome: string,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.CODEX_HOME = codexHome;
  env.NO_COLOR = "1";
  env.npm_config_loglevel = "error";
  Object.assign(env, extraEnv);
  return env;
}
