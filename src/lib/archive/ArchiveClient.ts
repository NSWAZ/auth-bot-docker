import { createHash } from "node:crypto";
import { ArchiveError, displaySafe } from "./errors";
import type {
  ArchiveConfig,
  ArchiveResponse,
  AssetVerification,
  AttachmentVerification,
  ConsultationPayload,
  Counts,
} from "./types";

export { loadArchiveConfig } from "./config";

/** One key per (guild, channel, cutoff message): every retry of the same consultation reuses it. 64 chars, under the server's 200. */
export function idempotencyKey(payload: ConsultationPayload): string {
  return createHash("sha256")
    .update(
      `consultation:v${payload.schema_version}:${payload.discord_guild_id}:${payload.discord_channel_id}:${payload.cutoff_message_id}`,
    )
    .digest("hex");
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
  maximumMs = 60_000,
): number {
  if (!value) return 0;
  const numeric = Number(value);
  const delay = Number.isFinite(numeric)
    ? numeric * 1000
    : Date.parse(value) - now;
  return Math.max(0, Math.min(Number.isFinite(delay) ? delay : 0, maximumMs));
}

// ---- Response normalization -------------------------------------------------------------
// The server answers with response_model_exclude_defaults=True (intel-archive main.py), so a
// field equal to its default is left out. These are the defaults from its schemas.py.

const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
function schemaError(field: string): never {
  throw new ArchiveError(
    "schema",
    `보관소 응답 형식이 계약과 다릅니다 (${field}).`,
  );
}

function counts(value: unknown, field: string): Counts {
  if (
    !isObject(value) ||
    !isInt(value.participants) ||
    !isInt(value.messages) ||
    !isInt(value.attachments) ||
    (value.assets !== undefined && !isInt(value.assets))
  )
    schemaError(field);
  return {
    participants: value.participants,
    messages: value.messages,
    attachments: value.attachments,
    assets: value.assets ?? 0,
  };
}

function attachment(value: unknown): AttachmentVerification {
  if (
    !isObject(value) ||
    typeof value.discord_attachment_id !== "string" ||
    typeof value.sha256 !== "string" ||
    !isInt(value.actual_size) ||
    typeof value.verified !== "boolean"
  )
    schemaError("attachments");
  return {
    discord_attachment_id: value.discord_attachment_id,
    sha256: value.sha256,
    actual_size: value.actual_size,
    verified: value.verified,
  };
}

function asset(value: unknown): AssetVerification {
  if (
    !isObject(value) ||
    typeof value.asset_id !== "string" ||
    typeof value.kind !== "string" ||
    (value.source_discord_id !== null &&
      value.source_discord_id !== undefined &&
      typeof value.source_discord_id !== "string") ||
    typeof value.filename !== "string" ||
    typeof value.content_type !== "string" ||
    !isInt(value.declared_size) ||
    typeof value.sha256 !== "string" ||
    !isInt(value.actual_size) ||
    !isObject(value.owner_reference) ||
    typeof value.verified !== "boolean"
  )
    schemaError("assets");
  return {
    asset_id: value.asset_id,
    kind: value.kind as AssetVerification["kind"],
    source_discord_id: value.source_discord_id ?? null,
    filename: value.filename,
    content_type: value.content_type,
    declared_size: value.declared_size,
    sha256: value.sha256,
    actual_size: value.actual_size,
    owner_reference: value.owner_reference,
    verified: value.verified,
  };
}

