import { SlashCommandBuilder } from "discord.js";
import { SlashCommand } from "../library/types";
import { ZkillboardRequester } from "../library/classes/ZkillboardHandler";
import { EsiRequester } from "../library/classes/EsiHandler";
import { SeatHanlder } from "../library/classes/seat/SeatHandler";
import { getFormattedString } from "../library/functions";
import srpPercentDB from "../static/srp_data.json";
import { isAxiosError } from "axios";
import { Pool, DatabaseError } from "pg";

const databaseClient = new Pool({
  host: process.env.POSTGRES_HOST,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PW,
  database: process.env.POSTGRES_DB,
  port: 5432,
  max: 5,
});

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
        )
        .addBooleanOption((option) =>
          option
            .setName("is_special_role")
            .setDescription(
              "특수 롤이거나 로지 로스인가요? (기입하지 않을 경우 아닌 것으로 간주됩니다)",
            )
            .setRequired(false),
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

          if (interaction.options.getBoolean("is_special_role"))
            srpPercent = 1.0;
          else srpPercent = 0.5;

          srpFinalValue = totalValue * srpPercent;
          break;
        case "solo":
          srpTypeString = "솔로잉 / 스몰갱";
          srpObject =
            srpPercentDB.solo_rules[
              fieldName as keyof (typeof srpPercentDB)["solo_rules"]
            ];
          srpPercent = srpObject.percentage;

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

      try {
        const seatHanler = new SeatHanlder();
        const seatCharacterData = await seatHanler.getCharacterSheetFromId(
          esiKillmailData.victim.character_id.toString(),
        );
        const seatUserData = await seatHanler.getUserFromId(
          seatCharacterData.data.user_id,
        );
        const discordMember = await interaction.guild?.members.fetch(
          interaction.user.id,
        );

        if (discordMember == null) {
          void interaction.editReply(
            "해당 디스코드 닉네임이 시트에 등록되어 있지 않습니다.",
          );
          return;
        }

        if (seatUserData.data.name !== discordMember.displayName) {
          void interaction.editReply(
            "다른 메인 캐릭터에 등록된 캐릭터 입니다. 디스코드 계정과 연결된 시트 유저 계정에 해당 캐릭터를 추가해 주세요.",
          );
          return;
        }

        const query =
          "INSERT INTO srp_records (killmail_id, main_char_id, lost_amount, amount, percentage, type_string, status_string) VALUES ($1, $2, $3, $4, $5, $6, $7)";
        await databaseClient.query(query, [
          zkillboardKillmailData.killmail_id,
          seatUserData.data.main_character_id,
          totalValue,
          srpFinalValue,
          srpPercent,
          srpTypeString,
          "pending",
        ]);

        void interaction.editReply(
          `${discordMember.displayName}의 ${srpTypeString} SRP 신청: \n https://zkillboard.com/kill/${zkillboardKillmailData.killmail_id} \n ${getFormattedString(srpFinalValue, "number")} ISK (${getFormattedString(totalValue, "number")}ISK 의 ${getFormattedString(srpPercent, "percent")}%)`,
        );
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 404) {
          const characterNames = await esiRequester.getNamesFromIds([
            esiKillmailData.victim.character_id,
          ]);

          void interaction.editReply(
            `오류: ${characterNames[0].name}은(는) SeAT에 가입되지 않은 캐릭터입니다.`,
          );
          return;
        }

        if (error instanceof DatabaseError && error.code === "23505") {
          void interaction.editReply(
            "이미 해당 킬메일에 대한 SRP 신청이 존재합니다.",
          );
          return;
        }

        console.log(error);
        void interaction.editReply("오류가 발생했습니다. 다시 시도해 주세요.");
      }
    })();
  },
};

export default SRPRequestCommands;
