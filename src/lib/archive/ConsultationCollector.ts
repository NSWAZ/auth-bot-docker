import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from "discord.js";
import { loadAssetPolicy } from "./config";
import { ArchiveError, displaySafe } from "./errors";
import type {
  ArchiveAsset,
  AssetPolicy,
  ConsultationPayload,
  OmissionReason,
  OmittedAsset,
  RecruitmentType,
} from "./types";

const HEAD_TIMEOUT_MS = 10_000;
const HEAD_CONCURRENCY = 8;
/**
 * A mentioned channel as stored in the archive. discord.js resolves <#id> against every guild the
 * bot is in, so only the consultation guild's channels keep their name; others are an ID only.
 */
export const scopedChannelReference = (
  mentioned: { id: string; name?: string; guildId?: string | null },
  consultationGuildId: string,
): { id: string; name?: string } =>
  mentioned.guildId === consultationGuildId && mentioned.name
    ? { id: mentioned.id, name: mentioned.name }
    : { id: mentioned.id };

/**
 * discord.js toJSON() includes cleanContent, which spells out the names of mentioned channels
 * (from any guild the bot can see). The raw content is stored separately, so drop it.
 */
const withoutResolvedMentions = (raw: any): any => {
  if (raw && typeof raw === "object" && "cleanContent" in raw) {
    const copy = { ...raw };
    delete copy.cleanContent;
    return copy;
  }
  return raw;
};

const json = (value: any): any =>
  value?.toJSON ? value.toJSON() : (value ?? null);
const values = (collection: any): any[] =>
  collection ? Array.from(collection.values?.() ?? collection) : [];
