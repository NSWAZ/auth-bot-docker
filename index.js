const { Client, Events, GatewayIntentBits } = require('discord.js');
const { loadEnvironmentVariables } = require('./library/functions.js');

loadEnvironmentVariables();

const seatUsersCache = new Map();

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// 봇에 명령어 등록
(async () => {
	const handleCommands = require('./library/commands-handler.js');
	const commends = await handleCommands('init');
	client.commands = commends;
})();

// Log in to Discord with your client's token
client.login(process.env.DISCORD_TOKEN);

// When the client is ready, run this code (only once)
// We use 'c' for the event parameter to keep it separate from the already defined 'client'
client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

// TODO : 이 부분 command-handler로 이동
client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	}
	catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
		}
		else {
			await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
		}
	}
});

// FIXME : 봇이 수행한 명령어는 감시하지 않도록 수정 (반복적인 롤 추가/제거 방지)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
	if (oldMember.roles.cache.size == newMember.roles.cache.size) return;

	if (oldMember.roles.cache.size > newMember.roles.cache.size) {
		// 롤 제거됨
		const changedRoleIds = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id)).map(role => role.id);
		const seatRoleApllier = new SeatRoleApllier(changedRoleIds, newMember.nickname);
		seatRoleApllier.remove();
	}
	else if (oldMember.roles.cache.size < newMember.roles.cache.size) {
		// 롤 추가됨
		const changedRoleIds = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id)).map(role => role.id);
		const seatRoleApllier = new SeatRoleApllier(changedRoleIds, newMember.nickname);
		seatRoleApllier.add();
	}
});

// TODO : 롤 여러개 감시 가능하게 수정
class SeatRoleApllier {
	constructor(changedRoleIds, discordNickname) {
		this.watchRoleId = '1210191232756621383';
		this.roleId = '48';
		this.seatReq = new (require('./library/seat-request.js'))();
		this.changedRoleIds = changedRoleIds;
		this.discordNickname = discordNickname;
	}

	async getSeatUserId() {
		// 캐시에 있으면 캐시에서 가져오기
		if (seatUsersCache.has(this.discordNickname)) return seatUsersCache.get(this.discordNickname);

		let isFindUser = false;
		let seatUserIndex = 1;
		while (!isFindUser) {
			const seatUsers = (await this.seatReq.getSeatUsers(seatUserIndex)).data;
			seatUsers.map(seatUser => seatUsersCache.set(seatUser.name, seatUser.id));

			const matchingSeatUsers = seatUsers.filter(seatUser => seatUser.name == this.discordNickname);

			if (matchingSeatUsers.length > 0) {
				isFindUser = true;

				return await matchingSeatUsers[0].id;
			}
			else {seatUserIndex++;}
		}
	}

	changedRoleIncludesWatchRole() {
		return this.changedRoleIds.includes(this.watchRoleId);
	}

	async add() {
		if (!this.changedRoleIncludesWatchRole()) return;

		const seatUserId = await this.getSeatUserId();
		await this.seatReq.userRoleAdd(seatUserId, this.roleId);
	}

	async remove() {
		if (!this.changedRoleIncludesWatchRole()) return;

		const seatUserId = await this.getSeatUserId();
		await this.seatReq.userRoleRemove(seatUserId, this.roleId);
	}
}

module.exports = SeatRoleApllier;