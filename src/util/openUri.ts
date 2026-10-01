import { run, CommandError } from "./exec.js";
import { uriOpener, platform } from "./platform.js";
import { UserFacingError } from "./errors.js";
import { log } from "./log.js";

/**
 * Hand a URI to the OS. `app` names what should pick it up, for the error.
 * This succeeds once the OS takes the URI, whether or not the app acts on it.
 */
export async function openUri(uri: string, app: string, hint: string): Promise<void> {
  const opener = uriOpener();
  if (!opener) {
    throw new UserFacingError(
      `sidequest does not know how to open URIs on ${platform()}.`,
      `Open this by hand: ${uri}`,
    );
  }

  try {
    await run(opener.command, [...opener.args, uri], { timeoutMs: 15_000 });
    log.info(`opened ${uri}`);
  } catch (err) {
    const detail = err instanceof CommandError ? err.stderr.trim() || err.message : String(err);
    throw new UserFacingError(`Could not hand ${uri} to ${app}: ${detail}`, hint);
  }
}
