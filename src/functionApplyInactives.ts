import { Client, TextChannel, ChannelType, GuildChannel, CategoryChannel, PermissionFlagsBits } from "discord.js";
import log from "loglevel";

    // 권한 설정 함수
async function setChannelPermissions(channel: CategoryChannel | GuildChannel, memberIds: string[]) {
  // 채널이 카테고리인 경우
  log.debug(`Set permissions for `+ (channel.type === ChannelType.GuildCategory ? "category" : "channel") + ` ${channel.name} (${channel.id})`);
  
  // 현재 권한 오버라이드 가져오기 (멤버 타입 제외)
  const currentOverwrites = channel.permissionOverwrites.cache.filter(overwrite => 
    overwrite.type !== 1 // 1은 멤버 타입
  );
  
  // 새로운 권한 오버라이드 생성
  const newOverwrites = memberIds.map(memberId => ({
    id: memberId,
    type: 1, // 1은 멤버 타입
    deny: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages
    ]
  }));

  // 기존 권한과 새로운 권한 병합
  const finalOverwrites = [...currentOverwrites.values(), ...newOverwrites];
  
  // 한 번에 모든 권한 설정
  if (channel.type === ChannelType.GuildCategory) {
    await channel.edit({ 
      permissionOverwrites: finalOverwrites,
      lockPermissions: true
    });
  } else {
    await channel.permissionOverwrites.set(finalOverwrites);
  }
}
export async function checkInactives(client: Client) {
  log.info("Checking inactives...");
  try {
    // Nisuwa Cartel 길드 ID
    const guild = await client.guilds.fetch("337276039858356224");
    const members = await guild.members.fetch();
    
    // 인액티브 롤을 가진 멤버만 필터링
    const inactiveMembers = members.filter(member => 
      member.roles.cache.has("824637601091682353")
    );

    log.info(`Found ${inactiveMembers.size} inactive members :`);
    
    // 각 인액티브 멤버의 정보 출력
    let inactiveMembersString = "";
    let inactiveMemberIds: string[] = [];
    inactiveMembers.forEach(member => {
      inactiveMembersString += `${member.user.tag} (${member.id})`;
      inactiveMemberIds.push(member.id);
    });
    log.info(inactiveMembersString);

    // 채널 메시지 가져오기
    const channel = await client.channels.fetch("1373646420397260914") as TextChannel;
    if (!channel) {
      throw new Error("Channel not found");
    }

    // 최대 100개의 메시지를 가져옵니다
    const messages = await channel.messages.fetch({ limit: 100 });
    log.info(`Found ${messages.size} messages in channel`);

    // 메시지에서 채널/카테고리 ID 추출 및 권한 설정
    for (const message of messages.values()) {
      const content = message.content;
      const channelMatches = content.match(/<#(\d+)>/g);
      const categoryMatches = content.match(/CT:([^:\n]+)/g);

      if (channelMatches) {
        const match = channelMatches[0];
        const channelId = match.match(/\d+/)?.[0];
        if (!channelId)
          throw new Error("Channel ID not found");

        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText)
          throw new Error("Channel not found");
      
        log.info(`Processing channel: ${channel.name}`);
        
        await setChannelPermissions(channel, inactiveMemberIds);
      }
      else if (categoryMatches) {
        const match = categoryMatches[0];
        const categoryName = match.replace('CT:', '').trim();
        log.info(`Processing category: ${categoryName}`);
        
        const category = guild.channels.cache.find(
          ch => ch.type === ChannelType.GuildCategory && ch.name === categoryName
        );
        
        await setChannelPermissions(category as CategoryChannel, inactiveMemberIds);
      }
    }

    log.info("Inactive check completed");
  } catch (error) {
    log.error("Error checking inactives:", error);
  }
}