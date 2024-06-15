import { SlashCommandBuilder } from "discord.js";
import { SlashCommand } from "../library/types";

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
    void interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const user = interaction.options.getUser("targetuser");

    if (interaction.guild === null) {
      throw new Error("interaction.guild is null.");
    }
    if (user === null) {
      throw new Error("user is null.");
    }
    const member = interaction.guild.members.cache.get(user.id);

    if (member === undefined) {
      throw new Error("member is undefined.");
    }
    const nickname = member.nickname;
    if (nickname === null) {
      throw new Error("nickname is null.");
    }

    if (subcommand === "add") {
      void interaction.client.seatRoleApplier
        .add(nickname, "48")
        .then(() =>
          interaction.editReply(
            `${user.toString()}님에게 뉴비 롤을 부여했습니다.`,
          ),
        );
    } else if (subcommand === "remove") {
      void interaction.client.seatRoleApplier
        .remove(nickname, "48")
        .then(() =>
          interaction.editReply(
            `${user.toString()}님에게 뉴비 롤을 제거했습니다.`,
          ),
        );
    }
  },
};

export default NewbieCommand;
