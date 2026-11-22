import { ChannelType, SlashCommandBuilder, TextChannel } from "discord.js";
import { SlashCommand } from "../lib/types";
import { DiscordHandler } from "../lib/classes/DiscordHandler";

const FinishTalk: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("상담완료")
    .setDescription(
      "현재 채널의 상담을 보관하고, 보관이 확인되면 채널을 삭제합니다.",
    )
    .setDefaultMemberPermissions(0),
  execute: async (interaction) => {
    const currentChannel = interaction.channel;

    if (currentChannel === null) {
      throw Error("현재 채널을 찾을 수 없습니다.");
    }

    if (
      !(currentChannel instanceof TextChannel) ||
      currentChannel.type !== ChannelType.GuildText
    ) {
      throw Error("길드 텍스트 상담 채널에서만 사용할 수 있습니다.");
    }

    await DiscordHandler.completeConsultation(interaction, currentChannel);
  },
  guildType: "recruit",
};

export default FinishTalk;
