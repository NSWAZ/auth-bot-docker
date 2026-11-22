import type { ChatInputCommandInteraction, TextChannel } from "discord.js";
import type { ArchiveClient } from "./ArchiveClient";
import type { collectConsultation } from "./ConsultationCollector";
import { ArchiveError, MutationError, displaySafe } from "./errors";
import type {
  ArchiveAsset,
  ArchiveResponse,
  ConsultationPayload,
  Counts,
} from "./types";

// What the bot checks, and what it deliberately leaves to the server:
//
// The bot does NOT re-derive the server's canonical discord_snapshot or manifest_digest. That
// canonical form applies the server's own redaction rules and value formatting, which change
// with server revisions; re-deriving it here only produces false failures.
//
// It trusts verification.manifest_verified because the server computes it from the database,
// not from the request: intel-archive service.py response_for() rebuilds the manifest with
// manifest_from_database() from the stored rows and compares its digest with the digest of
// the submitted payload (payload_hash). The server also refuses to commit unless that check,
// the counts, the ordering and every file hash pass on its own read-back (archive_consultation).
//
// What the bot checks itself is everything it can know from its own payload: identity, counts,
// message order, attachment and asset identity/size, hash format, every completeness flag; and
// that the POST answer and the independent GET answer describe the same stored archive.

