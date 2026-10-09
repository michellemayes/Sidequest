import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HeadlessInvocation } from "../agents/agents.js";
import { PROMPT_TOKEN } from "../agents/agents.js";
import { FOLLOWUP_FILE, FOLLOWUP_MARKER, FOLLOWUP_SENTINEL, SESSION_DIR, shellArg, shellQuote } from "../warp/autorun.js";

export interface HeadlessFiles {
  /** The runner script, the headless counterpart of autorun.sh. */
  scriptFile: string;
  /** Everything the agent printed, plus when it started and how it ended. */
  logFile: string;
  /** The agent's final answer; only there once it finished cleanly. */
  resultFile: string;
  /** What the agent did, as JSON lines, for agents with an event stream. */
  eventsFile: string;
  /** The runner's pid while a run is going, so it can be stopped. */
  pidFile: string;
  /** The MCP server the agent asks for approval, when approvals are on. */
  mcpConfigFile: string;
}

/**
 * `result.md` is where another part of Sidequest looks for the answer to post
 * back to Slack, so the name is a contract, not a detail.
 */
export function headlessPaths(worktreePath: string): HeadlessFiles {
  const dir = join(worktreePath, SESSION_DIR);
  return {
    scriptFile: join(dir, "headless.sh"),
    logFile: join(dir, "agent.log"),
    resultFile: join(dir, "result.md"),
    eventsFile: join(dir, "events.jsonl"),
    pidFile: join(dir, "run.pid"),
    mcpConfigFile: join(dir, "mcp.json"),
  };
}

/** The tool a headless Claude Code asks before anything acceptEdits does not already allow. */
export const APPROVAL_TOOL = "mcp__sidequest__approve";

export interface WriteHeadlessOptions {
  worktreePath: string;
  agentCommand: string;
  /** The user's own agent args; they go after the headless flags. */
  agentArgs: string[];
  headless: HeadlessInvocation;
  agentLabel?: string;
  /** The node that writes the event stream's markers and reads its answer. */
  node?: string;
  /**
   * The approval server to hand an agent that can ask (headless.approvals):
   * a command the agent starts over stdio. Absent leaves the agent to its limits.
   */
  approvals?: { command: string; args: string[] };
}

/** Appends a run's start (with its prompt) or end to the event stream. Run as `node -e`. */
const MARK_JS = `const [what, a, b] = process.argv.slice(1);
const at = new Date().toISOString();
const line = what === "start"
  ? { type: "sidequest", event: "run-start", mode: a || "first", at, prompt: require("fs").readFileSync(b, "utf8").slice(0, 20000) }
  : { type: "sidequest", event: "run-end", status: Number(a), at };
process.stdout.write(JSON.stringify(line) + "\\n");`;

/** Prints the last run's answer: its final result event's text. */
const ANSWER_JS = `let out = "";
for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\\n")) {
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  if (e.type === "sidequest" && e.event === "run-start") out = "";
  else if (e.type === "result" && typeof e.result === "string") out = e.result;
}
process.stdout.write(out);`;

/**
 * Write the runner that starts the agent with no terminal. It expects
 * writeAutorun to have put the prompt and pending marker in place, and claims
 * the marker the same way autorun.sh does, so a session only ever runs once.
 */
export async function writeHeadlessRunner(options: WriteHeadlessOptions): Promise<HeadlessFiles> {
  const paths = headlessPaths(options.worktreePath);
  if (options.approvals && options.headless.approvals) {
    const server = { command: options.approvals.command, args: options.approvals.args };
    await writeFile(paths.mcpConfigFile, `${JSON.stringify({ mcpServers: { sidequest: server } }, null, 2)}\n`, "utf8");
  }
  await writeFile(paths.scriptFile, renderHeadlessScript(options), "utf8");
  await chmod(paths.scriptFile, 0o755);
  return paths;
}

