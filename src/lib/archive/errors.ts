// Archive failures (nothing in Discord was changed) are kept apart from mutation failures
// (the archive is verified but renaming/moving the channel failed), so the handler can tell
// the recruiter which of the two happened without matching on message text.
export type ArchiveErrorKind =
  | "config"
  | "collection"
  | "unsupported_attachment"
  | "preflight"
  | "too_large"
  | "timeout"
  | "network"
  | "rate_limited"
  | "server"
  | "auth"
  | "conflict"
  | "conflict_pending"
  | "rejected"
  | "invalid_request"
  | "not_found"
  | "http"
  | "schema"
  | "verification";

export class ArchiveError extends Error {
  constructor(
    readonly kind: ArchiveErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ArchiveError";
    if (options && "cause" in options)
      (this as { cause?: unknown }).cause = options.cause;
  }
}

export class MutationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MutationError";
    if (options && "cause" in options)
      (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Text from the server or Discord, made safe to show: no URLs (signed CDN links), no control characters, bounded. */
export function displaySafe(text: string, maximum = 300): string {
  return (
    text
      .replace(/https?:\/\/\S+/gi, "[URL]")
      // Control characters are what this strips.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximum)
  );
}
