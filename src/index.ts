import * as core from "@actions/core";

import { run } from "./action.ts";

try {
  await run();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
