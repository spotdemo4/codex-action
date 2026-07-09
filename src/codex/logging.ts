import * as core from "@actions/core";
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

export function logCodexText(title: string, text: string): void {
  core.startGroup(title);
  core.info(text);
  core.endGroup();
}

type CodexStreamState = {
  finalResponse: string;
  textByItemId: Map<string, string>;
  commandOutputByItemId: Map<string, string>;
  todoSummaryByItemId: Map<string, string>;
};

type CodexItemPhase = "started" | "updated" | "completed";

type CodexItem<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

const ANSI_RESET = "\x1b[0m";

const CODEX_LOG_LABEL_COLORS: Record<string, string> = {
  thread: "\x1b[2m",
  turn: "\x1b[2m",
  message: "\x1b[97m",
  reasoning: "\x1b[2m",
  command: "\x1b[34m",
  "command-output": "\x1b[2m",
  file: "\x1b[35m",
  tool: "\x1b[36m",
  web: "\x1b[36m",
  todo: "\x1b[33m",
  error: "\x1b[31m",
};

export async function logCodexStream(events: AsyncGenerator<ThreadEvent>): Promise<string> {
  const state: CodexStreamState = {
    finalResponse: "",
    textByItemId: new Map(),
    commandOutputByItemId: new Map(),
    todoSummaryByItemId: new Map(),
  };

  for await (const event of events) {
    switch (event.type) {
      case "thread.started":
        logCodexLine("thread", `started ${event.thread_id}`);
        break;
      case "turn.started":
        logCodexLine("turn", "started");
        break;
      case "turn.completed":
        logCodexLine("turn", `completed; ${formatCodexUsage(event.usage)}`);
        break;
      case "turn.failed":
        logCodexLine("error", `turn failed: ${event.error.message}`);
        throw new Error(event.error.message);
      case "error":
        logCodexLine("error", event.message);
        throw new Error(event.message);
      case "item.started":
        logCodexItem("started", event.item, state);
        break;
      case "item.updated":
        logCodexItem("updated", event.item, state);
        break;
      case "item.completed":
        if (event.item.type === "agent_message") {
          state.finalResponse = event.item.text;
        }

        logCodexItem("completed", event.item, state);
        break;
    }
  }

  return state.finalResponse;
}

function logCodexItem(phase: CodexItemPhase, item: ThreadItem, state: CodexStreamState): void {
  switch (item.type) {
    case "agent_message":
      logCodexTextDelta("message", item.id, item.text, state.textByItemId);
      break;
    case "reasoning":
      logCodexTextDelta("reasoning", item.id, item.text, state.textByItemId);
      break;
    case "command_execution":
      logCodexCommandItem(phase, item, state);
      break;
    case "file_change":
      logCodexFileChangeItem(item);
      break;
    case "mcp_tool_call":
      logCodexMcpToolCallItem(phase, item);
      break;
    case "web_search":
      logCodexLine("web", `${phase}: ${item.query}`);
      break;
    case "todo_list":
      logCodexTodoListItem(phase, item, state);
      break;
    case "error":
      logCodexLine("error", `${phase}: ${item.message}`);
      break;
  }
}

function logCodexCommandItem(
  phase: CodexItemPhase,
  item: CodexItem<"command_execution">,
  state: CodexStreamState,
): void {
  if (phase === "started") {
    logCodexLine("command", `started: ${item.command}`);
  } else if (phase === "completed") {
    const exitSuffix = item.exit_code === undefined ? "" : ` exit ${item.exit_code}`;
    logCodexLine("command", `${item.status}${exitSuffix}: ${item.command}`);
  }

  const outputDelta = getTrackedTextDelta(
    state.commandOutputByItemId,
    item.id,
    item.aggregated_output,
  );

  if (outputDelta.trim()) {
    logCodexBlock("command-output", outputDelta);
  }
}

function logCodexFileChangeItem(item: CodexItem<"file_change">): void {
  const changes = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
  const suffix = changes ? `: ${changes}` : "";
  logCodexLine("file", `${item.status}${suffix}`);
}

function logCodexMcpToolCallItem(phase: CodexItemPhase, item: CodexItem<"mcp_tool_call">): void {
  const status = phase === "started" ? "started" : item.status;
  const errorSuffix = item.error ? `: ${item.error.message}` : "";
  logCodexLine("tool", `${status}: ${item.server}/${item.tool}${errorSuffix}`);
}

function logCodexTodoListItem(
  phase: CodexItemPhase,
  item: CodexItem<"todo_list">,
  state: CodexStreamState,
): void {
  const summary = `${phase}: ${formatCodexTodoList(item)}`;

  if (state.todoSummaryByItemId.get(item.id) === summary) {
    return;
  }

  state.todoSummaryByItemId.set(item.id, summary);
  logCodexLine("todo", summary);
}

function formatCodexTodoList(item: CodexItem<"todo_list">): string {
  const completed = item.items.filter((todo) => todo.completed).length;
  const pending = item.items.length - completed;
  const preview = item.items
    .slice(0, 5)
    .map((todo) => `${todo.completed ? "x" : " "} ${formatInlineLogText(todo.text)}`)
    .join("; ");
  const more = item.items.length > 5 ? "; ..." : "";
  const previewSuffix = preview ? ` (${preview}${more})` : "";

  return `${completed} completed, ${pending} pending${previewSuffix}`;
}

function formatCodexUsage(usage: Usage): string {
  return [
    `${usage.input_tokens} input`,
    `${usage.cached_input_tokens} cached input`,
    `${usage.output_tokens} output`,
    `${usage.reasoning_output_tokens} reasoning output`,
  ].join(", ");
}

function logCodexTextDelta(
  label: string,
  id: string,
  text: string,
  previousByItemId: Map<string, string>,
): void {
  const delta = getTrackedTextDelta(previousByItemId, id, text);

  if (delta.trim()) {
    logCodexBlock(label, delta);
  }
}

function getTrackedTextDelta(
  previousByItemId: Map<string, string>,
  id: string,
  text: string,
): string {
  const previous = previousByItemId.get(id) ?? "";
  previousByItemId.set(id, text);

  if (!text) {
    return "";
  }

  return text.startsWith(previous) ? text.slice(previous.length) : text;
}

function logCodexLine(label: string, text: string): void {
  logCodexBlock(label, text);
}

function logCodexBlock(label: string, text: string): void {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  const prefix = formatCodexLogPrefix(label);

  if (!normalized.trim()) {
    return;
  }

  for (const line of normalized.split("\n")) {
    core.info(`${prefix} ${line}`);
  }
}

function formatCodexLogPrefix(label: string): string {
  const prefix = `[codex:${label}]`;
  const color = CODEX_LOG_LABEL_COLORS[label];

  if (!color || !codexLogColorsEnabled()) {
    return prefix;
  }

  return `${color}${prefix}${ANSI_RESET}`;
}

function codexLogColorsEnabled(): boolean {
  return process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0";
}

function formatInlineLogText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();

  if (singleLine.length <= 120) {
    return singleLine;
  }

  return `${singleLine.slice(0, 117)}...`;
}
