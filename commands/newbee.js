const { SlashCommandBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('newbee')
		.setDescription('뉴비 롤을 부여하거나 제거합니다.')
		.addSubcommand(subcommand =>
			subcommand
				.setName('add')
				.setDescription('뉴비 롤을 부여합니다.')
				.addUserOption(option =>
					option
						.setName('target')
						.setDescription('뉴비 롤을 부여할 유저')
						.setRequired(true)))
		.addSubcommand(subcommand =>
			subcommand
				.setName('remove')
				.setDescription('뉴비 롤을 제거합니다.')
				.addUserOption(option =>
					option
						.setName('target')
						.setDescription('뉴비 롤을 제거할 유저')
						.setRequired(true))),
	async execute(interaction) {
		interaction.deferReply();

		const subcommand = interaction.options.getSubcommand();
		const user = interaction.options.getUser('target');

		const nickname = interaction.guild.members.cache.get(user.id).nickname;

		const seatRoleApllier = new (require('../index.js'))(['1210191232756621383'], nickname);
		if (subcommand === 'add') {
			await seatRoleApllier.add();
			await interaction.editReply(`${user.toString()}님에게 뉴비 롤을 부여했습니다.`);
		}
		else if (subcommand === 'remove') {
			await seatRoleApllier.remove();
			await interaction.editReply(`${user.toString()}님에게 뉴비 롤을 제거했습니다.`);
		}
	},
};