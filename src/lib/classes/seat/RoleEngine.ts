import { SeatHandler } from "./Handler";

// SeAT's connector list is paginated; stop at last_page, and never page without bound.
const MAX_CONNECTOR_PAGES = 200;

/** The target member cannot be tied to exactly one SeAT account; no role is changed. */
export class SeatLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatLookupError";
  }
}

/**
 * SeatRoleEngine은 대상 멤버의 Discord 사용자 ID로 SeAT 계정을 찾아 롤을 부여하거나 제거합니다.
 * 계정은 SeAT Discord 커넥터의 연결(connector_type "discord", connector_id = Discord 사용자 ID)로만 찾습니다.
 * 닉네임·표시 이름은 멤버가 스스로 바꿀 수 있으므로 계정을 고르는 데 쓰지 않습니다.
 * 연결은 바뀔 수 있으므로 캐시하지 않고 매번 조회합니다.
 **/
export class SeatRoleEngine {
  /** The whole connector lookup must finish within this, well inside Discord's 15-minute reply window. */
  static lookupDeadlineMs = 120_000;

  /**
   * discordUserId에 연결된 SeAT 사용자 ID를 가져옵니다. 연결이 없거나 둘 이상이면 SeatLookupError.
   */
  async getSeatUserIdByDiscordId(discordUserId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(discordUserId))
      throw new SeatLookupError("Discord 사용자 ID 형식이 올바르지 않습니다.");

    const linked = new Set<number>();
    let lastPage = 1;
    const deadline = Date.now() + SeatRoleEngine.lookupDeadlineMs;
    for (
      let page = 1;
      page <= lastPage && page <= MAX_CONNECTOR_PAGES;
      page++
    ) {
      if (Date.now() > deadline)
        throw new SeatLookupError(
          "SeAT 연결 목록을 제한 시간 안에 다 읽지 못해 계정을 정할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        );
      const response = await SeatHandler.getConnectorUsers(page);
      for (const link of response.data ?? []) {
        if (
          link.connector_type === "discord" &&
          String(link.connector_id) === discordUserId
        )
          linked.add(link.user_id);
      }
      const reported = Number(response.meta?.last_page ?? 1);
      lastPage = Number.isSafeInteger(reported) && reported > 0 ? reported : 1;
    }

    // Deciding on a partial list could miss a second linked account, so refuse instead.
    if (lastPage > MAX_CONNECTOR_PAGES)
      throw new SeatLookupError(
        `SeAT 연결 목록이 ${lastPage}쪽이라 끝까지 확인하지 못해 계정을 정할 수 없습니다. 봇 관리자에게 알려 주세요.`,
      );
    if (linked.size === 0)
      throw new SeatLookupError(
        "이 멤버의 Discord 계정과 연결된 SeAT 계정이 없습니다. SeAT에서 Discord 연결을 먼저 해 주세요.",
      );
    if (linked.size > 1)
      throw new SeatLookupError(
        `이 멤버의 Discord 계정이 SeAT 계정 ${linked.size}개와 연결되어 있어 하나로 정할 수 없습니다. SeAT 관리자에게 확인해 주세요.`,
      );
    return String([...linked][0]);
  }

  /**
   * discordUserId에 연결된 SeAT 계정에 roleId 롤을 부여합니다.
   */
  async add(discordUserId: string, roleId: string) {
    const seatUserId = await this.getSeatUserIdByDiscordId(discordUserId);
    await SeatHandler.addUserRole(seatUserId, roleId);
  }

  /**
   * discordUserId에 연결된 SeAT 계정에서 roleId 롤을 제거합니다.
   */
  async remove(discordUserId: string, roleId: string) {
    const seatUserId = await this.getSeatUserIdByDiscordId(discordUserId);
    await SeatHandler.removeUserRole(seatUserId, roleId);
  }
}
