import { ArchiveError } from "./errors";
import type { ArchiveConfig, AssetPolicy } from "./types";

// Discord lets the bot edit the /상담완료 reply for 15 minutes from the command. Out of that go the
// 30-second confirmation prompt and a margin for collecting the channel; every attempt of the POST
// and of the GET, with the wait before each retry, must fit in the rest.
const REPLY_WINDOW_MS = 15 * 60 * 1000;
const CONFIRMATION_MS = 30_000;
const COLLECTION_MARGIN_MS = 90_000;
const WORST_CASE_BUDGET_MS =
  REPLY_WINDOW_MS - CONFIRMATION_MS - COLLECTION_MARGIN_MS;
// ArchiveClient caps a Retry-After wait at this (kept here to avoid an import cycle).
const MAX_RETRY_WAIT_MS = 30_000;

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new ArchiveError(
      "config",
      `${name} 값이 올바르지 않습니다 (${minimum} 이상의 정수).`,
    );
  return value;
}

function list(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string[] {
  // An empty value means "use the default", so `||` (not `??`) is intended.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return (env[name] || fallback)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function loadArchiveConfig(
  env: NodeJS.ProcessEnv = process.env,
): ArchiveConfig {
  const token = env.INTEL_ARCHIVE_TOKEN;
  if (!token)
    throw new ArchiveError(
      "config",
      "INTEL_ARCHIVE_TOKEN 또는 INTEL_ARCHIVE_TOKEN_FILE 설정이 필요합니다.",
    );
  // An empty value means "use the default", so `||` (not `??`) is intended.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const rawUrl = env.INTEL_ARCHIVE_URL || "http://127.0.0.1:8000";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ArchiveError(
      "config",
      "INTEL_ARCHIVE_URL 값이 올바른 주소가 아닙니다.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ArchiveError(
      "config",
      "INTEL_ARCHIVE_URL은 계정·쿼리 없는 http(s) 주소여야 합니다.",
    );
  // The server downloads every attachment from Discord inside the POST, so the POST gets a long timeout.
  const postTimeoutMs = integer(
    env,
    "INTEL_ARCHIVE_TIMEOUT_MS",
    180_000,
    1_000,
  );
  const getTimeoutMs = integer(
    env,
    "INTEL_ARCHIVE_GET_TIMEOUT_MS",
    30_000,
    1_000,
  );
  const maxRetries = integer(env, "INTEL_ARCHIVE_RETRIES", 2, 0);
  const retryDelayMs = integer(env, "INTEL_ARCHIVE_RETRY_DELAY_MS", 2_000, 0);
  // Matches the archive's ARCHIVE_MAX_REQUEST_BYTES default; a larger body would only get 413.
  const maxRequestBytes = integer(
    env,
    "INTEL_ARCHIVE_MAX_REQUEST_BYTES",
    16 * 1024 * 1024,
    1,
  );
  const attempts = maxRetries + 1;
  let waits = 0;
  for (let retry = 0; retry < maxRetries; retry++)
    waits += Math.max(retryDelayMs * 2 ** retry, MAX_RETRY_WAIT_MS);
  // Worst case: every POST attempt, then either every GET attempt and one by-channel read
  // (GET transport failure), or one by-channel read and one GET (POST 409). Recovery reads are single attempts.
  const worstCase =
    attempts * postTimeoutMs +
    attempts * getTimeoutMs +
    getTimeoutMs +
    2 * waits;
  if (worstCase > WORST_CASE_BUDGET_MS)
    throw new ArchiveError(
      "config",
      "보관 시간 제한과 재시도 횟수의 합이 Discord 응답 가능 시간(15분)을 넘습니다.",
    );
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    token,
    postTimeoutMs,
    getTimeoutMs,
    maxRetries,
    retryDelayMs,
    maxRequestBytes,
  };
}

// Mirrors the archive's ARCHIVE_ATTACHMENT_HOSTS, ARCHIVE_ALLOWED_MIME_TYPES and
// ARCHIVE_MAX_ATTACHMENT_BYTES defaults. Keep them equal to the server's values: the bot uses
// them to stop before submitting something the server would refuse.
export function loadAssetPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AssetPolicy {
  return {
    hosts: list(
      env,
      "INTEL_ARCHIVE_ATTACHMENT_HOSTS",
      "cdn.discordapp.com,media.discordapp.net",
    ),
    mimeTypes: list(
      env,
      "INTEL_ARCHIVE_ALLOWED_MIME_TYPES",
      "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain",
    ),
    maxAttachmentBytes: integer(
      env,
      "INTEL_ARCHIVE_MAX_ATTACHMENT_BYTES",
      25 * 1024 * 1024,
      1,
    ),
  };
}
