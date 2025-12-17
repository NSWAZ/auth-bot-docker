import {
  Client,
  TextChannel,
  ChannelType,
  GuildChannel,
  CategoryChannel,
  PermissionFlagsBits,
  OverwriteType,
  ChatInputCommandInteraction,
  ButtonStyle,
  ButtonBuilder,
  ActionRowBuilder,
  MessageCreateOptions,
  VoiceChannel,
  CategoryChannelResolvable,
  CollectorFilter,
  MessageComponentInteraction,
} from "discord.js";
import log from "loglevel";

export class DiscordHandler {
    /**
     * 채널 ID로 채널 가져오기
     */
    static async getChannelById(client: Client, channelId: string): Promise<TextChannel | null> {
        try {
            const channel = await client.channels.fetch(channelId);
            if (channel && channel.isTextBased()) {
                return channel as TextChannel;
            }
        } catch (error) {
            log.error("Error fetching channel:", error);
        }
        
        return null;
    }

    // 권한 설정 함수
    static async setChannelPermissions(
    channel: CategoryChannel | GuildChannel,
    memberIds: string[],
    ) {
        // 채널이 카테고리인 경우
        log.debug(
            `Set permissions for ` +
            (channel.type === ChannelType.GuildCategory ? "category" : "channel") +
            ` ${channel.name} (${channel.id})`,
        );

        // 현재 권한 오버라이드 가져오기 (멤버 타입 제외)
        const currentOverwrites = channel.permissionOverwrites.cache.filter(
            (overwrite) => overwrite.type !== OverwriteType.Member,
        );

        // 새로운 권한 오버라이드 생성
        const newOverwrites = memberIds.map((memberId) => ({
            id: memberId,
            type: 1, // 1은 멤버 타입
            deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages,
            ],
        }));

        // 기존 권한과 새로운 권한 병합
        const finalOverwrites = [...currentOverwrites.values(), ...newOverwrites];

