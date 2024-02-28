import { Client, GatewayIntentBits, Events, AuditLogEvent } from 'discord.js';
import { getAuditTargetNickname, loadEnvironmentVariables } from './library/functions';
import { SeatRoleApplier } from './SeatRoleApplier';
import { CommandsHandler } from './library/handlers/Commands';
import { DiscordRole } from './library/types';

loadEnvironmentVariables();

// const seatUsersCache = new Map<string, string>();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMembers] });
const commandsHandler = new CommandsHandler();

void client.login(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, async c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);

	client.commands = await commandsHandler.getCommandsFromDir();
	client.seatRoleApllier = new SeatRoleApplier();
});

client.on(Events.InteractionCreate, interaction => {
	if (!interaction.isChatInputCommand()) return;

	commandsHandler.executeCommand(interaction)
		.catch(console.error);
});

// TODO : 롤 여러개 감시 가능하게 수정
client.on(Events.GuildAuditLogEntryCreate, async (auditLog, guild) => {
	if (auditLog.action != AuditLogEvent.MemberRoleUpdate || auditLog.executorId === '1066230195473883136') return;

	const watchRoleIds = ['1210191232756621383', '1210112780141600818'];
	const nickname = await getAuditTargetNickname(auditLog, guild);

	for (const change of auditLog.changes) {
		for (const newRole of (change.new as DiscordRole[])) {
			if (watchRoleIds.includes(newRole.id)) {

				if (change.key === '$add') {await client.seatRoleApllier.add(nickname);}
				else if (change.key === '$remove') {await client.seatRoleApllier.remove(nickname);}
			}
		}
	}
});