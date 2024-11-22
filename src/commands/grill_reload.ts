import {
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CollectorFilter,
  MessageComponentInteraction,
  TextChannel,
  CategoryChannelResolvable,
  VoiceChannel,
} from "discord.js";
import { SlashCommand } from "../library/types";

const GrillReloadCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("grill_reload")
    .setDescription("원하는 채널의 불판을 갑니다!")
    .addChannelOption((option) =>
      option
        .setName("targetchannel")
        .setDescription("불판을 갈 채널")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
        .addChannelTypes(ChannelType.GuildVoice),
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("yes")
          .setLabel("예")
          .setStyle(ButtonStyle.Success),
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId("no")
          .setLabel("아니요")
          .setStyle(ButtonStyle.Danger),
      );

    const targetChannel = interaction.options.getChannel("targetchannel");
    if (targetChannel === null) throw Error("목표 채널을 찾을 수 없습니다.");
    if (
      !(
        targetChannel instanceof TextChannel ||
        targetChannel instanceof VoiceChannel
      )
    )
      throw Error("텍스트 채널이나 음성 채널만 불판을 갈 수 있습니다.");

    const targetChannelName = `<#${targetChannel.id}> 채널`;
    let responseString = targetChannelName;

    void interaction
      .reply({
        content: `정말 ${targetChannelName}을 아카이브하고 복사본을 만들까요?`,
        components: [row],
      })
      .then(async () => {
        const filter: CollectorFilter<
          [MessageComponentInteraction<"cached">]
        > = (i) => i.customId === "yes" || i.customId === "no";

        if (interaction.channel === null)
          throw Error("명령어 입력 채널을 찾을 수 없습니다.");
        if (!(interaction.channel instanceof TextChannel))
          throw Error("명령어 입력 채널은 텍스트 채널이어야 합니다.");
        const collected = await interaction.channel.awaitMessageComponent({
          filter,
          time: 30000,
        });

        await collected.update({
          content: responseString + " 불판 교체를 시작합니다...",
          components: [],
        });

        if (collected.customId === "yes") {
          if (interaction.guild === null)
            throw Error("명령어 입력 길드를 찾을 수 없습니다.");

          const targetCategories = interaction.guild.channels.cache.filter(
            (c) =>
              c.type === ChannelType.GuildCategory && c.name === "아카이브",
          );

          switch (targetCategories.size) {
            case 1:
              void targetChannel
                .clone()
                .then(async () => {
                  const today = new Date();
                  const year = today.getFullYear();
                  const month = ("0" + (today.getMonth() + 1)).slice(-2);
                  const day = ("0" + today.getDate()).slice(-2);

                  await targetChannel.setName(
                    targetChannel.name + "_" + year + "-" + month + "-" + day,
                  );
                })
                .then(async () => {
                  await targetChannel.setParent(
                    targetCategories.first()?.id as CategoryChannelResolvable,
                    { lockPermissions: true },
                  );
                });

              break;
            case 0:
              throw Error("`아카이브` 라는 이름의 카테고리가 없습니다.");
            default:
              throw Error(
                "`아카이브` 라는 이름의 카테고리가 한 개가 아닙니다.",
              );
          }

          responseString += "의 불판을 성공적으로 갈았습니다!";
        } else {
          responseString += " 불판 교체를 취소했습니다.";
        }

        void interaction.followUp({ content: responseString });
      });
  },
};

export default GrillReloadCommand;
