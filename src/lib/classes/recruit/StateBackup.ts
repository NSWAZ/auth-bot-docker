import { ChannelType, Client, TextChannel } from "discord.js";
import log from "loglevel";

/** Backups are only trusted when this bot wrote them: anyone else in the channel could forge a session. */
export const isOwnBackupMessage = (
  message: { author?: { id?: string } | null; content: string },
  botUserId: string | undefined,
) =>
  !!botUserId &&
  message.author?.id === botUserId &&
  message.content.includes("State Backup");

/** A backed-up session is only restored into a text channel of the recruit guild. */
export const isRestorableChannel = (
  channel: { type?: unknown; guildId?: string | null } | null | undefined,
  recruitGuildId: string,
) =>
  !!channel &&
  channel.type === ChannelType.GuildText &&
  channel.guildId === recruitGuildId;
import { StateMachineHandler } from "./StateMachineHandler";
import { RecruitHandler } from "./Handler";

/**
 * State 백업 및 복원을 담당하는 클래스
 */
export class StateBackup {
  private client: Client;
  private stateMachineHandler: StateMachineHandler;
  private backupChannelName: string;
  private guildId: string;
  /** Channels a restore attempt already restored or dropped for good; later retries skip them. */
  private readonly settled = new Set<string>();

  constructor(
    client: Client,
    stateMachineHandler: StateMachineHandler,
    backupChannelName: string,
    guildId: string,
  ) {
    this.client = client;
    this.stateMachineHandler = stateMachineHandler;
    this.backupChannelName = backupChannelName;
    this.guildId = guildId;
  }

