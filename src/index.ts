import { Client, GatewayIntentBits, Events, ChannelType } from "discord.js";
import {
  loadEnvironmentVariables,
  setDefaultLogLevel,
  settleWithin,
} from "./lib/functions";
import { SeatRoleEngine } from "./lib/classes/seat/RoleEngine";
import { CommandsHandler } from "./lib/classes/CommandHandler";
import { DiscordHandler, syncAnnouncement } from "./lib/classes/DiscordHandler";
import { RecruitHandler } from "./lib/classes/recruit/Handler";
import { StateBackup } from "./lib/classes/recruit/StateBackup";
import { loadArchiveConfig } from "./lib/archive/config";
import { getBanList } from "./lib/banList";
import { announcementData, stateBackupChannelName } from "./static/data";
import log from "loglevel";
import cron from "node-cron";

loadEnvironmentVariables();
setDefaultLogLevel();

const discordToken = process.env.DISCORD_TOKEN;
if (!discordToken) {
  throw new Error("DISCORD_TOKEN or DISCORD_TOKEN_FILE is required.");
}

if (!process.env.SEAT_TOKEN) {
  throw new Error("SEAT_TOKEN or SEAT_TOKEN_FILE is required.");
}

const discordNisGuildId = process.env.DISCORD_NIS_GUILD_ID;
if (!discordNisGuildId) {
  throw new Error("DISCORD_NIS_GUILD_ID is required.");
}

const discordRecruitGuildId = process.env.DISCORD_RECRUIT_GUILD_ID;
if (!discordRecruitGuildId) {
  throw new Error("DISCORD_RECRUIT_GUILD_ID is required.");
}

// /상담완료 cannot finish without a valid archive configuration, so a broken one stops the bot here.
loadArchiveConfig();
// A missing ban list only warns; a malformed one stops the bot here.
getBanList();