const HEX64 = /^[a-f0-9]{64}$/;
function fail(message: string): never {
  throw new ArchiveError("verification", `보관 검증 실패: ${message}`);
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean =>
  stableJson(a) === stableJson(b);
const canonicalMime = (value: string): string =>
  value
    .split(";", 1)[0]
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/");
/** Server-side asset identity (service.py _asset_identity): Discord ID, else the URL without query/fragment. */
function assetIdentity(
  asset: Pick<ArchiveAsset, "kind" | "source_discord_id" | "source_url">,
): string {
  if (asset.source_discord_id)
    return `${asset.kind}:id:${asset.source_discord_id}`;
  try {
    const url = new URL(asset.source_url);
    url.search = "";
    url.hash = "";
    return `${asset.kind}:url:${url.toString()}`;
  } catch {
    return `${asset.kind}:url:${asset.source_url.split(/[?#]/, 1)[0]}`;
  }
}

interface Expected {
  counts: Counts;
  order: string[];
  attachmentSizes: Map<string, number>;
  assets: ArchiveAsset[];
}

function expectationsFor(payload: ConsultationPayload): Expected {
  const messages = payload.messages as any[];
  const attachmentSizes = new Map<string, number>();
  for (const message of messages)
    for (const item of message.attachments ?? [])
      attachmentSizes.set(item.discord_attachment_id, item.size);
  // The server keeps the last asset of each identity (a dict assignment in service.py).
  const assets = new Map<string, ArchiveAsset>();
  for (const item of payload.assets) assets.set(assetIdentity(item), item);
  // Server order (service.py): created_at, then sequence, then message ID.
  const order = [...messages]
    .sort(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        a.sequence - b.sequence ||
        (a.discord_message_id < b.discord_message_id
          ? -1
          : a.discord_message_id > b.discord_message_id
            ? 1
            : 0),
    )
    .map((m) => m.discord_message_id);
  const attachments = messages.reduce(
    (n, message) => n + (message.attachments?.length ?? 0),
    0,
  );
  return {
    counts: {
      participants: payload.participants.length,
      messages: messages.length,
      attachments,
      assets: assets.size,
    },
    order,
    attachmentSizes,
    assets: [...assets.values()],
  };
}

/** Checks one response (POST or GET) against the submitted payload. */
export function verifyResponse(
  payload: ConsultationPayload,
  response: ArchiveResponse,
  label: "POST" | "GET",
  expected = expectationsFor(payload),
): void {
  const v = response.verification;
  if (
    response.status !== "verified" ||
    !v.complete ||
    !v.ordering_verified ||
    !v.attachments_verified ||
    !v.assets_verified ||
    !v.manifest_verified
  ) {
    const reason = response.failure_reason
      ? ` (${displaySafe(response.failure_reason, 160)})`
      : "";
    fail(`${label} 응답이 검증 완료 상태가 아닙니다${reason}.`);
  }
  if (
    response.schema_version !== payload.schema_version ||
    response.discord_guild_id !== payload.discord_guild_id ||
    response.discord_channel_id !== payload.discord_channel_id ||
    response.cutoff_message_id !== payload.cutoff_message_id
  )
    fail(`${label} 응답의 상담 식별자가 보낸 내용과 다릅니다.`);
  if (!HEX64.test(response.manifest_digest))
    fail(`${label} 응답의 manifest digest 형식이 올바르지 않습니다.`);
  if (Object.keys(response.discord_snapshot).length === 0)
    fail(`${label} 응답에 보관된 상담 내용이 없습니다.`);
  if (!same(response.sorted_message_ids, expected.order))
    fail(`${label} 응답의 메시지 순서가 보낸 내용과 다릅니다.`);
  if (!same(v.submitted, expected.counts) || !same(v.stored, expected.counts))
    fail(`${label} 응답의 저장 개수가 보낸 내용과 다릅니다.`);

  const seenAttachments = new Set<string>();
  for (const item of response.attachments) {
    const declared = expected.attachmentSizes.get(item.discord_attachment_id);
    if (
      declared === undefined ||
      seenAttachments.has(item.discord_attachment_id) ||
      !item.verified ||
      !HEX64.test(item.sha256) ||
      item.actual_size !== declared
    )
      fail(`${label} 응답의 첨부 파일 검증 결과가 보낸 내용과 다릅니다.`);
    seenAttachments.add(item.discord_attachment_id);
  }
  if (seenAttachments.size !== expected.attachmentSizes.size)
    fail(`${label} 응답에 빠진 첨부 파일이 있습니다.`);

  // Each stored asset must match exactly one submitted asset, and every submitted asset must be stored.
  const unmatched = [...expected.assets];
  for (const item of response.assets) {
    const index = unmatched.findIndex(
      (asset) =>
        asset.kind === item.kind &&
        (asset.source_discord_id ?? null) === item.source_discord_id &&
        asset.filename === item.filename &&
        canonicalMime(asset.content_type) === item.content_type &&
        asset.size === item.declared_size &&
        same(asset.owner_reference, item.owner_reference),
    );
    if (
      index < 0 ||
      !item.verified ||
      item.actual_size !== item.declared_size ||
      !HEX64.test(item.sha256)
    )
      fail(`${label} 응답의 미디어 자산 검증 결과가 보낸 내용과 다릅니다.`);
    unmatched.splice(index, 1);
  }
  if (unmatched.length) fail(`${label} 응답에 빠진 미디어 자산이 있습니다.`);
}

/** Two reads of the stored archive must describe the very same archive. */
function assertSameArchive(
  a: ArchiveResponse,
  b: ArchiveResponse,
  labels: string,
): void {
  if (a.archive_id !== b.archive_id) fail(`${labels}의 보관 ID가 다릅니다.`);
  if (a.manifest_digest !== b.manifest_digest)
    fail(`${labels}의 manifest digest가 다릅니다.`);
  if (a.cutoff_message_id !== b.cutoff_message_id)
    fail(`${labels}의 기준 메시지가 다릅니다.`);
  if (!same(a.sorted_message_ids, b.sorted_message_ids))
    fail(`${labels}의 메시지 순서가 다릅니다.`);
  if (!same(a.attachments, b.attachments))
    fail(`${labels}의 첨부 파일 검증 결과가 다릅니다.`);
  if (!same(a.assets, b.assets))
    fail(`${labels}의 미디어 자산 검증 결과가 다릅니다.`);
  if (!same(a.discord_snapshot, b.discord_snapshot))
    fail(`${labels}의 보관 내용이 다릅니다.`);
}

export function verifyArchive(
  payload: ConsultationPayload,
  posted: ArchiveResponse,
  readBack: ArchiveResponse,
  readLabel = "GET",
): void {
  const expected = expectationsFor(payload);
  verifyResponse(payload, posted, "POST", expected);
  verifyResponse(payload, readBack, readLabel as "GET", expected);
  // The GET is an independent read of the stored archive: it must describe the very same archive.
  assertSameArchive(posted, readBack, `POST와 ${readLabel}`);
}

/**
 * Checks an archive stored by an earlier /상담완료 run against the channel as collected now.
 * Its cutoff is older than the current one (each run's confirmation message moves the cutoff),
 * so only messages up to its cutoff are compared: every one of them still in the channel must
 * be in the archive, in the archive's order, with the same attachment sizes. Messages deleted
 * since are allowed (they are in the archive); messages written after its cutoff are not in the
 * archive and are counted for the recruiter before deletion (DiscordHandler). Assets (avatars,
 * emoji) can change after archiving, so they are checked for the archive's own integrity only.
 */
export function verifyExistingArchive(
  payload: ConsultationPayload,
  response: ArchiveResponse,
  label: string,
): void {
  const v = response.verification;
  if (
    response.status !== "verified" ||
    !v.complete ||
    !v.ordering_verified ||
    !v.attachments_verified ||
    !v.assets_verified ||
    !v.manifest_verified
  ) {
    const reason = response.failure_reason
      ? ` (${displaySafe(response.failure_reason, 160)})`
      : "";
    fail(`${label} 응답이 검증 완료 상태가 아닙니다${reason}.`);
  }
  if (
    response.schema_version !== payload.schema_version ||
    response.discord_guild_id !== payload.discord_guild_id ||
    response.discord_channel_id !== payload.discord_channel_id
  )
    fail(`${label} 응답의 상담 식별자가 이 채널과 다릅니다.`);
  if (
    !/^\d{1,20}$/.test(response.cutoff_message_id) ||
    BigInt(response.cutoff_message_id) > BigInt(payload.cutoff_message_id)
  )
    fail(`${label} 응답의 기준 메시지가 현재 채널보다 나중입니다.`);
  if (!HEX64.test(response.manifest_digest))
    fail(`${label} 응답의 manifest digest 형식이 올바르지 않습니다.`);
  if (Object.keys(response.discord_snapshot).length === 0)
    fail(`${label} 응답에 보관된 상담 내용이 없습니다.`);
  if (!same(v.submitted, v.stored))
    fail(`${label} 응답의 제출 개수와 저장 개수가 다릅니다.`);
  const archivedIds = response.sorted_message_ids;
  if (
    new Set(archivedIds).size !== archivedIds.length ||
    archivedIds.length !== v.stored.messages ||
    !archivedIds.includes(response.cutoff_message_id)
  )
    fail(`${label} 응답의 메시지 목록이 저장 개수와 맞지 않습니다.`);
  if (
    response.attachments.length !== v.stored.attachments ||
    response.assets.length !== v.stored.assets
  )
    fail(`${label} 응답의 첨부·자산 목록이 저장 개수와 맞지 않습니다.`);

  const cutoff = BigInt(response.cutoff_message_id);
  const covered = (payload.messages as any[]).filter(
    (message) => BigInt(message.discord_message_id) <= cutoff,
  );
  const coveredIds = new Set(
    covered.map((message) => message.discord_message_id as string),
  );
  const archivedSet = new Set(archivedIds);
  for (const id of coveredIds)
    if (!archivedSet.has(id))
      fail(`${label} 응답의 보관본에 현재 채널의 메시지가 빠져 있습니다.`);
  const currentOrder = expectationsFor(payload).order.filter((id) =>
    coveredIds.has(id),
  );
  if (
    !same(
      archivedIds.filter((id) => coveredIds.has(id)),
      currentOrder,
    )
  )
    fail(`${label} 응답의 메시지 순서가 현재 채널과 다릅니다.`);

  const archivedAttachments = new Map<string, number>();
  for (const item of response.attachments) {
    if (
      archivedAttachments.has(item.discord_attachment_id) ||
      !item.verified ||
      !HEX64.test(item.sha256)
    )
      fail(`${label} 응답의 첨부 파일 검증 결과가 올바르지 않습니다.`);
    archivedAttachments.set(item.discord_attachment_id, item.actual_size);
  }
  for (const message of covered)
    for (const item of message.attachments ?? [])
      if (archivedAttachments.get(item.discord_attachment_id) !== item.size)
        fail(`${label} 응답의 첨부 파일이 현재 채널과 다릅니다.`);
  for (const item of response.assets)
    if (
      !item.verified ||
      item.actual_size !== item.declared_size ||
      !HEX64.test(item.sha256)
    )
      fail(`${label} 응답의 미디어 자산 검증 결과가 올바르지 않습니다.`);
}

export interface ArchiveDependencies {
  collect: typeof collectConsultation;
  client: Pick<ArchiveClient, "submit" | "get" | "getByChannel">;
}

function asArchiveError(
  error: unknown,
  kind: "collection" | "http",
): ArchiveError {
  if (error instanceof ArchiveError) return error;
  const message =
    error instanceof Error ? displaySafe(error.message) : "알 수 없는 오류";
  return new ArchiveError(kind, message, { cause: error });
}

// GET failures that say nothing about the archive itself; the by-channel read may still find it.
const TRANSPORT_KINDS = new Set([
  "timeout",
  "network",
  "server",
  "rate_limited",
  "http",
]);

async function readByChannel(
  payload: ConsultationPayload,
  dependencies: ArchiveDependencies,
  onNotFound: () => ArchiveError,
): Promise<ArchiveResponse> {
  try {
    return await dependencies.client.getByChannel(
      payload.discord_guild_id,
      payload.discord_channel_id,
    );
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "not_found")
      throw onNotFound();
    throw asArchiveError(error, "http");
  }
}

