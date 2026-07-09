import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createCodexHome(): string {
  const base = process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const codexHome = mkdtempSync(path.join(base, "codex-action-"));
  chmodSync(codexHome, 0o700);
  return codexHome;
}
