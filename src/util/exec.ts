import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stderr: string;
  readonly stdout: string;
  readonly code: number | null;

  constructor(
    command: string,
    args: string[],
    code: number | null,
    stdout: string,
    stderr: string,
  ) {
    super(`\`${command} ${args.join(" ")}\` failed${code === null ? "" : ` (exit ${code})`}: ${stderr.trim() || stdout.trim()}`);
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Run a command without a shell. Arguments are passed as an array so that
 * repo paths, branch names and prompt text can never be interpreted as shell
 * syntax.
 */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 60_000,
      env: options.env ?? process.env,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (e.code === "ENOENT") {
      throw new CommandError(command, args, null, "", `${command} is not installed or not on PATH`);
    }
    const code = typeof e.code === "number" ? e.code : null;
    throw new CommandError(command, args, code, e.stdout ?? "", e.stderr ?? e.message ?? "");
  }
}

/** Run a command and return whether it exited zero, swallowing failures. */
export async function succeeds(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<boolean> {
  try {
    await run(command, args, options);
    return true;
  } catch {
    return false;
  }
}
