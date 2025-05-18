import {
  Client,
  GatewayIntentBits,
  Events,
  MessageCreateOptions,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from "discord.js";
import {
  applyCommandAllowedGuildList,
  loadEnvironmentVariables,
  sendAnnouncementMsgs,
  setDefaultLogLevel,
} from "./library/functions";
import { SeatRoleEngine } from "./library/classes/seat/SeatRoleEngine";
import { CommandsHandler } from "./library/classes/CommandHandler";
import { DatabaseEngine } from "./library/classes/DatabaseEngine";
import log from "loglevel";
import cron from "node-cron";
import { checkInactives } from "./functionApplyInactives";

loadEnvironmentVariables();
setDefaultLogLevel();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});
client.databaseEngine = new DatabaseEngine();
client.seatRoleEngine = new SeatRoleEngine();

void client.login(process.env.DISCORD_TOKEN);

/**
 * 클라이언트 준비 이벤트 핸들러
 */
client.once(Events.ClientReady, (c) => {
  log.info(`Ready! Logged in as ${c.user.tag}`);

  void (async () => {
    client.commands = await CommandsHandler.getCommandsFromDir();
  })();

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

  const JoinCOSUIChat = new ButtonBuilder()
    .setCustomId("joinCOSUIChat")
    .setStyle(ButtonStyle.Primary)
    .setLabel("콘스프 채팅");

  const JoinWormholeChat = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("웜홀 그룹")
    .setURL("https://forums.nisuwaz.com/t/topic/947");

  const message =
    "Nisuwa Cartel에서는 원하는 활동에 따라 다양한 그룹을 운영하고 있습니다. 아래 버튼 중 하나를 클릭해서 SeAT 및 디스코드에서 그에 맞는 그룹에 들어가거나 신청 절차를 알아보실 수 있습니다. \n\n마지막 수정일: 2024/05/24";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    joinCapSuperGroup,
    joinChoboFCGroup,
    joinMoonMiningGroup,
    JoinCOSUIChat,
    JoinWormholeChat,
  );

  const channelMsg: MessageCreateOptions = {
    content: message,
    components: [row],
  };

  void sendAnnouncementMsgs(client, channelMsg);
  void applyCommandAllowedGuildList(client);
  void checkInactives(client);
});

/**
 * 채널 내 명령어 이벤트 핸들러
 */
client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  CommandsHandler.executeCommand(interaction).catch(console.error);
});

/**
 * SRP 처리 버튼 이벤트 핸들러
 * TODO: 이벤트 핸들러 분리
 */
client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("pay_"))
    return;

  if (interaction.customId === "pay_confirmed") {
    void (async () => {
      if (client.databaseEngine === undefined)
        throw new Error("DB handler is not initd");

      await client.databaseEngine.query(
        "UPDATE srp_records SET status_string = 'paid' WHERE status_string = 'wait_paid'",
      );

      await interaction.message.edit({
        content: "SRP 처리가 완료되었습니다.",
        components: [],
      });
    })();
  } else if (interaction.customId === "pay_cancel") {
    void (async () => {
      if (client.databaseEngine === undefined)
        throw new Error("DB handler is not initd");

      await client.databaseEngine.query(
        "UPDATE srp_records SET status_string = 'approved' WHERE status_string = 'wait_paid'",
      );

      await interaction.message.edit({
        content: "SRP 처리가 취소되었습니다.",
        components: [],
      });
    })();
  }
});

/**
 * 매일 0시, 12시에 실행되는 작업
 * 인액티브 목록 불러와서 반영
 */
cron.schedule("0 0,12 * * *", () => {
  log.info("Time to check SRP");

  void checkInactives(client);
});