const guildIdMap = {
  nis: discordNisGuildId,
  recruit: discordRecruitGuildId,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.seatRoleEngine = new SeatRoleEngine();
client.guildIdMap = guildIdMap;
const recruitHandler = new RecruitHandler(client);
client.recruitStateMachine = recruitHandler.getStateMachineHandler();

// 리크룻 state 백업 (리크룻 길드의 states-backup 채널)
const stateBackup = new StateBackup(
  client,
  recruitHandler.getStateMachineHandler(),
  stateBackupChannelName,
  discordRecruitGuildId,
);
let stateRestored = false;

void client.login(discordToken);

/**
 * 클라이언트 준비 이벤트 핸들러
 */
client.once(Events.ClientReady, (c) => {
  log.info(`Ready! Logged in as ${c.user.tag}`);

  void (async () => {
    client.commands = await CommandsHandler.getCommandsFromDir();
  })().catch((error) => log.error("CommandsHandler: load failed:", error));

  void (async () => {
    // 봇 시작 시 이전 state 복원 시도
    log.info("StateBackup: Attempting to restore previous state...");
    stateRestored = await stateBackup.restoreState(recruitHandler);
    if (!stateRestored)
      log.error(
        "StateBackup: restore failed; backups stay off and restore is retried every 30 minutes",
      );

    // 안내 채널에 메시지 전송 (봇 자신의 안내 메시지만 교체)
    for (const [, item] of Object.entries(announcementData)) {
      try {
        const guildId = guildIdMap[item.guildType];
        const channel = await DiscordHandler.getChannelByName(
          client,
          guildId,
          item.channelName,
        );
        if (!channel) {
          log.warn(
            `AnnounceManager: Announcement channel not found: ${item.channelName} in ${item.guildType} guild`,
          );
          continue;
        }
        const result = await syncAnnouncement(channel, item.msg, c.user.id);
        log.info(
          `AnnounceManager: ${item.guildType}/${item.channelName} (${channel.id}): ${result}`,
        );
      } catch (error) {
        log.error(
          `AnnounceManager: ${item.guildType}/${item.channelName} failed:`,
          error,
        );
      }
    }
    log.info("AnnounceManager: Announcement check completed.");
  })().catch((error) => log.error("Startup tasks failed:", error));
});

/**
 * 인터랙션 생성 이벤트 핸들러
 */
client.on(Events.InteractionCreate, (interaction) => {
  // 슬래시 커맨드 처리
  if (interaction.isChatInputCommand() && interaction.guild) {
    void CommandsHandler.executeCommand(interaction).catch(console.error);
    return;
  }

  // 리크룻 인터랙션 처리
  if (
    (interaction.isButton() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith("RECRUIT_") &&
    interaction.guildId === discordRecruitGuildId
  ) {
    void recruitHandler
      .handleRecruitInteraction(interaction)
      .catch((error) =>
        log.error("RecruitHandler: interaction failed:", error),
      );
  }
});

/**
 * 메시지 생성 이벤트 핸들러 (리크룻 길드의 "/조건숙지함")
 */
client.on(Events.MessageCreate, (message) => {
  if (
    message.author.bot ||
    message.content != "/조건숙지함" ||
    message.guildId != discordRecruitGuildId ||
    message.channel?.type !== ChannelType.GuildText
  )
    return;

  log.debug("Handling agree conditions message...");
  void recruitHandler
    .handleAgreeConditionsMessage(message.channel)
    .catch((error) =>
      log.error("RecruitHandler: agree conditions failed:", error),
    );
});

/**
 * 30분마다 state 백업 (복원이 끝난 뒤에만: 복원 전 백업은 이전 백업을 지울 수 있음)
 */
cron.schedule("*/30 * * * *", () => {
  void (async () => {
    // 복원에 실패했다면 백업 전에 다시 복원한다 (복원되지 않은 이전 백업을 지우지 않게)
    if (!stateRestored) {
      stateRestored = await stateBackup.restoreState(recruitHandler);
      if (!stateRestored) return;
    }
    log.info("Time to backup state!");
    await stateBackup.backupState();
  })().catch((error) => log.error("StateBackup: scheduled run failed:", error));
});

/**
 * 리크루트 길드 채널이 지워지면(상담완료 포함) 그 채널의 세션을 끝낸다
 */
client.on(Events.ChannelDelete, (channel) => {
  if ("guildId" in channel && channel.guildId === discordRecruitGuildId)
    recruitHandler.getStateMachineHandler().endSession(channel.id);
});

/**
 * 프로세스 종료 시그널 핸들러
 * 봇이 종료되기 전에 state를 백업
 */
// Docker Swarm sends SIGKILL 10 s after SIGTERM by default, so the backup gets 8 s and the
// disconnect 1.5 s; a stuck Discord call never keeps the process from exiting.
const BACKUP_WAIT_MS = 8_000;
const DESTROY_WAIT_MS = 1_500;

const shutdownHandler = async (signal: string) => {
  log.info(`${signal} received. Backing up state before shutdown...`);

  if (stateRestored) {
    const backup = await settleWithin(
      stateBackup.backupState(),
      BACKUP_WAIT_MS,
    );
    log.info(
      `State backup ${backup === "settled" ? "completed" : "timed out"}.`,
    );
  }

  // 디스코드 클라이언트 종료
  await settleWithin(client.destroy(), DESTROY_WAIT_MS);
  log.info("Discord client destroyed.");

  process.exit(0);
};

// 다양한 종료 시그널 처리
process.on("SIGINT", () => void shutdownHandler("SIGINT"));
process.on("SIGTERM", () => void shutdownHandler("SIGTERM"));
process.on("SIGQUIT", () => void shutdownHandler("SIGQUIT"));

// Uncaught Exception 처리 (백업 후 종료, 백업은 최대 8초)
process.on("uncaughtException", (error) => {
  log.error("Uncaught Exception:", error);
  const backup = stateRestored ? stateBackup.backupState() : Promise.resolve();
  void settleWithin(backup, BACKUP_WAIT_MS).finally(() => process.exit(1));
});
