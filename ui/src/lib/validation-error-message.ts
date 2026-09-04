import { ApiError } from "../api/client";

/**
 * Turn an API error into a message that names the field that actually failed.
 *
 * The server already says which field it rejected: `validate()` lets the
 * `ZodError` reach the error handler, which answers 400 with
 * `{ error: "Validation error", details: [ZodIssue, ...] }`. `ApiError` keeps
 * that body, but `error.message` is only the top-level string — so a caller that
 * renders `err.message` alone shows the same bare "Validation error" whatever
 * went wrong, and the one useful part of the response is never seen.
 *
 * That is not a hypothetical. A duplicate-agent failure was diagnosed by reading
 * schema source rather than the error, because the toast could not say more than
 * "Validation error"; the field was in `details` the whole time.
 *
 * Returns the message unchanged when there are no issues to add, so this is safe
 * to wrap around any error.
 */
export function apiErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  const base = error.message || fallback;
  const issues = readZodIssues(error.body);
  if (!issues.length) return base;

  // One issue is the common case and reads best inline. Several are summarised
  // rather than listed, because a toast is not the place for a long list and the
  // first path is nearly always the one that matters.
  const [first, ...rest] = issues;
  const suffix = rest.length ? ` (and ${rest.length} more)` : "";
  return `${base}: ${first}${suffix}`;
}

/** `["runtimeConfig.modelProfiles — is no longer supported", ...]` */
function readZodIssues(body: unknown): string[] {
  const details = asRecord(body)?.details;
  if (!Array.isArray(details)) return [];

  const described: string[] = [];
  for (const entry of details) {
    const issue = asRecord(entry);
    if (!issue) continue;
    const path = Array.isArray(issue.path)
      ? issue.path.filter((segment) => typeof segment === "string" || typeof segment === "number").join(".")
      : "";
    const message = typeof issue.message === "string" ? issue.message : "";
    // A path with no message still localises the failure, which is the whole
    // point; a message with no path is better than nothing.
    const described_ = path && message ? `${path} — ${message}` : path || message;
    if (described_) described.push(described_);
  }
  return described;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