export function normalizeResponse(value: unknown): ArchiveResponse {
  if (!isObject(value)) schemaError("root");
  for (const field of [
    "archive_id",
    "discord_guild_id",
    "discord_channel_id",
    "cutoff_message_id",
    "manifest_digest",
  ])
    if (typeof value[field] !== "string") schemaError(field);
  if (value.status !== "verified" && value.status !== "failed")
    schemaError("status");
  if (value.schema_version !== undefined && !isInt(value.schema_version))
    schemaError("schema_version");
  if (
    !Array.isArray(value.sorted_message_ids) ||
    !value.sorted_message_ids.every((id: unknown) => typeof id === "string")
  )
    schemaError("sorted_message_ids");
  if (!Array.isArray(value.attachments)) schemaError("attachments");
  if (value.assets !== undefined && !Array.isArray(value.assets))
    schemaError("assets");
  if (value.discord_snapshot !== undefined && !isObject(value.discord_snapshot))
    schemaError("discord_snapshot");
  if (
    value.failure_reason !== undefined &&
    value.failure_reason !== null &&
    typeof value.failure_reason !== "string"
  )
    schemaError("failure_reason");
  const v = value.verification;
  if (!isObject(v)) schemaError("verification");
  for (const flag of [
    "complete",
    "ordering_verified",
    "attachments_verified",
    "manifest_verified",
  ])
    if (typeof v[flag] !== "boolean") schemaError(`verification.${flag}`);
  if (v.assets_verified !== undefined && typeof v.assets_verified !== "boolean")
    schemaError("verification.assets_verified");
  return {
    archive_id: value.archive_id,
    schema_version: value.schema_version ?? 1,
    status: value.status,
    discord_guild_id: value.discord_guild_id,
    discord_channel_id: value.discord_channel_id,
    cutoff_message_id: value.cutoff_message_id,
    sorted_message_ids: [...value.sorted_message_ids],
    attachments: value.attachments.map(attachment),
    assets: (value.assets ?? []).map(asset),
    discord_snapshot: value.discord_snapshot ?? {},
    verification: {
      complete: v.complete,
      submitted: counts(v.submitted, "verification.submitted"),
      stored: counts(v.stored, "verification.stored"),
      ordering_verified: v.ordering_verified,
      attachments_verified: v.attachments_verified,
      assets_verified: v.assets_verified ?? true,
      manifest_verified: v.manifest_verified,
    },
    manifest_digest: value.manifest_digest,
    failure_reason: value.failure_reason ?? null,
    idempotent_replay: value.idempotent_replay === true,
  };
}

// ---- HTTP -------------------------------------------------------------------------------

// intel-archive service.py raises these when the archive may already be committed; the same
// key then returns the stored archive (or resolves the race against a request still running).
const RETRY_SAME_KEY = /retry with the same Idempotency-Key/i;
// Keep equal to MAX_RETRY_WAIT_MS in config.ts, which budgets for it.
const MAX_RETRY_AFTER_MS = 30_000;

type Attempt =
  | { ok: true; value: ArchiveResponse }
  | { ok: false; error: ArchiveError; waitMs?: number };

async function readDetail(response: Response): Promise<unknown> {
  try {
    return (await response.json())?.detail;
  } catch {
    return undefined;
  }
}

function describeValidation(detail: unknown[]): string {
  return displaySafe(
    detail
      .slice(0, 8)
      .map(
        (item: any) =>
          `${Array.isArray(item?.loc) ? item.loc.join(".") : "field"}:${String(item?.type ?? "invalid")}`,
      )
      .join(", "),
  );
}

export class ArchiveClient {
  constructor(
    private readonly config: ArchiveConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async submit(payload: ConsultationPayload): Promise<ArchiveResponse> {
    // Serialized once: every retry sends the same bytes under the same key, as the server requires.
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > this.config.maxRequestBytes)
      throw new ArchiveError(
        "too_large",
        `상담 기록이 ${(bytes / 1024 / 1024).toFixed(1)}MB로 보관 요청 한도(${(this.config.maxRequestBytes / 1024 / 1024).toFixed(0)}MB)를 넘어 보내지 않았습니다.`,
      );
    return this.send(
      "/api/v1/consultations",
      "POST",
      this.config.postTimeoutMs,
      body,
      {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey(payload),
      },
    );
  }

