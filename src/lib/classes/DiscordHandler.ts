import {
  Client,
  TextChannel,
  ChannelType,
  ChatInputCommandInteraction,
  ButtonStyle,
  ButtonBuilder,
  ActionRowBuilder,
  MessageCreateOptions,
  VoiceChannel,
  CategoryChannelResolvable,
  CollectorFilter,
  MessageComponentInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import log from "loglevel";
import { SeatLookupError } from "./seat/RoleEngine";
import { SeatRequestError } from "./seat/Handler";
import { ArchiveClient, loadArchiveConfig } from "../archive/ArchiveClient";
import { collectConsultation } from "../archive/ConsultationCollector";
import { archiveVerifyThenMutate } from "../archive/ArchiveWorkflow";
import { ArchiveError, MutationError, displaySafe } from "../archive/errors";
import type { ArchiveResponse } from "../archive/types";

/** What the recruiter is told when /상담완료 does not finish: whether the channel was touched, and why. */
export function archiveFailureMessage(
  channelLabel: string,
  error: unknown,
): string {
  // Long enough for the applicant candidates a collection failure lists (Discord allows 2000 characters).
  const reason = displaySafe(
    error instanceof Error ? error.message : "알 수 없는 오류",
    900,
  );
  if (error instanceof MutationError)
    return `${channelLabel} 보관은 검증되었지만 채널을 지우지 못했습니다. 채널은 남아 있습니다. ${reason}`;
  // Only an ArchiveError proves the failure came before any change; anything else is reported neutrally.
  if (!(error instanceof ArchiveError))
    return `${channelLabel} 상담완료 처리 중 예상하지 못한 오류가 났습니다. 채널 상태를 확인해 주세요. 사유: ${reason}`;
  return `${channelLabel} 보관을 확인하지 못해 채널을 그대로 두었습니다(삭제하지 않음). 사유: ${reason}`;
}

export const isArchiveConfirmation = (
  initiatorId: string,
  nonce: string,
  promptMessageId: string,
  promptChannelId: string,
  interaction: MessageComponentInteraction,
) =>
  interaction.user.id === initiatorId &&
  interaction.message.id === promptMessageId &&
  interaction.channelId === promptChannelId &&
  (interaction.customId === `archive:${nonce}:yes` ||
    interaction.customId === `archive:${nonce}:no`);

/** What /grill_reload needs from a channel (TextChannel and VoiceChannel both fit). */
export interface ArchivableChannel {
  parentId: string | null;
  clone(): Promise<{ delete(): Promise<unknown> }>;
  setParent(
    parent: CategoryChannelResolvable | null,
    options: { lockPermissions: boolean },
  ): Promise<unknown>;
  setName(name: string): Promise<unknown>;
}

/** The part of a Discord message these helpers read. */
export interface AuthoredMessage {
  id: string;
  author?: { id?: string; bot?: boolean } | null;
  content?: string | null;
  delete?(): Promise<unknown>;
}

/** A channel whose message history can be paged (TextChannel fits). */
export interface MessageSource {
  messages: {
    fetch(options: {
      limit: number;
      after?: string;
    }): Promise<{ values(): Iterable<AuthoredMessage> }>;
  };
}

/**
 * /grill_reload: Copy clones the channel, then moves the original under the archive category
 * and renames it. Discord mutations are not atomic, so later failures are compensated where
 * possible and partial state is reported truthfully.
 */
export async function mutateArchivedChannel(
  targetChannel: ArchivableChannel,
  archiveCategoryId: CategoryChannelResolvable,
  archiveName: string,
  action: "Copy" | "Move",
): Promise<void> {
  const originalParentId = targetChannel.parentId;
  let clone: { delete(): Promise<unknown> } | null = null;
  if (action === "Copy") {
    try {
      clone = await targetChannel.clone();
    } catch {
      throw new Error(
        "복사본 생성에 실패했습니다. 원본 채널 mutation은 시작되지 않았습니다.",
      );
    }
  }
  try {
    await targetChannel.setParent(archiveCategoryId, { lockPermissions: true });
  } catch {
    if (clone) {
      try {
        await clone.delete();
      } catch {
        throw new Error(
          "카테고리 이동과 복사본 정리에 실패했습니다. 복사본이 남았을 수 있습니다 (partial mutation).",
        );
      }
    }
    throw new Error(
      "카테고리 이동에 실패했습니다. Discord 상태를 확인해야 합니다 (mutation 결과 불명).",
    );
  }
  try {
    await targetChannel.setName(archiveName);
  } catch {
    let parentRolledBack = false;
    try {
      await targetChannel.setParent(originalParentId, {
        lockPermissions: false,
      });
      parentRolledBack = targetChannel.parentId === originalParentId;
    } catch {
      // reported below
    }
    let cloneDeleted = !clone;
    if (clone) {
      try {
        await clone.delete();
        cloneDeleted = true;
      } catch {
        // reported below
      }
    }
    if (parentRolledBack && cloneDeleted)
      throw new Error(
        "채널 이름 변경에 실패했지만 선행 mutation은 확인된 상태로 롤백했습니다.",
      );
    throw new Error(
      "채널 이름 변경에 실패했고 롤백을 확인하지 못했습니다 (partial mutation). Discord 상태를 확인하세요.",
    );
  }
}

/**
 * Messages written by people after the verified archive's cutoff. They are not in the archive
 * and are deleted with the channel, so the recruiter is told how many (never their content).
 */
export async function countUnarchivedHumanMessages(
  channel: MessageSource,
  cutoffMessageId: string,
): Promise<number> {
  let after = cutoffMessageId;
  let count = 0;
  for (;;) {
    let messages: AuthoredMessage[];
    try {
      const page = await channel.messages.fetch({ limit: 100, after });
      messages = Array.from(page.values());
    } catch {
      throw new Error(
        "보관 이후 새 메시지를 확인하지 못해 채널을 지우지 않았습니다.",
      );
    }
    if (messages.length === 0) return count;
    for (const message of messages) if (!message.author?.bot) count++;
    if (messages.length < 100) return count;
    after = messages.reduce(
      (newest, message) =>
        BigInt(message.id) > BigInt(newest) ? message.id : newest,
      after,
    );
  }
}

export function consultationDeletionNotice(
  channelName: string,
  archiveId: string,
  unarchived: number,
): string {
  const lost =
    unarchived > 0
      ? ` 보관 이후 쓰인 새 메시지 ${unarchived}개는 보관되지 않았고 채널과 함께 지워집니다.`
      : "";
  return `#${displaySafe(channelName, 100)} 상담 보관이 검증되었습니다(보관 ID ${displaySafe(archiveId, 100)}). 채널을 삭제합니다.${lost}`;
}

/**
 * /상담완료 after a verified archive: tell the recruiter (in the reply, and by DM because the
 * reply disappears with the channel), log it without message content, then delete the channel.
 */
export async function deleteArchivedConsultation(
  interaction: Pick<ChatInputCommandInteraction, "editReply" | "user">,
  channel: MessageSource & {
    id: string;
    name: string;
    delete(reason?: string): Promise<unknown>;
  },
  verified: Pick<ArchiveResponse, "archive_id" | "cutoff_message_id">,
): Promise<void> {
  const unarchived = await countUnarchivedHumanMessages(
    channel,
    verified.cutoff_message_id,
  );
  const notice = consultationDeletionNotice(
    channel.name,
    verified.archive_id,
    unarchived,
  );
  log.info(
    `상담완료 channel=${channel.id} archive=${verified.archive_id} unarchived_human_messages=${unarchived} by=${interaction.user.id}`,
  );
  try {
    await interaction.editReply({ content: notice, components: [] });
  } catch (error) {
    log.warn("상담완료: 삭제 전 안내를 채널에 남기지 못했습니다.", error);
  }
  try {
    await interaction.user.send(notice);
  } catch {
    log.warn(
      `상담완료: 담당자 ${interaction.user.id}에게 DM을 보내지 못했습니다.`,
    );
  }
  try {
    await channel.delete(`상담완료: 보관 ${verified.archive_id} 검증 후 삭제`);
  } catch {
    throw new Error("채널 삭제에 실패했습니다.");
  }
}

/**
 * Keeps the bot's announcement in a channel current. Only the bot's own message is replaced;
 * messages from anyone else are never deleted.
 */
export async function syncAnnouncement(
  channel: MessageSource & {
    send(message: MessageCreateOptions): Promise<unknown>;
  },
  message: MessageCreateOptions,
  botUserId: string,
): Promise<"sent" | "replaced" | "unchanged"> {
  const recent = await channel.messages.fetch({ limit: 100 });
  const own = Array.from(recent.values())
    .filter((item) => item.author?.id === botUserId)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))[0];
  if (own && own.content?.trim() === message.content?.trim())
    return "unchanged";
  if (own?.delete) await own.delete();
  await channel.send(message);
  return own ? "replaced" : "sent";
}

