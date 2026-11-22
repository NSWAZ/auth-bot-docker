import { DiscordHandler } from "../lib/classes/DiscordHandler";

const announcementMessages = DiscordHandler.returnAnnouncementMsg();

export const announcementData = {
  nis: {
    guildType: "nis" as const,
    channelName: "안내",
    msg: announcementMessages.nisMsg,
  },
  recruit: {
    guildType: "recruit" as const,
    channelName: "가입-안내",
    msg: announcementMessages.recruitMsg,
  },
};

export const terms = {
  0: {
    message:
      "1. 저희 코퍼레이션은 수평적이고 자유로운 소통을 위해 **반말 사용을 기본**으로 합니다. (물론 존댓말이 편하시다면 사용하셔도 무방합니다.)",
    type: "반말 사용",
  },
  1: {
    message:
      "2. 또한 PvP를 지향하는 전투 그룹입니다. 꼽의 방향성에 맞춰 **최소한의 PvP 활동에 참여**하셔야 합니다.",
    type: "최소한의 PvP 활동",
  },
};

export const recruiterChannelNames = {
  NIS: "리크루터-working",
  NIDU: "웜홀-해병트럭",
};

export const recruiterRoleNames = {
  NIS: "리크루터",
  NIDU: "NIDU 리크루터",
};

export const stateBackupChannelName = "states-backup";

// The ban list is operational data about third parties and is not kept in the repository.
// It is read from BAN_LIST_FILE (see src/lib/banList.ts and ban-list.example.json).