  /** `attempts` overrides the configured retries; the recovery path reads once so the whole flow stays inside Discord's reply window (config.ts). */
  async get(archiveId: string, attempts?: number): Promise<ArchiveResponse> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(archiveId))
      throw new ArchiveError(
        "schema",
        "보관소가 올바르지 않은 보관 ID를 돌려주었습니다.",
      );
    return this.send(
      `/api/v1/consultations/${archiveId}`,
      "GET",
      this.config.getTimeoutMs,
      undefined,
      {},
      attempts,
    );
  }

  /** The channel's verified archive (at most one per channel); 404 when there is none. Read once, like the recovery GET. */
  async getByChannel(
    guildId: string,
    channelId: string,
  ): Promise<ArchiveResponse> {
    if (!/^\d{1,20}$/.test(guildId) || !/^\d{1,20}$/.test(channelId))
      throw new ArchiveError(
        "invalid_request",
        "길드·채널 ID 형식이 올바르지 않습니다.",
      );
    const query = new URLSearchParams({
      guild_id: guildId,
      channel_id: channelId,
    }).toString();
    return this.send(
      `/api/v1/consultations/by-channel?${query}`,
      "GET",
      this.config.getTimeoutMs,
      undefined,
      {},
      1,
    );
  }

  private async send(
    path: string,
    method: "GET" | "POST",
    timeoutMs: number,
    body?: string,
    headers: Record<string, string> = {},
    maxAttempts?: number,
  ): Promise<ArchiveResponse> {
    const attempts = maxAttempts ?? this.config.maxRetries + 1;
    let last: ArchiveError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.once(path, method, timeoutMs, body, headers);
      if (result.ok) return result.value;
      last = result.error;
      if (attempt < attempts)
        await this.sleep(
          result.waitMs ?? this.config.retryDelayMs * 2 ** (attempt - 1),
        );
    }
    throw new ArchiveError(
      last!.kind,
      attempts > 1 ? `${last!.message} (${attempts}회 시도)` : last!.message,
    );
  }

  private async once(
    path: string,
    method: "GET" | "POST",
    timeoutMs: number,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = (): Attempt => ({
      ok: false,
      error: new ArchiveError(
        "timeout",
        `보관소 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다.`,
      ),
    });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
          method,
          body,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            Accept: "application/json",
            ...headers,
          },
        });
      } catch {
        return controller.signal.aborted
          ? timedOut()
          : {
              ok: false,
              error: new ArchiveError(
                "network",
                "보관소에 연결하지 못했습니다.",
              ),
            };
      }
      if (response.ok) {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          return controller.signal.aborted
            ? timedOut()
            : {
                ok: false,
                error: new ArchiveError(
                  "schema",
                  "보관소 응답이 JSON이 아닙니다.",
                ),
              };
        }
        return { ok: true, value: normalizeResponse(data) };
      }
      const status = response.status;
      const detail = await readDetail(response);
      if (status === 429)
        return {
          ok: false,
          error: new ArchiveError(
            "rate_limited",
            "보관소 요청 한도에 걸렸습니다 (429).",
          ),
          waitMs: parseRetryAfter(
            response.headers.get("retry-after"),
            Date.now(),
            MAX_RETRY_AFTER_MS,
          ),
        };
      if (status >= 500)
        return {
          ok: false,
          error: new ArchiveError(
            "server",
            `보관소 서버 오류입니다 (${status}).`,
          ),
        };
      if (
        status === 422 &&
        isObject(detail) &&
        typeof detail.failure_reason === "string"
      ) {
        const reason = displaySafe(detail.failure_reason);
        const error = new ArchiveError(
          "rejected",
          `보관소가 보관을 거부했습니다: ${reason}`,
        );
        if (RETRY_SAME_KEY.test(detail.failure_reason))
          return { ok: false, error };
        throw error;
      }
      if (status === 422 && Array.isArray(detail))
        throw new ArchiveError(
          "invalid_request",
          `보관 요청 형식이 보관소 계약과 맞지 않습니다 (422): ${describeValidation(detail)}`,
        );
      const text =
        typeof detail === "string" ? `: ${displaySafe(detail, 160)}` : "";
      // service.py _resolve_race: another request with this key was still being stored. Same key, same bytes: ask again.
      if (
        status === 409 &&
        typeof detail === "string" &&
        detail.startsWith("concurrent archive")
      )
        return {
          ok: false,
          error: new ArchiveError(
            "conflict_pending",
            `보관소가 같은 상담을 아직 처리 중이었습니다 (409)${text}`,
          ),
        };
      // Any other 409: this channel already has an archive. The workflow reads it back by channel (ArchiveWorkflow.ts).
      if (status === 409)
        throw new ArchiveError(
          "conflict",
          `이 채널은 이미 보관되어 있습니다 (409)${text}`,
        );
      if (status === 401 || status === 403)
        throw new ArchiveError(
          "auth",
          `보관소 인증에 실패했습니다 (${status}).`,
        );
      if (status === 413)
        throw new ArchiveError(
          "too_large",
          "보관 요청이 보관소 한도보다 너무 큽니다 (413).",
        );
      if (status === 404)
        throw new ArchiveError(
          "not_found",
          "검증된 보관본을 찾지 못했습니다 (404).",
        );
      if (status === 400 || status === 422)
        throw new ArchiveError(
          "invalid_request",
          `보관 요청이 거부되었습니다 (${status})${text}`,
        );
      throw new ArchiveError(
        "http",
        `보관소가 예상하지 못한 응답을 보냈습니다 (${status}).`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
