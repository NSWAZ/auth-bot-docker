import { SlashCommandBuilder } from "discord.js";
import { SlashCommand } from "../library/types";

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
            .setName("targetuser")
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
            .setName("targetuser")
            .setDescription("인액티브 롤을 제거할 유저")
            .setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    void interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const user = interaction.options.getUser("targetuser");

    if (interaction.guild === null)
      throw new Error("interaction.guild is null.");
    if (user === null) throw new Error("user is null.");

    const member = interaction.guild.members.cache.get(user.id);
    if (member === undefined) throw new Error("member is undefined.");

    const nickname = member.nickname;
    if (nickname === null) throw new Error("nickname is null.");

    if (interaction.client.seatRoleEngine === undefined)
      throw new Error("SeatRoleEngine is not initd");

    if (subcommand === "add") {
      void interaction.client.seatRoleEngine
        .add(nickname, "46")
        .then(() =>
          interaction.editReply(
            `${user.toString()}님에게 인액티브 롤을 부여했습니다.`,
          ),
        );
    } else if (subcommand === "remove") {
      void interaction.client.seatRoleEngine
        .remove(nickname, "46")
        .then(() =>
          interaction.editReply(
            `${user.toString()}님에게 인액티브 롤을 제거했습니다.`,
          ),
        );
    }
  },
};

export default InactiveCommand;