interface Confirmation {
  confirmed: boolean;
  collected: MessageComponentInteraction;
}

export class DiscordHandler {
  /**
   * 채널 ID로 채널 가져오기
   */
  static async getChannelById(
    client: Client,
    channelId: string,
  ): Promise<TextChannel | null> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        return channel as TextChannel;
      }
    } catch (error) {
      log.error("Error fetching channel:", error);
    }

    return null;
  }

  static async getChannelByName(
    client: Client,
    guildId: string,
    channelName: string,
  ): Promise<TextChannel | null> {
    try {
      const guild = await client.guilds.fetch(guildId);
      const channel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === channelName,
      ) as TextChannel | undefined;

      return channel ?? null;
    } catch (error) {
      log.error("Error fetching channel by name:", error);
      return null;
    }
  }

  static async reflectRoleToMember(
    interaction: ChatInputCommandInteraction,
    seatRoleId: string,
  ) {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand(true);
    const user = interaction.options.getUser("target_user");

    if (interaction.guild === null)
      throw new Error("interaction.guild is null.");
    if (user === null) throw new Error("user is null.");

    const member = interaction.guild.members.cache.get(user.id);
    if (member === undefined) throw new Error("member is undefined.");

    if (interaction.client.seatRoleEngine === undefined)
      throw new Error("SeatRoleEngine is not initd");

    // The SeAT account is the one linked to this member's Discord ID, never one chosen by
    // nickname (members can rename themselves to another pilot's main character).
    try {
      if (subcommand === "add") {
        await interaction.client.seatRoleEngine.add(user.id, seatRoleId);
        await interaction.editReply(
          `${user.toString()}님에게 ${interaction.commandName} 롤을 부여했습니다.`,
        );
      } else if (subcommand === "remove") {
        await interaction.client.seatRoleEngine.remove(user.id, seatRoleId);
        await interaction.editReply(
          `${user.toString()}님에게 ${interaction.commandName} 롤을 제거했습니다.`,
        );
      }
    } catch (error) {
      // Both errors carry only a reason safe to show (SeatRequestError: method, path, status).
      if (
        !(error instanceof SeatLookupError) &&
        !(error instanceof SeatRequestError)
      )
        throw error;
      log.warn(
        `reflectRoleToMember: ${interaction.commandName} ${subcommand} refused for ${user.id}: ${error.message}`,
      );
      await interaction.editReply(
        `${user.toString()}님의 ${interaction.commandName} 롤을 바꾸지 않았습니다. ${error.message}`,
      );
    }
  }

  /*
   * 공지 메시지를 format 해서 반환합니다
   */
  static returnAnnouncementMsg() {
    /**
     * Nisuwa Cartel 안내 메시지
     */
    const joinCapSuperGroup = new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("NIS 슈퍼/캐피탈")
      .setURL("https://forums.nisuwaz.com/t/topic/333");

    const joinChoboFCGroup = new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("초보 FC")
      .setURL("https://forums.nisuwaz.com/t/gopw-fc/464");

    const joinMoonMiningGroup = new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("문마이닝 그룹")
      .setURL("https://forums.nisuwaz.com/t/topic/945");

    const nisRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      joinCapSuperGroup,
      joinChoboFCGroup,
      joinMoonMiningGroup,
    );

    const nisMsg: MessageCreateOptions = {
      content:
        "Nisuwa Cartel에서는 원하는 활동에 따라 다양한 그룹을 운영하고 있습니다. 아래 버튼 중 하나를 클릭해서 SeAT 및 디스코드에서 그에 맞는 그룹에 들어가거나 신청 절차를 알아보실 수 있습니다. \n\n마지막 수정일: 2025/12/15",
      components: [nisRow],
    };

    /**
     * 리크룻 안내 메시지
     */
    const startRecruit = new ButtonBuilder()
      .setCustomId("RECRUIT_START_SESSION")
      .setStyle(ButtonStyle.Success)
      .setLabel("가입 시작");

    const startDaehwa = new ButtonBuilder()
      .setCustomId("RECRUIT_START_DAEHWA")
      .setStyle(ButtonStyle.Secondary)
      .setLabel("기타 문의");

    const recruitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      startRecruit,
      startDaehwa,
    );

    const recruitMsg: MessageCreateOptions = {
      content:
        "Nisuwaz / Nisuwa Dairy Union 가입 절차를 시작하시려면 하단 '가입 시작' 버튼을, 다른 용무나 가입 관련 질문은 '기타 문의' 버튼을 통해 진행해 주세요 \n\n마지막 수정일 2025/12/17",
      components: [recruitRow],
    };

    return { nisMsg, recruitMsg };
  }

  /**
   * 예/아니요 확인. 버튼은 이 프롬프트마다 새 nonce를 쓰고, 명령을 실행한 사람·프롬프트 메시지·채널에만 반응합니다.
   * 시간이 지나면 안내를 바꾸고 null을 돌려줍니다.
   */
  private static async confirm(
    interaction: ChatInputCommandInteraction,
    content: string,
    actionName: string,
    ephemeral: boolean,
  ): Promise<Confirmation | null> {
    const nonce = randomUUID().replace(/-/g, "");
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`archive:${nonce}:yes`)
          .setLabel("예")
          .setStyle(ButtonStyle.Success),
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`archive:${nonce}:no`)
          .setLabel("아니요")
          .setStyle(ButtonStyle.Danger),
      );

    await interaction.reply({ content, components: [row], ephemeral });
    const promptMessage = await interaction.fetchReply();

    const filter: CollectorFilter<[MessageComponentInteraction<"cached">]> = (
      i,
    ) =>
      isArchiveConfirmation(
        interaction.user.id,
        nonce,
        promptMessage.id,
        interaction.channelId,
        i,
      );

    if (interaction.channel === null)
      throw Error("명령어 입력 채널을 찾을 수 없습니다.");
    if (!(interaction.channel instanceof TextChannel))
      throw Error("명령어 입력 채널은 텍스트 채널이어야 합니다.");

    try {
      const collected = await interaction.channel.awaitMessageComponent({
        filter,
        time: 30000,
      });
      return {
        confirmed: collected.customId === `archive:${nonce}:yes`,
        collected,
      };
    } catch {
      await interaction.editReply({
        content: `${actionName} 확인 시간이 초과되었습니다. 다시 시도해주세요.`,
        components: [],
      });
      return null;
    }
  }

  /**
   * 채널 아카이빙 (/grill_reload): 보관소 연동 없이 아카이브 카테고리로 옮깁니다.
   */
  static async archiveChannel(
    interaction: ChatInputCommandInteraction,
    targetChannel: TextChannel | VoiceChannel,
    actionName: string,
    action: "Copy" | "Move",
    ephemeral = false,
  ) {
    const targetChannelName = `<#${targetChannel.id}> 채널`;
    let responseString = targetChannelName;

    const actionDescription =
      action === "Copy"
        ? "아카이브하고 복사본을 만듭니다"
        : "아카이브로 이동합니다";

    const confirmation = await DiscordHandler.confirm(
      interaction,
      `정말 ${actionName}을(를) 하시겠습니까?\n${targetChannelName}을 ${actionDescription}.`,
      actionName,
      ephemeral,
    );
    if (!confirmation) return;

    await confirmation.collected.update({
      content: responseString + ` ${actionName} 작업을 시작합니다...`,
      components: [],
    });

    if (!confirmation.confirmed) {
      await interaction.editReply({
        content: responseString + ` ${actionName} 작업을 취소했습니다.`,
      });
      return;
    }

    if (interaction.guild === null)
      throw Error("명령어 입력 길드를 찾을 수 없습니다.");

    const targetCategories = interaction.guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildCategory && c.name === "아카이브",
    );
    if (targetCategories.size === 0)
      throw Error("`아카이브` 라는 이름의 카테고리가 없습니다.");
    if (targetCategories.size > 1)
      throw Error("`아카이브` 라는 이름의 카테고리가 한 개가 아닙니다.");

    const today = new Date();
    const date = `${today.getFullYear()}-${("0" + (today.getMonth() + 1)).slice(-2)}-${("0" + today.getDate()).slice(-2)}`;
    try {
      await mutateArchivedChannel(
        targetChannel,
        targetCategories.first()?.id as CategoryChannelResolvable,
        `${targetChannel.name}_${date}`,
        action,
      );
    } catch (error) {
      const reason = displaySafe(
        error instanceof Error ? error.message : String(error),
      );
      log.warn(`${actionName} 실패 channel=${targetChannel.id}: ${reason}`);
      await interaction.editReply({
        content: `${targetChannelName} ${actionName} 작업에 실패했습니다. ${reason}`,
      });
      return;
    }

    responseString += `의 ${actionName} 작업을 성공적으로 완료했습니다!`;
    await interaction.editReply({ content: responseString });
  }

  /**
   * 상담완료 (/상담완료): 상담을 보관소에 보관하고 검증한 뒤 채널을 지웁니다.
   * 보관이 검증되지 않으면 채널을 지우지 않습니다(fail-closed).
   */
  static async completeConsultation(
    interaction: ChatInputCommandInteraction,
    targetChannel: TextChannel,
  ) {
    const actionName = "상담 완료";
    const targetChannelName = `<#${targetChannel.id}> 채널`;

    const confirmation = await DiscordHandler.confirm(
      interaction,
      `정말 ${actionName}을(를) 하시겠습니까?\n${targetChannelName}을 보관소에 보관하고, 보관이 확인되면 채널을 삭제합니다.`,
      actionName,
      false,
    );
    if (!confirmation) return;

    await confirmation.collected.update({
      content: `${targetChannelName} ${actionName} 작업을 시작합니다... (보관 확인에 몇 분 걸릴 수 있습니다)`,
      components: [],
    });

    if (!confirmation.confirmed) {
      await interaction.editReply({
        content: `${targetChannelName} ${actionName} 작업을 취소했습니다.`,
      });
      return;
    }

    try {
      if (!targetChannel.deletable)
        throw new ArchiveError(
          "preflight",
          "봇에게 이 채널을 삭제할 권한(채널 관리)이 없습니다.",
        );
      await archiveVerifyThenMutate(
        interaction,
        targetChannel,
        {
          collect: collectConsultation,
          client: new ArchiveClient(loadArchiveConfig()),
        },
        (verified) =>
          deleteArchivedConsultation(interaction, targetChannel, verified),
      );
    } catch (error) {
      const kind =
        error instanceof ArchiveError
          ? error.kind
          : error instanceof MutationError
            ? "mutation"
            : "unknown";
      log.warn(
        `상담완료 실패 channel=${targetChannel.id} kind=${kind}: ${displaySafe(error instanceof Error ? error.message : String(error))}`,
      );
      await interaction.editReply({
        content: archiveFailureMessage(targetChannelName, error),
        components: [],
        // The reason can carry Discord display names: never let one ping anybody.
        allowedMentions: { parse: [] },
      });
    }
  }
}