/** Query and fragment removed: the form used for identity and for owner references, never for downloading. */
const safeUrl = (value: string): string => {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
};
const filenameFor = (url: string, fallback: string): string => {
  try {
    return decodeURIComponent(
      // A path ending in "/" gives "", which must fall back too.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      new URL(url).pathname.split("/").pop() || fallback,
    ).slice(0, 255);
  } catch {
    return fallback;
  }
};
const mimeFor = (
  value: string | null | undefined,
  filename: string,
): string => {
  const mime = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mime) return mime;
  const ext = filename.toLowerCase().split(".").pop();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        txt: "text/plain",
        json: "application/json",
      } as Record<string, string>
    )[ext ?? ""] ?? "application/octet-stream"
  );
};
const mebibytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** The archive downloads only from these hosts over HTTPS (intel-archive storage.py). */
function allowedHost(
  value: string | undefined | null,
  policy: AssetPolicy,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const schemeOk =
      url.protocol === "https:" ||
      (policy.allowInsecureHttp === true && url.protocol === "http:");
    return (
      schemeOk &&
      !url.username &&
      !url.password &&
      url.port === "" &&
      policy.hosts.includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export async function fetchAllMessages(
  channel: TextChannel,
): Promise<{ messages: Message[]; cutoff: Message }> {
  let page: any;
  try {
    page = await channel.messages.fetch({ limit: 100 });
  } catch {
    throw new Error("Discord message history could not be read.");
  }
  if (!page?.size)
    throw new Error("The consultation has no archivable text messages.");
  const cutoff = page.first() as Message;
  const found = new Map<string, Message>();
  let current = page;
  while (current.size) {
    for (const message of current.values())
      if (BigInt(message.id) <= BigInt(cutoff.id))
        found.set(message.id, message);
    if (current.size < 100) break;
    const oldest = current.last();
    if (!oldest)
      throw new Error("Discord pagination did not provide an oldest message.");
    try {
      current = await channel.messages.fetch({ limit: 100, before: oldest.id });
    } catch {
      throw new Error(
        "Discord message pagination failed; archive was not submitted.",
      );
    }
  }
  const messages = [...found.values()].sort(
    (a, b) =>
      a.createdTimestamp - b.createdTimestamp ||
      (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
  );
  if (messages[messages.length - 1]?.id !== cutoff.id)
    throw new Error("Discord cutoff completeness check failed.");
  return { messages, cutoff };
}

/**
 * Message attachments are the consultation record itself, so one the archive would refuse stops
 * the whole archive here, before anything is sent, with a reason the recruiter can act on.
 */
export function assertArchivableAttachments(
  messages: Pick<Message, "id" | "attachments">[],
  policy: AssetPolicy,
): void {
  for (const message of messages as any[]) {
    for (const attachment of values(message.attachments)) {
      const name = displaySafe(String(attachment.name ?? attachment.id), 80);
      const type = mimeFor(
        attachment.contentType,
        String(attachment.name ?? ""),
      );
      if (!allowedHost(attachment.url, policy))
        throw new ArchiveError(
          "unsupported_attachment",
          `첨부 파일 ${name}의 주소가 보관소가 받는 Discord 주소가 아닙니다.`,
        );
      if (!policy.mimeTypes.includes(type))
        throw new ArchiveError(
          "unsupported_attachment",
          `첨부 파일 ${name}의 형식(${displaySafe(type, 80)})은 보관소가 받지 않습니다. 허용 형식: ${policy.mimeTypes.join(", ")}`,
        );
      if (
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > policy.maxAttachmentBytes
      )
        throw new ArchiveError(
          "unsupported_attachment",
          `첨부 파일 ${name}의 크기(${mebibytes(Number(attachment.size) || 0)})가 보관 한도(${mebibytes(policy.maxAttachmentBytes)})를 넘습니다.`,
        );
    }
  }
}

type Candidate = Omit<ArchiveAsset, "size" | "content_type" | "filename"> & {
  filename?: string;
};

/** Optional media: sized with a HEAD to an allowed host (no redirects). Anything unusable is omitted, never fatal. */
async function resolveOptional(
  candidate: Candidate,
  fetchImpl: typeof fetch,
  policy: AssetPolicy,
  omitted: OmittedAsset[],
): Promise<ArchiveAsset | null> {
  const omit = (reason: OmissionReason): null => {
    omitted.push({
      kind: candidate.kind,
      source_discord_id: candidate.source_discord_id ?? null,
      reason,
    });
    return null;
  };
  if (!allowedHost(candidate.source_url, policy))
    return omit("host_not_allowed");
  const filename =
    candidate.filename ??
    filenameFor(
      candidate.source_url,
      `${candidate.kind}-${candidate.source_discord_id ?? "media"}`,
    );
  // One retry for a transient failure (network, timeout, 429, 5xx), so a brief CDN hiccup does not drop media.
  const head = async (): Promise<Response | null> => {
    try {
      return await fetchImpl(candidate.source_url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  };
  const transient = (r: Response | null) =>
    r === null || r.status === 429 || r.status >= 500;
  let response = await head();
  if (transient(response)) response = await head();
  if (response === null || response.status < 200 || response.status >= 300)
    return omit("metadata_unavailable");
  const lengthHeader = response.headers.get("content-length");
  const size = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isSafeInteger(size) || size < 0)
    return omit("metadata_unavailable");
  const contentType = mimeFor(response.headers.get("content-type"), filename);
  if (!policy.mimeTypes.includes(contentType)) return omit("mime_not_allowed");
  if (size > policy.maxAttachmentBytes) return omit("too_large");
  return { ...candidate, filename, content_type: contentType, size };
}

export async function collectDownloadableAssets(
  messages: Message[],
  fetchImpl: typeof fetch = fetch,
  policy: AssetPolicy = loadAssetPolicy(),
  omitted: OmittedAsset[] = [],
): Promise<ArchiveAsset[]> {
  const required: ArchiveAsset[] = [];
  const optional: Candidate[] = [];
  const omitNow = (
    kind: OmittedAsset["kind"],
    source_discord_id: string | null,
    reason: OmissionReason,
  ) => omitted.push({ kind, source_discord_id, reason });
  const participants = new Map<string, any>();
  for (const message of messages as any[])
    participants.set(message.author.id, message.author);
  for (const author of participants.values()) {
    const url =
      typeof author.displayAvatarURL === "function"
        ? author.displayAvatarURL({ extension: "png", size: 4096 })
        : author.avatarURL?.();
    if (url)
      optional.push({
        kind: "avatar",
        source_discord_id: author.id,
        source_url: url,
        owner_reference: { participant_id: author.id },
      });
  }
  for (const message of messages as any[]) {
    // Signed URL kept as is (?ex=&is=&hm=): the archive downloads the file from it.
    for (const attachment of values(message.attachments))
      required.push({
        kind: "attachment",
        source_discord_id: attachment.id,
        source_url: attachment.url,
        filename: attachment.name,
        content_type: mimeFor(attachment.contentType, attachment.name ?? ""),
        size: attachment.size,
        owner_reference: {
          message_id: message.id,
          attachment_id: attachment.id,
        },
      });
    for (const reaction of values(message.reactions?.cache)) {
      const emoji = reaction.emoji;
      if (emoji?.id && emoji.url)
        optional.push({
          kind: "emoji",
          source_discord_id: emoji.id,
          source_url: emoji.url,
          owner_reference: { message_id: message.id },
        });
    }
    for (const sticker of values(message.stickers))
      if (sticker?.url)
        optional.push({
          kind: "sticker",
          source_discord_id: sticker.id ?? null,
          source_url: sticker.url,
          filename: sticker.name ? `${sticker.name}.png` : undefined,
          owner_reference: { message_id: message.id },
        });
    for (const [embedIndex, embed] of (message.embeds ?? []).entries()) {
      const data: any = json(embed) ?? {};
      const parts: [string, any, number?][] = [
        ["image", data.image],
        ["thumbnail", data.thumbnail],
        ...(data.fields ?? []).map(
          (field: any, index: number) =>
            ["field", field, index] as [string, any, number],
        ),
      ];
      for (const [part, media, fieldIndex] of parts) {
        if (!media?.url) continue;
        // External images are reachable only through Discord's media proxy; the owner reference keeps the
        // original URL, which is what the archive's renderer matches the embed against.
        const source = [media.url, media.proxy_url].find(
          (url: string | undefined) => allowedHost(url, policy),
        );
        if (!source) {
          omitNow("embed_image", media.id ?? null, "host_not_allowed");
          continue;
        }
        let original: string;
        try {
          original = safeUrl(media.url);
        } catch {
          omitNow("embed_image", media.id ?? null, "host_not_allowed");
          continue;
        }
        optional.push({
          kind: "embed_image",
          source_discord_id: media.id ?? null,
          source_url: source,
          owner_reference: {
            message_id: message.id,
            embed_id: data.id,
            embed_index: embedIndex,
            embed_part: part,
            ...(fieldIndex === undefined ? {} : { field_index: fieldIndex }),
            url: original,
          },
        });
      }
    }
  }
  const identity = (item: Candidate): string => {
    if (item.source_discord_id)
      return `${item.kind}:id:${item.source_discord_id}`;
    try {
      return `${item.kind}:url:${safeUrl(item.source_url)}`;
    } catch {
      return `${item.kind}:url:${item.source_url}`;
    }
  };
  const seen = new Set<string>();
  const unique = <T extends Candidate>(items: T[]): T[] =>
    items.filter((item) => {
      const key = identity(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const attachments = unique(required);
  // At most HEAD_CONCURRENCY requests at once: a long consultation must not burst hundreds of HEADs at the CDN.
  const pending = unique(optional);
  const resolved: (ArchiveAsset | null)[] = new Array(pending.length).fill(
    null,
  );
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const index = next++;
      resolved[index] = await resolveOptional(
        pending[index],
        fetchImpl,
        policy,
        omitted,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HEAD_CONCURRENCY, pending.length) }, worker),
  );
  return [
    ...attachments,
    ...resolved.filter((item): item is ArchiveAsset => item !== null),
  ];
}

export async function resolveApplicant(
  interaction: any,
  channel: any,
  state: any,
): Promise<any> {
  const stateApplicantId = state?.context?.applicantDiscordId;
  if (stateApplicantId) {
    const member = await channel.guild.members
      .fetch(stateApplicantId)
      .catch(() => null);
    if (!member || member.user?.bot)
      throw new Error("지원자 정보를 Discord에서 확인할 수 없습니다.");
    return member;
  }
  const eligible: any[] = [];
  for (const overwrite of values(channel.permissionOverwrites.cache).filter(
    (item: any) => item.type === 1,
  )) {
    const member = await channel.guild.members
      .fetch(overwrite.id)
      .catch(() => null);
    const recruiter =
      member?.roles?.cache &&
      values(member.roles.cache).some((role: any) =>
        String(role.name).includes("리크루터"),
      );
    if (
      member &&
      !member.user?.bot &&
      member.id !== interaction.user.id &&
      !recruiter
    )
      eligible.push(member);
  }
  if (eligible.length !== 1)
    throw new Error(
      `지원자 권한 대상을 하나로 확정할 수 없습니다 (eligible=${eligible.length}).`,
    );
  return eligible[0];
}

export interface CollectOptions {
  policy?: AssetPolicy;
  fetchImpl?: typeof fetch;
}

export async function collectConsultation(
  interaction: ChatInputCommandInteraction,
  channel: TextChannel,
  options: CollectOptions = {},
): Promise<ConsultationPayload> {
  const policy = options.policy ?? loadAssetPolicy();
  if (
    !interaction.inGuild() ||
    channel.type !== ChannelType.GuildText ||
    !channel.guild
  )
    throw new Error("상담중 길드 텍스트 채널에서만 사용할 수 있습니다.");
  if (channel.parent?.name !== "상담중")
    throw new Error("현재 채널은 상담중 카테고리에 속하지 않습니다.");
  const { messages, cutoff } = await fetchAllMessages(channel);
  assertArchivableAttachments(messages, policy);
  const state = (
    interaction.client as any
  ).recruitStateMachine?.getCurrentState(channel.id);
  const applicant = await resolveApplicant(interaction, channel, state);
  let recruitmentType: RecruitmentType = channel.name.endsWith("-daehwa")
    ? "other"
    : "unknown";
  if (
    state?.context?.recruitType === "NIS" ||
    state?.context?.recruitType === "NIDU"
  )
    recruitmentType = state.context.recruitType;
  const participantMap = new Map<string, Record<string, unknown>>();
  const includedMessageIds = new Set(messages.map((message) => message.id));
  const serializedMessages = messages.map((message: any, sequence) => {
    const member = message.member;
    participantMap.set(message.author.id, {
      discord_user_id: message.author.id,
      username: message.author.username,
      display_name:
        member?.displayName ??
        message.author.globalName ??
        message.author.username,
      global_name: message.author.globalName,
      avatar: message.author.avatar,
      bot: message.author.bot,
      system: message.author.system,
      role:
        message.author.id === applicant.id
          ? "applicant"
          : message.author.id === interaction.user.id
            ? "recruiter"
            : "participant",
      roles: member
        ? values(member.roles.cache).map((role: any) => ({
            id: role.id,
            name: role.name,
          }))
        : [],
      raw_snapshot: json(message.author),
    });
    const attachments = values(message.attachments).map((a: any) => ({
      discord_attachment_id: a.id,
      filename: a.name,
      content_type: mimeFor(a.contentType, a.name ?? ""),
      size: a.size,
      source_url: a.url,
      width: a.width,
      height: a.height,
      proxy_url: a.proxyURL,
      description: a.description,
      ephemeral: a.ephemeral,
      duration_secs: a.duration,
      waveform: a.waveform,
      flags: a.flags?.bitfield ? Number(a.flags.bitfield) : undefined,
      raw_snapshot: json(a),
    }));
    const replyId = message.reference?.messageId;
    return {
      discord_message_id: message.id,
      author_discord_id: message.author.id,
      author_name: member?.displayName ?? message.author.username,
      content: message.content ?? "",
      created_at: message.createdAt.toISOString(),
      edited_at: message.editedAt?.toISOString() ?? null,
      sequence,
      reply_to_message_id:
        replyId && includedMessageIds.has(replyId) ? replyId : null,
      message_type: message.type,
      flags: Number(message.flags?.bitfield ?? 0),
      pinned: message.pinned,
      tts: message.tts,
      mention_everyone: message.mentions.everyone,
      mentions: values(message.mentions.users).map(json),
      mention_roles: values(message.mentions.roles).map((r: any) => r.id),
      mention_channels: values(message.mentions.channels).map((mentioned) =>
        scopedChannelReference(mentioned, channel.guild.id),
      ),
      embeds: message.embeds.map(json),
      reactions: values(message.reactions.cache).map(json),
      stickers: values(message.stickers).map(json),
      components: message.components.map(json),
      poll: json(message.poll),
      interaction: json(message.interactionMetadata),
      webhook_id: message.webhookId,
      application: json(message.application),
      message_snapshots: values(message.messageSnapshots).map((snapshot) =>
        withoutResolvedMentions(json(snapshot)),
      ),
      raw_snapshot: withoutResolvedMentions(json(message)),
      attachments,
    };
  });
  const omitted: OmittedAsset[] = [];
  const assets = await collectDownloadableAssets(
    messages,
    options.fetchImpl ?? fetch,
    policy,
    omitted,
  );
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    discord_guild_id: channel.guild.id,
    discord_channel_id: channel.id,
    channel_name: channel.name,
    recruitment_type: recruitmentType,
    applicant_discord_id: applicant.id,
    applicant_display_name: applicant.displayName,
    completed_by_discord_id: interaction.user.id,
    completed_by_display_name:
      interaction.member && "displayName" in interaction.member
        ? interaction.member.displayName
        : (interaction.user.globalName ?? interaction.user.username),
    started_at: messages[0].createdAt.toISOString(),
    captured_at: now,
    cutoff_message_id: cutoff.id,
    closed_at: now,
    guild: {
      id: channel.guild.id,
      name: channel.guild.name,
      icon: channel.guild.icon,
      features: channel.guild.features,
      raw: json(channel.guild),
    },
    channel: {
      id: channel.id,
      channel_type: channel.type,
      topic: channel.topic,
      nsfw: channel.nsfw,
      parent_id: channel.parentId,
      category: json(channel.parent),
      thread_metadata: null,
      forum_metadata: null,
      permission_snapshot: json(channel.permissionOverwrites.cache),
      raw: json(channel),
    },
    permission_snapshot: json(channel.permissionOverwrites.cache),
    raw_snapshot: {
      source: "recruit-bot",
      cutoff_captured_before_fetch: cutoff.id,
      omitted_assets: omitted,
    },
    participants: [...participantMap.values()],
    messages: serializedMessages,
    assets,
  };
}