export function renderHeadlessScript(options: WriteHeadlessOptions): string {
  const { headless } = options;
  const paths = headlessPaths(options.worktreePath);
  const events = headless.events;
  const approvals = options.approvals && headless.approvals
    ? ["--mcp-config", paths.mcpConfigFile, "--permission-prompt-tool", APPROVAL_TOOL]
    : [];
  // The prompt goes in the way the headless mode takes it (a trailing
  // argument unless promptArgs says otherwise), read from its file at run time.
  const commandWith = (extra: string[]) => [
    ...[options.agentCommand, ...headless.args, ...extra, ...(events?.args ?? []), ...approvals, ...options.agentArgs].map(shellQuote),
    ...(headless.promptArgs ?? [PROMPT_TOKEN]).map(shellArg),
  ].join(" ");
  const command = commandWith([]);
  // A follow-up carries on the last run's conversation where the agent can.
  const followUpCommand = commandWith(headless.continueArgs ?? []);
  const agentLine = options.agentLabel ? `# Agent: ${options.agentLabel}\n` : "";

  // stdin is /dev/null: nobody is there to answer a question, and an agent
  // that waits for one would hang forever instead of failing. The prompt asks
  // the agent for a reply in result.md; when it wrote one, that beats its
  // whole stdout answer, so stdout only fills in for an agent that didn't.
  // With an event stream, stdout is the stream, and the answer is its last
  // result event.
  const runLine = (cmd: string) =>
    events
      ? `"$node" -e "$mark" start "$mode" "$prompt_file" >>"$events" 2>>"$log"
  ${cmd} </dev/null 2>>"$log" >>"$events"
  status=$?
  "$node" -e "$mark" end "$status" >>"$events" 2>>"$log"`
      : headless.result === "stdout"
        ? `${cmd} </dev/null 2>>"$log" | tee "$partial" >>"$log"
  status=\${PIPESTATUS[0]}`
        : `${cmd} </dev/null >>"$log" 2>&1
  status=$?`;
  const keepStdout = headless.result !== "stdout"
    ? ""
    : events
      ? `\nif [ "$status" -eq 0 ] && [ ! -s "$result" ]; then "$node" -e "$answer" "$events" >"$partial" 2>>"$log"; fi
if [ -s "$partial" ] && [ ! -s "$result" ]; then mv "$partial" "$result"; else rm -f "$partial"; fi`
      : `\nif [ "$status" -eq 0 ] && [ ! -s "$result" ]; then mv "$partial" "$result"; else rm -f "$partial"; fi`;
  const eventVars = events
    ? `\nevents="$session_dir/events.jsonl"
node=${shellQuote(options.node ?? "node")}
mark=${shellQuote(MARK_JS)}
answer=${shellQuote(ANSWER_JS)}`
    : "";

  return `#!/usr/bin/env bash
# Generated by sidequest. Runs the agent with no terminal; safe to delete.
${agentLine}set -uo pipefail

session_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
worktree="$(dirname "$session_dir")"
pending="$session_dir/pending"
started="$session_dir/started"
log="$session_dir/agent.log"
result="$session_dir/result.md"
partial="$session_dir/result.md.partial"
pidfile="$session_dir/run.pid"${eventVars}

# Claim the run, exactly as autorun.sh does, so it never starts twice.
if ! mv "$pending" "$started" 2>/dev/null; then
  exit 0
fi

# While it runs, its pid says so, and lets the Mac app stop it.
echo $$ >"$pidfile"
trap 'rm -f "$pidfile"' EXIT

cd "$worktree" || exit 1

${FOLLOWUP_SENTINEL}
mode=""
prompt_file="$session_dir/prompt.md"
if [ "$(cat "$started")" = ${shellQuote(FOLLOWUP_MARKER)} ]; then
  mode=followup
  prompt_file="$session_dir/${FOLLOWUP_FILE}"
fi

if [ ! -f "$prompt_file" ]; then
  echo "Sidequest: $(basename "$prompt_file") is missing from $session_dir" >>"$log"
  exit 1
fi

rm -f "$result" "$partial"
echo "sidequest: started $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
if [ "$mode" = followup ]; then
  ${runLine(followUpCommand)}
else
  ${runLine(command)}
fi${keepStdout}
echo "sidequest: finished $(date -u +%Y-%m-%dT%H:%M:%SZ), exit $status" >>"$log"
exit "$status"
`;
}

/**
 * Start the runner detached from the daemon, so restarting or stopping
 * Sidequest doesn't take a half-finished session down with it. Resolves once
 * the process exists; the run itself is reported in its log.
 */
export function spawnHeadless(scriptFile: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptFile, [], { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
