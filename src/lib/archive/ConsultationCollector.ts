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
/**
 * Permission overwrites as `{ [overwrite id]: overwrite }`. The archive stores this as a JSON object,
 * and a discord.js Collection's toJSON() is an array, so the cache cannot be passed through json().
 */
const permissionSnapshot = (channel: any): Record<string, unknown> =>
  Object.fromEntries(
    values(channel.permissionOverwrites?.cache).map((overwrite: any) => [
      overwrite.id,
      json(overwrite),
    ]),
  );
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

/** What placed someone as the applicant; listed in the archive's raw_snapshot.applicant. */
export type ApplicantEvidence =
  | "state"
  | "option"
  | "permission"
  | "messages"
  | "channel_name";

/** The applicant of a consultation. A member if still in the server; otherwise their Discord user. */
export interface ResolvedApplicant {
  id: string;
  displayName: string;
  inGuild: boolean;
  evidence: ApplicantEvidence[];
}

/** The /상담완료 option that names the applicant when the channel alone cannot. */
export const APPLICANT_OPTION = "지원자";
const MAX_LISTED = 5;
/** Discord API error codes for a user who is not in the guild / does not exist. */
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

const isRecruiter = (member: any): boolean =>
  values(member?.roles?.cache).some((role: any) =>
    String(role.name).includes("리크루터"),
  );
/** Letters and digits only: channel names drop or replace what usernames may contain (".", "#"). */
const comparable = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** The username a consultation channel was created for: `<tag>-recruit` or `<tag>-daehwa`, maybe renamed with a suffix. */
const channelOwnerName = (name: unknown): string | null => {
  if (typeof name !== "string") return null;
  const match = /^(.+)-(?:recruit|daehwa)(?:[_-].*)?$/.exec(name);
  return match ? comparable(match[1]) : null;
};

interface Person {
  id: string;
  member: any;
  user: any;
  overwrite: boolean;
  authored: boolean;
}
const personName = (person: Person): string =>
  displaySafe(
    String(
      person.member?.displayName ??
        person.user?.globalName ??
        person.user?.username ??
        person.id,
    ),
    40,
  ) || person.id;
const asApplicant = (
  person: Person,
  evidence: ApplicantEvidence[],
): ResolvedApplicant => ({
  id: person.id,
  displayName: personName(person),
  inGuild: Boolean(person.member),
  evidence,
});

/**
 * The applicant, in this order: the recruit state; the 지원자 option; otherwise the people of the channel
 * (member overwrites and message authors, without bots, webhooks and the commander). The bot gives a member
 * overwrite only to the applicant, so non-recruiters with one come first, then non-recruiter authors; several
 * are narrowed by who talked and by the name the channel was created with. Someone who now has a recruiter
 * role counts only when the channel name is theirs (an applicant who became a recruiter). A member who left the
 * server is still found from their user; their roles are unknown. Anything but exactly one fails closed.
 */
