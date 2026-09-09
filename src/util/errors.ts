/**
 * An error whose message is safe and useful to show back to the user in Slack.
 * Anything else is logged locally and reported as a generic failure.
 */
export class UserFacingError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserFacingError";
    this.hint = hint;
  }
}

export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof UserFacingError) {
    return err.hint ? { message: err.message, hint: err.hint } : { message: err.message };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
