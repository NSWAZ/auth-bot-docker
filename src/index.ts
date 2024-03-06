import { Client, GatewayIntentBits, Events, AuditLogEvent, ChannelType, MessageCreateOptions, ButtonBuilder, ButtonStyle, ActionRowBuilder, GuildMember } from 'discord.js';
import { getAuditTargetNickname, loadEnvironmentVariables, reflectNewbieRoleChange, sendAnnouncementMsg, setDefaultLogLevel } from './library/functions';
import { SeatRoleApplier } from './SeatRoleApplier';
import { CommandsHandler } from './library/handlers/Commands';
import log from 'loglevel';

loadEnvironmentVariables();
setDefaultLogLevel();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMembers] });
const commandsHandler = new CommandsHandler();

void client.login(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, async c => {
	log.info(`Ready! Logged in as ${c.user.tag}`);

	client.commands = await commandsHandler.getCommandsFromDir();
	client.seatRoleApllier = new SeatRoleApplier();

	log.info('Registered commands:');
	log.info(client.commands);

	if (!process.env.ANNOUNCEMENT_CHANNELS) throw new Error('ANNOUNCEMENT_CHANNELS is not defined in environment variables.');

	const announcementChannels = JSON.parse(process.env.ANNOUNCEMENT_CHANNELS) as string[];

	const joinCapSuperGroup = new ButtonBuilder()
		.setStyle(ButtonStyle.Link)
		.setLabel('NIS 슈퍼/캐피탈')
		.setURL('https://forums.nisuwaz.com/t/topic/333');

	const joinChoboFC = new ButtonBuilder()
		.setStyle(ButtonStyle.Link)
		.setLabel('초보 FC')
		.setURL('https://forums.nisuwaz.com/t/gopw-fc/464');

	const joinMoonMining = new ButtonBuilder()
		.setStyle(ButtonStyle.Link)
		.setLabel('문마이닝 그룹')
		.setURL('https://forums.nisuwaz.com/t/topic/945');

	const JoinCosuiChat = new ButtonBuilder()
	    .setCustomId('joincosuichat')
		.setStyle(ButtonStyle.Primary)
		.setLabel('콘스프 채팅');

	const JoinWormhole = new ButtonBuilder()
		.setStyle(ButtonStyle.Link)
		.setLabel('웜홀 그룹')
		.setURL('https://forums.nisuwaz.com/t/topic/947');

	const message = 'Nisuwa Cartel에서는 원하는 활동에 따라 다양한 그룹을 운영하고 있습니다. 아래 버튼 중 하나를 클릭해서 SeAT 및 디스코드에서 그에 맞는 그룹에 들어가거나 신청 절차를 알아보실 수 있습니다.';

	const row = new ActionRowBuilder<ButtonBuilder>()
		.addComponents(joinCapSuperGroup, joinChoboFC, joinMoonMining, JoinCosuiChat, JoinWormhole);

	const channelMsg: MessageCreateOptions = { content: message, components: [row] };

	for (const channelId of announcementChannels) {
		const channel = await client.channels.fetch(channelId);

		if (channel && channel.type === ChannelType.GuildText) {
			void await sendAnnouncementMsg(channel, channelMsg);
		}
	}
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
	void client.seatRoleApllier.add(nickname, '48');
}

function remove(nickname: string) {
	void client.seatRoleApllier.remove(nickname, '48');
}

client.on(Events.InteractionCreate, interaction => {
	if (!interaction.isButton() || interaction.customId != 'joincosuichat') return;

	if ((interaction.member as GuildMember).roles.cache.filter(role => role.id === '1212067094791721041').size > 0) {
		void client.seatRoleApllier.remove((interaction.member as GuildMember).nickname as string, '49');
		void interaction.reply({ content: '콘스프 롤을 제거했습니다. (콘스프 꼽 맴버에게는 적용되지 않습니다)', ephemeral: true });
		return;
	}

	void client.seatRoleApllier.add((interaction.member as GuildMember).nickname as string, '49');
	void interaction.reply({ content: '콘스프 롤을 추가했습니다.', ephemeral: true });
});