  /**
   * 현재 state를 디스코드 채널에 백업
   */
  async backupState(): Promise<void> {
    try {
      log.info("StateBackup: Starting state backup...");

      // 길드에서 채널 이름으로 찾기
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText && c.name === this.backupChannelName,
      ) as TextChannel | undefined;

      if (!channel?.isTextBased()) {
        log.error(
          `StateBackup: Backup channel '${this.backupChannelName}' not found or not a text channel`,
        );
        return;
      }

      // 모든 활성 세션 가져오기 (비어 있어도 백업을 교체: 끝난 세션이 예전 백업으로 되살아나지 않게)
      const sessions = this.stateMachineHandler.getActiveSessions();
      const previous = await channel.messages.fetch({ limit: 100 });
      const oldBackups = previous.filter((m) =>
        isOwnBackupMessage(m, this.client.user?.id),
      );

      // JSON으로 변환하여 저장
      const backupData = {
        timestamp: new Date().toISOString(),
        sessions: sessions,
      };

      const jsonString = JSON.stringify(backupData, null, 2);

      // 새 백업을 먼저 보낸 뒤 이전 백업을 지운다 (보내기에 실패하면 이전 백업이 남음)
      // 메시지가 2000자를 넘으면 파일로 업로드
      if (jsonString.length > 1900) {
        const buffer = Buffer.from(jsonString, "utf-8");
        await channel.send({
          content: `**State Backup** - ${new Date().toLocaleString("ko-KR")}`,
          files: [
            {
              attachment: buffer,
              name: `state-backup-${Date.now()}.json`,
            },
          ],
        });
      } else {
        await channel.send({
          content: `**State Backup** - ${new Date().toLocaleString("ko-KR")}\n\`\`\`json\n${jsonString}\n\`\`\``,
        });
      }

      for (const message of oldBackups.values()) {
        await message.delete();
      }
      if (oldBackups.size > 0) {
        log.info(`StateBackup: Deleted ${oldBackups.size} old backup messages`);
      }

      log.info(
        `StateBackup: Successfully backed up ${Object.keys(sessions).length} sessions`,
      );
    } catch (error) {
      log.error("StateBackup: Error during backup:", error);
    }
  }

  /**
   * 디스코드 채널에서 마지막 백업 데이터를 복원
   */
  /**
   * Restores the newest own backup. Returns false when the backup could not be read (Discord or
   * attachment errors), so the caller does not start replacing backups that were never restored.
   */
  async restoreState(recruitHandler: RecruitHandler): Promise<boolean> {
    try {
      log.info("StateBackup: Starting state restoration...");

      // 길드에서 채널 이름으로 찾기
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText && c.name === this.backupChannelName,
      ) as TextChannel | undefined;

      if (!channel?.isTextBased()) {
        log.error(
          `StateBackup: Backup channel '${this.backupChannelName}' not found or not a text channel`,
        );
        return true;
      }

      // 최근 메시지 가져오기 (backupState가 지우는 범위와 같은 100개)
      const messages = await channel.messages.fetch({ limit: 100 });
      let failed = false;

      for (const message of messages.values()) {
        if (isOwnBackupMessage(message, this.client.user?.id)) {
          let backupData = null;

          // 첨부 파일이 있으면 다운로드
          if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            if (attachment?.name.endsWith(".json")) {
              const response = await fetch(attachment.url, {
                signal: AbortSignal.timeout(30_000),
              });
              if (!response.ok)
                throw new Error(
                  `backup attachment download failed (${response.status})`,
                );
              const jsonText = await response.text();
              backupData = JSON.parse(jsonText);
            }
          } else {
            // 메시지 내용에서 JSON 추출
            const jsonMatch = /```json\n([\s\S]+)\n```/.exec(message.content);
            if (jsonMatch) {
              backupData = JSON.parse(jsonMatch[1]);
            }
          }

          if (backupData?.sessions) {
            log.info(`StateBackup: Found backup from ${backupData.timestamp}`);

            // 각 세션 복원
            for (const [channelId, sessionData] of Object.entries(
              backupData.sessions,
            )) {
              // A retry after a partial failure restores only what failed before: never a session
              // that is live, or one an earlier attempt restored (it may have ended since) or dropped.
              if (
                this.settled.has(channelId) ||
                recruitHandler.getStateMachineHandler?.().getSession(channelId)
              )
                continue;
              try {
                const recruitChannel = (await this.client.channels.fetch(
                  channelId,
                )) as TextChannel;
                if (!isRestorableChannel(recruitChannel, this.guildId)) {
                  log.warn(
                    `StateBackup: Skipping session for channel ${channelId}: not a text channel of the recruit guild`,
                  );
                  this.settled.add(channelId);
                } else {
                  // 채널 이름에서 채널명 추출
                  const channelName = recruitChannel.name;

                  log.info(
                    `StateBackup: Restoring session for channel ${channelName} (${channelId})`,
                  );

                  // 세션 복원 (RecruitHandler를 통해)
                  // 주의: context 데이터의 interaction 객체는 복원할 수 없으므로 null로 설정
                  const session: any = sessionData;
                  recruitHandler.restoreSession(
                    channelId,
                    channelName,
                    recruitChannel,
                    session,
                  );
                  this.settled.add(channelId);
                }
              } catch (error) {
                // Unknown Channel / Missing Access: the channel is gone or not ours; drop it.
                // Anything else may be transient: keep the backup and retry later.
                const code = (error as { code?: unknown } | null)?.code;
                if (code === 10003 || code === 50001) {
                  log.warn(
                    `StateBackup: Dropping session for channel ${channelId} (channel gone or not accessible)`,
                  );
                  this.settled.add(channelId);
                } else {
                  failed = true;
                  log.error(
                    `StateBackup: Error restoring session for channel ${channelId}:`,
                    error,
                  );
                }
              }
            }

            log.info(
              failed
                ? "StateBackup: State restoration incomplete; will retry"
                : "StateBackup: State restoration completed",
            );
            return !failed;
          }
        }
      }

      log.info("StateBackup: No backup data found");
      return true;
    } catch (error) {
      log.error("StateBackup: Error during restoration:", error);
      return false;
    }
  }

  /**
   * 오래된 백업 메시지 정리 (최근 1개만 유지)
   */
  async cleanupOldBackups(): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText && c.name === this.backupChannelName,
      ) as TextChannel | undefined;

      if (!channel?.isTextBased()) {
        return;
      }

      const messages = await channel.messages.fetch({ limit: 100 });
      const backupMessages = messages.filter((m) =>
        isOwnBackupMessage(m, this.client.user?.id),
      );

      if (backupMessages.size > 1) {
        const messagesToDelete = Array.from(backupMessages.values()).slice(1);
        for (const message of messagesToDelete) {
          await message.delete();
        }
        log.info(
          `StateBackup: Cleaned up ${messagesToDelete.length} old backup messages`,
        );
      }
    } catch (error) {
      log.error("StateBackup: Error during cleanup:", error);
    }
  }
}
