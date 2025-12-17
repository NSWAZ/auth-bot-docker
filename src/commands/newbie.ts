import { SlashCommandBuilder } from "discord.js";
import { DiscordHandler } from "../lib/classes/DiscordHandler";
import { SlashCommand } from "../lib/types";

const NewbieCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("newbie")
    .setDescription("뉴비 롤을 부여하거나 제거합니다.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("뉴비 롤을 부여합니다.")
        .addUserOption((option) =>
          option
            .setName("targetuser")
            .setDescription("뉴비 롤을 부여할 유저")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("뉴비 롤을 제거합니다.")
        .addUserOption((option) =>
          option
            .setName("targetuser")
            .setDescription("뉴비 롤을 제거할 유저")
            .setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    DiscordHandler.reflectRoleToMember(interaction, "48");
  },
  guildType: "nis",
};

export default NewbieCommand;
