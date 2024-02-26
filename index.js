const { Client, GatewayIntentBits, Events, AuditLogEvent } = require('discord.js');
const { loadEnvironmentVariables, getAuditTargetNickname } = require('./library/functions.js');

loadEnvironmentVariables();

const seatUsersCache = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMembers] });

const commandsHandler = new (require('./library/commands-handler.js'))();
const { commands } = commandsHandler.getCommands();
client.commands = commands;

client.login(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	commandsHandler.executeCommands(interaction);
});

// TODO : 롤 여러개 감시 가능하게 수정
client.on(Events.GuildAuditLogEntryCreate, async (auditLog, guild) => {
	const watchRoleId = '1210191232756621383';

	if (auditLog.action != AuditLogEvent.MemberRoleUpdate || auditLog.executorId === '1066230195473883136' || auditLog.changes[0].new[0].id != watchRoleId) return;

	const nickname = await getAuditTargetNickname(auditLog, guild);
	const seatRoleApllier = new SeatRoleApllier(nickname);

	if (auditLog.changes[0].key === '$add') {seatRoleApllier.add();}
	else if (auditLog.changes[0].key === '$remove') {seatRoleApllier.remove();}
});

class SeatRoleApllier {
	constructor(discordNickname) {
		this.roleId = '48';
		this.seatReq = new (require('./library/seat-request.js'))();
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

	async add() {
		const seatUserId = await this.getSeatUserId();
		await this.seatReq.userRoleAdd(seatUserId, this.roleId);
	}

	async remove() {
		const seatUserId = await this.getSeatUserId();
		await this.seatReq.userRoleRemove(seatUserId, this.roleId);
	}
}

module.exports = SeatRoleApllier;