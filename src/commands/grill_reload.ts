import {
  SlashCommandBuilder,
  ChannelType,
  TextChannel,
  VoiceChannel,
} from "discord.js";
import { SlashCommand } from "../lib/types";
import { DiscordHandler } from "../lib/classes/DiscordHandler";

const GrillReloadCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("grill_reload")
    .setDescription("원하는 채널의 불판을 갑니다!")
    .addChannelOption((option) =>
      option
        .setName("target-channel")
        .setDescription("불판을 갈 채널")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
        .addChannelTypes(ChannelType.GuildVoice),
    )
    .setDefaultMemberPermissions(0),
  execute: async (interaction) => {
    const targetChannel = interaction.options.getChannel("target-channel");
    if (targetChannel === null) throw Error("목표 채널을 찾을 수 없습니다.");
    if (
      !(
        targetChannel instanceof TextChannel ||
        targetChannel instanceof VoiceChannel
      )
    )
      throw Error("텍스트 채널이나 음성 채널만 불판을 갈 수 있습니다.");

    await DiscordHandler.archiveChannel(interaction, targetChannel, "불판 갈기", "Copy");
  },
  guildType: "nis",
};

export default GrillReloadCommand;
