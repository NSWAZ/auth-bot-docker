import { SeatHandler } from "./Handler";

/** The target member cannot be tied to exactly one SeAT account; no role is changed. */
export class SeatLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatLookupError";
  }
}

/**
 * SeatRoleEngine은 대상 멤버의 Discord 사용자 ID로 SeAT 계정을 찾아 롤을 부여하거나 제거합니다.
 * 계정은 SeAT Discord 커넥터의 연결로만 찾습니다(seat-custom-plugin의 discord-links 조회 API).
 * 닉네임·표시 이름은 멤버가 스스로 바꿀 수 있으므로 계정을 고르는 데 쓰지 않습니다.
 * 연결은 바뀔 수 있으므로 캐시하지 않고 매번 조회합니다.
 **/
export class SeatRoleEngine {
  /**
   * discordUserId에 연결된 SeAT 사용자 ID를 가져옵니다. 연결이 없거나 둘 이상이면 SeatLookupError.
   */
  async getSeatUserIdByDiscordId(discordUserId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(discordUserId))
      throw new SeatLookupError("Discord 사용자 ID 형식이 올바르지 않습니다.");

    const response = await SeatHandler.getDiscordLinks(discordUserId);
    const links = response?.data;
    // A missing or null list is a broken answer, not "no link": say so instead of blaming the member.
    if (!Array.isArray(links))
      throw new SeatLookupError(
        "SeAT 연결 조회 응답 형식이 올바르지 않아 계정을 정할 수 없습니다. 봇 관리자에게 알려 주세요.",
      );

    const linked = new Set<number>();
    for (const link of links) {
      const userId = (link as { user_id?: unknown } | null)?.user_id;
      // A link without a usable SeAT user ID (null, text, 0) must never pick an account.
      if (
        typeof userId !== "number" ||
        !Number.isSafeInteger(userId) ||
        userId < 1
      )
        throw new SeatLookupError(
          "SeAT 연결 조회 응답에 올바른 SeAT 사용자 ID가 없어 계정을 정할 수 없습니다. 봇 관리자에게 알려 주세요.",
        );
      linked.add(userId);
    }

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