        // 한 번에 모든 권한 설정
        if (channel.type === ChannelType.GuildCategory) {
            await channel.edit({
            permissionOverwrites: finalOverwrites,
            lockPermissions: true,
            });
        } else {
            await channel.permissionOverwrites.set(finalOverwrites);
        }
    }

    static async checkInactive(client: Client) {
        log.info("Checking inactives...");
        try {
            // Nisuwa Cartel 길드 ID
            const guild = await client.guilds.fetch("337276039858356224");
            const members = await guild.members.fetch();

            // 인액티브 롤을 가진 멤버만 필터링
            const inactiveMembers = members.filter((member) =>
            member.roles.cache.has("824637601091682353"),
            );

            // 각 인액티브 멤버의 정보 출력
            let inactiveMembersString = "";
            const inactiveMemberIds: string[] = [];
            inactiveMembers.forEach((member) => {
            inactiveMembersString += `, ${member.user.tag} (${member.nickname})`;
            inactiveMemberIds.push(member.id);
            });
            log.info(
            `Found ${inactiveMembers.size} inactive members : ${inactiveMembersString}`,
            );

            // 채널 메시지 가져오기
            const channel = (await client.channels.fetch(
            "1373646420397260914",
            )) as TextChannel;
            if (!channel) {
            throw new Error("Channel not found");
            }

            // 최대 100개의 메시지를 가져옵니다
            const messages = await channel.messages.fetch({ limit: 100 });
            log.info(`Found ${messages.size} messages in channel`);

            let processedChannelsString = "Processed channels: ";
            let processedCategoriesString = "Processed categories: ";
            // 메시지에서 채널/카테고리 ID 추출 및 권한 설정
            for (const message of messages.values()) {
            const content = message.content;
            const channelMatches = content.match(/<#(\d+)>/g);
            const categoryMatches = content.match(/CT:([^:\n]+)/g);

            if (channelMatches) {
                const match = channelMatches[0];
                const channelId = /\d+/.exec(match)?.[0];
                if (!channelId) throw new Error("Channel ID not found");

                const channel = await client.channels.fetch(channelId);
                if (!channel || channel.type !== ChannelType.GuildText)
                throw new Error("Channel not found");

                processedChannelsString += `, ${channel.name}`;
                await this.setChannelPermissions(channel, inactiveMemberIds);
            } else if (categoryMatches) {
                const match = categoryMatches[0];
                const categoryName = match.replace("CT:", "").trim();
                processedCategoriesString += `, ${categoryName}`;

                const category = guild.channels.cache.find(
                (ch) =>
                    ch.type === ChannelType.GuildCategory && ch.name === categoryName,
                );

                await this.setChannelPermissions(
                category as CategoryChannel,
                inactiveMemberIds,
                );
            }
            }

            log.info(processedChannelsString);
            log.info(processedCategoriesString);
            log.info("Inactive check completed");
        } catch (error) {
            log.error("Error checking inactives:", error);
        }
    }

    static async reflectRoleToMember(interaction: ChatInputCommandInteraction, seatRoleId: string) {
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
            .add(nickname, seatRoleId)
            .then(() =>
            interaction.editReply(
                `${user.toString()}님에게 뉴비 롤을 부여했습니다.`,
            ),
            );
        } else if (subcommand === "remove") {
        void interaction.client.seatRoleEngine
            .remove(nickname, seatRoleId)
            .then(() =>
            interaction.editReply(
                `${user.toString()}님에게 뉴비 롤을 제거했습니다.`,
            ),
            );
        }
    }

    /*
     * 공지 메시지를 format 해서 반환합니다
     */
    static returnAnnouncementMsg() {
        /**
         * Nisuwa Cartel 안내 메시지
         */
        const joinCapSuperGroup = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("NIS 슈퍼/캐피탈")
        .setURL("https://forums.nisuwaz.com/t/topic/333");

        const joinChoboFCGroup = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("초보 FC")
        .setURL("https://forums.nisuwaz.com/t/gopw-fc/464");

        const joinMoonMiningGroup = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("문마이닝 그룹")
        .setURL("https://forums.nisuwaz.com/t/topic/945");

        const nisRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            joinCapSuperGroup,
            joinChoboFCGroup,
            joinMoonMiningGroup,
        );

        const nisMsg: MessageCreateOptions = {
        content: "Nisuwa Cartel에서는 원하는 활동에 따라 다양한 그룹을 운영하고 있습니다. 아래 버튼 중 하나를 클릭해서 SeAT 및 디스코드에서 그에 맞는 그룹에 들어가거나 신청 절차를 알아보실 수 있습니다. \n\n마지막 수정일: 2025/12/15",
        components: [nisRow],
        };
        
        /**
         * Nisuwa Cartel 인액티브 안내 메시지
         * TODO: 만들어봐?
         */
        // const nisInactiveMsg: MessageCreateOptions = {
        //     content: "왜 이 채널이 보이나요? \nNisuwa Cartel에서는 일정 기간 활동이 없는 멤버에게 인액티브(비활동) 롤을 부여하고 있습니다. 인액티브 롤이 부여된 멤버는 콥 채널 및 일부 중요 카테고리에 대한 접근 권한이 제한될 수 있습니다. \n\n어떻게 인액티브에서 벗어나나요? \n \n\n마지막 수정일: 2025/12/15",
        // };

        /** 
         * 리크룻 안내 메시지
        */
        const startRecruit = new ButtonBuilder()
            .setCustomId('RECRUIT_START_SESSION')
            .setStyle(ButtonStyle.Success)
            .setLabel("가입 시작");

        const startDaehwa = new ButtonBuilder()
            .setCustomId('RECRUIT_START_DAEHWA')
            .setStyle(ButtonStyle.Secondary)
            .setLabel("기타 문의");

        const recruitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            startRecruit,
            startDaehwa,
        );

        const recruitMsg: MessageCreateOptions = {
            content: "Nisuwaz / Nisuwa Dairy Union 가입 절차를 시작하시려면 하단 '가입 시작' 버튼을, 다른 용무나 가입 관련 질문은 '기타 문의' 버튼을 통해 진행해 주세요 \n\n마지막 수정일 2025/12/17",
            components: [recruitRow],
        };

        return { nisMsg, recruitMsg };
    }

    /**
     * 채널 아카이빙
     */
    static async archiveChannel(
        interaction: ChatInputCommandInteraction,
        targetChannel: TextChannel | VoiceChannel,
        actionName: string,
        action: "Copy" | "Move",
        ephemeral: boolean = false
    ) {
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId("yes")
                    .setLabel("예")
                    .setStyle(ButtonStyle.Success),
            )
            .addComponents(
                new ButtonBuilder()
                    .setCustomId("no")
                    .setLabel("아니요")
                    .setStyle(ButtonStyle.Danger),
            );

        const targetChannelName = `<#${targetChannel.id}> 채널`;
        let responseString = targetChannelName;
        
        const actionDescription = action === "Copy" 
            ? "아카이브하고 복사본을 만듭니다" 
            : "아카이브로 이동합니다";

        await interaction.reply({
            content: `정말 ${actionName}을(를) 하시겠습니까?\n${targetChannelName}을 ${actionDescription}.`,
            components: [row],
            ephemeral: ephemeral,
        });

        const filter: CollectorFilter<[MessageComponentInteraction<"cached">]> = (i) =>
            i.customId === "yes" || i.customId === "no";

        if (interaction.channel === null)
            throw Error("명령어 입력 채널을 찾을 수 없습니다.");
        if (!(interaction.channel instanceof TextChannel))
            throw Error("명령어 입력 채널은 텍스트 채널이어야 합니다.");

        let collected;
        try {
            collected = await interaction.channel.awaitMessageComponent({
                filter,
                time: 30000,
            });
        } catch (error) {
            await interaction.editReply({
                content: `${actionName} 확인 시간이 초과되었습니다. 다시 시도해주세요.`,
                components: [],
            });
            return;
        }

        await collected.update({
            content: responseString + ` ${actionName} 작업을 시작합니다...`,
            components: [],
        });

        if (collected.customId === "yes") {
            if (interaction.guild === null)
                throw Error("명령어 입력 길드를 찾을 수 없습니다.");

            const targetCategories = interaction.guild.channels.cache.filter(
                (c) =>
                    c.type === ChannelType.GuildCategory && c.name === "아카이브",
            );

            switch (targetCategories.size) {
                case 1:
                    // Copy: 복사본 생성 후 원본을 아카이브로 이동
                    if (action === "Copy") {
                        await targetChannel.clone();
                    }
                    
                    const today = new Date();
                    const year = today.getFullYear();
                    const month = ("0" + (today.getMonth() + 1)).slice(-2);
                    const day = ("0" + today.getDate()).slice(-2);

                    await targetChannel.setName(
                        targetChannel.name + "_" + year + "-" + month + "-" + day,
                    );

                    await targetChannel.setParent(
                        targetCategories.first()?.id as CategoryChannelResolvable,
                        { lockPermissions: true },
                    );

                    responseString += `의 ${actionName} 작업을 성공적으로 완료했습니다!`;
                    break;
                case 0:
                    throw Error("`아카이브` 라는 이름의 카테고리가 없습니다.");
                default:
                    throw Error(
                        "`아카이브` 라는 이름의 카테고리가 한 개가 아닙니다.",
                    );
            }
        } else {
            responseString += ` ${actionName} 작업을 취소했습니다.`;
        }

        await interaction.editReply({ content: responseString });
    }
}