/** POST 409: the channel already has an archive from an earlier run. Read it by channel, re-read it by ID, and check both. */
async function recoverExistingArchive(
  payload: ConsultationPayload,
  dependencies: ArchiveDependencies,
  conflict: ArchiveError,
): Promise<ArchiveResponse> {
  const existing = await readByChannel(
    payload,
    dependencies,
    () =>
      new ArchiveError(
        "conflict",
        `${conflict.message} 그런데 이 채널의 검증된 보관본을 찾지 못했습니다(404). 보관소 상태를 확인해 주세요.`,
      ),
  );
  verifyExistingArchive(payload, existing, "기존 보관본(by-channel)");
  let readBack: ArchiveResponse;
  try {
    readBack = await dependencies.client.get(existing.archive_id, 1);
  } catch (error) {
    throw asArchiveError(error, "http");
  }
  verifyExistingArchive(payload, readBack, "기존 보관본(GET)");
  assertSameArchive(existing, readBack, "by-channel과 GET");
  return readBack;
}

/** Collects, submits, reads back and verifies. Throws ArchiveError on anything short of a verified archive. */
export async function archiveAndVerify(
  interaction: ChatInputCommandInteraction,
  channel: TextChannel,
  dependencies: ArchiveDependencies,
): Promise<ArchiveResponse> {
  let payload: ConsultationPayload;
  try {
    payload = await dependencies.collect(interaction, channel);
  } catch (error) {
    throw asArchiveError(error, "collection");
  }
  let posted: ArchiveResponse;
  try {
    posted = await dependencies.client.submit(payload);
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "conflict")
      return recoverExistingArchive(payload, dependencies, error);
    throw asArchiveError(error, "http");
  }
  // Check the POST answer first: a failed archive has no verified GET, and its own reason is clearer than a 404.
  verifyResponse(payload, posted, "POST");
  let readBack: ArchiveResponse;
  try {
    readBack = await dependencies.client.get(posted.archive_id);
  } catch (error) {
    const failure = asArchiveError(error, "http");
    if (!TRANSPORT_KINDS.has(failure.kind)) throw failure;
    // The GET could not be read; the by-channel read is the other independent read of the same archive.
    const byChannel = await readByChannel(payload, dependencies, () => failure);
    verifyArchive(payload, posted, byChannel, "by-channel");
    return byChannel;
  }
  verifyArchive(payload, posted, readBack);
  return readBack;
}

/** Fail-closed: `mutate` (delete or move the channel) runs only after a verified archive, and receives it. */
export async function archiveVerifyThenMutate(
  interaction: ChatInputCommandInteraction,
  channel: TextChannel,
  dependencies: ArchiveDependencies,
  mutate: (verified: ArchiveResponse) => Promise<void>,
): Promise<ArchiveResponse> {
  const verified = await archiveAndVerify(interaction, channel, dependencies);
  try {
    await mutate(verified);
  } catch (error) {
    throw new MutationError(
      error instanceof Error ? error.message : "채널 정리에 실패했습니다.",
      { cause: error },
    );
  }
  return verified;
}
