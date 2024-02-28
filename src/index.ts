import { Client, GatewayIntentBits, Events, AuditLogEvent } from 'discord.js';
import { getAuditTargetNickname, loadEnvironmentVariables, reflectNewbieRoleChange } from './library/functions';
import { SeatRoleApplier } from './SeatRoleApplier';
import { CommandsHandler } from './library/handlers/Commands';

loadEnvironmentVariables();

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

client.on(Events.GuildAuditLogEntryCreate, async (auditLog, guild) => {
	if (auditLog.action != AuditLogEvent.MemberRoleUpdate || auditLog.executorId === '1066230195473883136') return;

	const nickname = await getAuditTargetNickname(auditLog, guild);
	void reflectNewbieRoleChange(auditLog, nickname, add, remove);
});

function add(nickname: string) {
	void client.seatRoleApllier.add(nickname);
}

function remove(nickname: string) {
	void client.seatRoleApllier.remove(nickname);
}