export async function resolveApplicant(
  interaction: any,
  channel: any,
  state: any,
  messages: any[],
): Promise<ResolvedApplicant> {
  // Only Discord's "unknown" answers mean someone is not there; any other failure (network, 429, 5xx)
  // stops the archive, or a recruiter who could not be read would count as someone who left.
  const lookup = async (fetching: () => Promise<any>, unknownCode: number) => {
    try {
      return (await fetching()) ?? null;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === unknownCode)
        return null;
      throw new ArchiveError(
        "collection",
        "Discord에서 채널 참가자 정보를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.",
        { cause: error },
      );
    }
  };
  const fetchMember = (id: string) =>
    lookup(() => channel.guild.members.fetch(id), UNKNOWN_MEMBER);
  const users = channel.client?.users ?? interaction.client?.users;
  const fetchUser = (id: string) =>
    users ? lookup(() => users.fetch(id), UNKNOWN_USER) : null;
  const authors = new Map<string, any>();
  for (const message of messages)
    if (message?.author?.id && !message.webhookId)
      authors.set(message.author.id, message.author);
  const overwriteIds = new Set<string>(
    values(channel.permissionOverwrites?.cache)
      .filter((item: any) => item.type === 1)
      .map((item: any) => String(item.id)),
  );
  const personFor = async (id: string): Promise<Person | null> => {
    const member = await fetchMember(id);
    const user = member?.user ?? authors.get(id) ?? (await fetchUser(id));
    if (!member && !user) return null;
    return {
      id,
      member,
      user,
      overwrite: overwriteIds.has(id),
      authored: authors.has(id),
    };
  };
  const supported = (person: Person): ApplicantEvidence[] => [
    ...(person.overwrite ? (["permission"] as const) : []),
    ...(person.authored ? (["messages"] as const) : []),
  ];

  const picked = interaction.options?.getUser?.(APPLICANT_OPTION, false);
  const stateApplicantId = state?.context?.applicantDiscordId;
  if (stateApplicantId) {
    if (picked && picked.id !== String(stateApplicantId))
      throw new ArchiveError(
        "collection",
        "지정한 지원자가 상담 상태의 지원자와 다릅니다. 지원자 옵션 없이 다시 실행해 주세요.",
      );
    const person = await personFor(String(stateApplicantId));
    if (!person || person.user?.bot || person.user?.system)
      throw new ArchiveError(
        "collection",
        "지원자 정보를 Discord에서 확인할 수 없습니다.",
      );
    return asApplicant(person, ["state"]);
  }
  if (picked) {
    const id = String(picked.id);
    const fail = (reason: string) =>
      new ArchiveError(
        "collection",
        `지정한 지원자를 쓸 수 없습니다: ${reason}`,
      );
    if (picked.bot) throw fail("봇입니다.");
    if (id === interaction.user.id) throw fail("명령을 실행한 사람입니다.");
    const person = await personFor(id);
    if (!person || !(person.overwrite || person.authored))
      throw fail("이 채널에 권한도 대화 기록도 없습니다.");
    return asApplicant(person, ["option", ...supported(person)]);
  }

  const people: Person[] = [];
  const excluded: string[] = [];
  for (const id of new Set([...overwriteIds, ...authors.keys()])) {
    if (id === interaction.user.id) continue;
    const person = await personFor(id);
    if (!person) {
      // An author is always known from the message itself, so only an overwrite gets here.
      excluded.push(`${id}(Discord에서 찾을 수 없음)`);
      continue;
    }
    if (person.user?.bot || person.user?.system) continue;
    people.push(person);
  }
  const hint = `\`/상담완료 ${APPLICANT_OPTION}:\`로 지원자를 직접 지정해 주세요.`;
  // An overwrite is given only to the applicant: one that cannot be read may be the applicant's.
  if (excluded.length)
    throw new ArchiveError(
      "collection",
      `개인 권한 대상 중 Discord에서 확인할 수 없는 사람이 있어 지원자를 정하지 않았습니다: ${excluded.slice(0, MAX_LISTED).join(", ")}. ${hint}`,
    );
  const ownerName = channelOwnerName(channel.name);
  const namedByChannel = (person: Person) =>
    ownerName !== null &&
    [person.user?.username, person.user?.tag].some(
      (name) => typeof name === "string" && comparable(name) === ownerName,
    );
  const recruiters = people.filter((person) => isRecruiter(person.member));
  const others = people.filter((person) => !isRecruiter(person.member));
  // The bot gives a member overwrite only to the applicant, so those come before mere authors.
  const tiers = [
    others.filter((person) => person.overwrite),
    others.filter((person) => person.authored),
  ];
  const describe = (person: Person, why: string[]) =>
    `${personName(person)}(${person.id}, ${why.join("·")})`;
  const label = (person: Person) =>
    describe(person, [
      ...(person.overwrite ? ["권한"] : []),
      ...(person.authored ? ["대화"] : []),
      ...(person.member ? [] : ["서버 나감"]),
    ]);
  const listed = (items: string[]) =>
    items.length > MAX_LISTED
      ? `${items.slice(0, MAX_LISTED).join(", ")} 외 ${items.length - MAX_LISTED}명`
      : items.join(", ");

  for (const tier of tiers) {
    if (tier.length === 0) continue;
    let narrowed = tier;
    if (narrowed.length > 1) {
      const talked = narrowed.filter((person) => person.authored);
      if (talked.length >= 1) narrowed = talked;
    }
    if (narrowed.length > 1) {
      const named = narrowed.filter(namedByChannel);
      if (named.length === 1) narrowed = named;
    }
    // Someone who left has no roles to read: from their messages alone they may as well be a recruiter
    // who left, so the channel name must name them too.
    if (
      narrowed.length === 1 &&
      !narrowed[0].overwrite &&
      !narrowed[0].member &&
      !namedByChannel(narrowed[0])
    )
      throw new ArchiveError(
        "collection",
        `서버를 나간 사람의 대화만 남아 있어 지원자인지 리크루터인지 알 수 없습니다. 후보: ${label(narrowed[0])}. ${hint}`,
      );
    if (narrowed.length === 1) {
      const [person] = narrowed;
      return asApplicant(person, [
        ...supported(person),
        ...(namedByChannel(person) ? (["channel_name"] as const) : []),
      ]);
    }
    throw new ArchiveError(
      "collection",
      `지원자를 한 명으로 정할 수 없습니다. 후보 ${narrowed.length}명: ${listed(narrowed.map(label))}. ${hint}`,
    );
  }
  // Nobody but recruiters: an applicant who has since become one, if the channel was created for them.
  const named = recruiters.filter(namedByChannel);
  if (named.length === 1)
    return asApplicant(named[0], [...supported(named[0]), "channel_name"]);
  const recruiterList = recruiters.map((person) =>
    describe(person, ["리크루터"]),
  );
  const why = [...recruiterList, ...excluded];
  throw new ArchiveError(
    "collection",
    `지원자를 찾지 못했습니다. 리크루터·봇·명령자가 아닌 개인 권한 대상도, 대화한 사람도 없습니다.${why.length ? ` 제외: ${listed(why)}.` : ""} ${hint}`,
  );
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
  const applicant = await resolveApplicant(
    interaction,
    channel,
    state,
    messages,
  );
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
  const snapshot = permissionSnapshot(channel);
  return {
    schema_version: 2,
    discord_guild_id: channel.guild.id,
    discord_channel_id: channel.id,
    channel_name: channel.name,
    recruitment_type: recruitmentType,
    applicant_discord_id: applicant.id,
    applicant_display_name: applicant.inGuild
      ? applicant.displayName
      : `${applicant.displayName} (서버 나감)`,
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
      permission_snapshot: snapshot,
      raw: json(channel),
    },
    permission_snapshot: snapshot,
    raw_snapshot: {
      source: "recruit-bot",
      cutoff_captured_before_fetch: cutoff.id,
      omitted_assets: omitted,
      applicant: { in_guild: applicant.inGuild, evidence: applicant.evidence },
    },
    participants: [...participantMap.values()],
    messages: serializedMessages,
    assets,
  };
}
