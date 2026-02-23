import { SlashCommandBuilder } from "discord.js";
import { DiscordHandler } from "../lib/classes/DiscordHandler";
import { SlashCommand } from "../lib/types";

const InactiveCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("inactive")
    .setDescription("인액티브 롤을 부여하거나 제거합니다.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("인액티브 롤을 부여합니다.")
        .addUserOption((option) =>
          option
            .setName("target-user")
            .setDescription("인액티브 롤을 부여할 유저")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("인액티브 롤을 제거합니다.")
        .addUserOption((option) =>
          option
            .setName("target-user")
            .setDescription("인액티브 롤을 제거할 유저")
            .setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    void DiscordHandler.reflectRoleToMember(interaction, "52");
  },
  guildType: "nis",
};

export default InactiveCommand;
