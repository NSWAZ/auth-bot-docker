import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Pool } from "pg";
import { SlashCommand } from "../library/types";
import { EsiRequester } from "../library/handlers/EsiRequester";

const databaseClient = new Pool({
  host: process.env.POSTGRES_HOST,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PW,
  database: process.env.POSTGRES_DB,
  port: 5432,
  max: 5,
});

const GetPayListCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("get_pay_list")
    .setDescription(
      "SRP 허가된 SRP 항목들을 정리하여 캐릭터마다 보내야 할 금액을 계산하여 출력합니다.",
    )
    .setDefaultMemberPermissions(0),
  execute: (interaction) => {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("pay_confirmed")
        .setLabel("모두 입금 완료 (주의: 되돌릴 수 없습니다)")
        .setStyle(ButtonStyle.Danger),
    );

    const query = "SELECT * FROM srp_records WHERE status_string = 'approved'";

    void (async () => {
      try {
        const srp_records = await databaseClient.query(query);

        if (srp_records.rowCount === 0) {
          void interaction.reply("아직 승인된 SRP 신청이 없습니다.");
          return;
        } else {
          const pay_list: Record<number, number> = {};
          for (const record of srp_records.rows as {
            main_char_id: number;
            amount: number;
          }[]) {
            const amount = Math.ceil(record.amount);

            if (pay_list[record.main_char_id] === undefined) {
              pay_list[record.main_char_id] = amount;
            } else {
              pay_list[record.main_char_id] += amount;
            }
          }

          const esiRequester = new EsiRequester();
          const names = await esiRequester.getNamesFromIds(
            Object.keys(pay_list).map(Number),
          );

          let message = "SRP 신청이 승인된 캐릭터들의 금액입니다.\n```";
          for (const [main_char_id, amount] of Object.entries(pay_list)) {
            const name = names.find(
              (name) => name.id === Number(main_char_id),
            )?.name;
            message += `${name} \n${amount.toLocaleString()} ISK\n\n`;
          }

          void interaction.reply({
            content: message + "```",
            components: [row],
          });
        }
      } catch (error) {
        console.error(error);
        void interaction.reply("오류가 발생했습니다.");
      }
    })();
  },
};

export default GetPayListCommand;
