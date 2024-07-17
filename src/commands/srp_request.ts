import { SlashCommandBuilder } from "discord.js";
import { SlashCommand } from "../library/types";
import { ZkillboardRequester } from "../library/handlers/ZkillboardRequester";
import { EsiRequester } from "../library/handlers/EsiRequester";
import { getFormattedString } from "../library/functions";
import srpPercentDB from "../static/srp_data.json";

const SRPRequestCommands: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("srp_request")
    .setDescription("SRP 신청을 합니다.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("fleet")
        .setDescription("플릿 SRP를 신청합니다.")
        .addStringOption((option) =>
          option.setName("url").setDescription("킬메일 주소").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("solo")
        .setDescription("솔로잉 / 스몰갱 SRP를 신청합니다.")
        .addStringOption((option) =>
          option.setName("url").setDescription("킬메일 주소").setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    const subcommand = interaction.options.getSubcommand();
    const killmailURL = interaction.options.getString("url");

    if (!killmailURL) {
      void interaction.reply(
        "킬메일 주소가 입력되지 않았습니다. 올바른 킬메일 주소를 입력하여 주세요. \n 예시: https://zkillboard.com/kill/12345678/",
      );
      return;
    }
    const killmailID = /^https:\/\/zkillboard\.com\/kill\/(\d+)\//.exec(
      killmailURL,
    )?.[1];
    if (!killmailID) {
      void interaction.reply(
        "올바르지 않은 킬메일 주소입니다. 올바른 킬메일 주소를 입력하여 주세요. \n 예시: https://zkillboard.com/kill/12345678/",
      );
      return;
    }

    void (async () => {
      await interaction.deferReply();

      const zkillboardRequester = new ZkillboardRequester();
      const zkillboardKillmailData =
        await zkillboardRequester.getKillmailInfo(killmailID);
      const totalValue = zkillboardKillmailData.zkb.totalValue;

      const esiRequester = new EsiRequester();
      const esiKillmailData = await esiRequester.getKillmailInfo(
        zkillboardKillmailData.killmail_id,
        zkillboardKillmailData.zkb.hash,
      );
      const fieldName = esiKillmailData.victim.ship_type_id.toString();

      let srpTypeString;
      let srpFinalValue;
      let srpPercent;

      let srpObject;
      switch (subcommand) {
        case "fleet":
          srpTypeString = "플릿";
          srpPercent =
            srpPercentDB.fleet_rules[
              fieldName as keyof (typeof srpPercentDB)["fleet_rules"]
            ].percentage;
          srpFinalValue = totalValue * srpPercent;
          break;
        case "solo":
          srpTypeString = "솔로잉 / 스몰갱";
          srpObject =
            srpPercentDB.solo_rules[
              fieldName as keyof (typeof srpPercentDB)["solo_rules"]
            ];
          srpPercent = srpObject.percentage as number;

          srpFinalValue = totalValue * srpPercent;
          if (srpFinalValue > srpObject.max_value) {
            srpFinalValue = srpObject.max_value;
          }
          break;
        default:
          void interaction.editReply(
            "오류가 발생했습니다. 다시 시도해 주세요.",
          );
          return;
      }
      void interaction.editReply(
        `${interaction.user.displayName}의 ${srpTypeString} SRP 신청: \n https://zkillboard.com/kill/${zkillboardKillmailData.killmail_id} \n ${getFormattedString(srpFinalValue, "number")} ISK (${getFormattedString(totalValue, "number")}ISK 의 ${getFormattedString(srpPercent, "percent")}%)`,
      );
    })();
  },
};

export default SRPRequestCommands;
