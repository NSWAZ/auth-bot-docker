import { SeatHandler } from "./Handler";

/**
 * SeatRoleEngine은 SeatHandler를 사용하여 유저에게 롤을 부여하거나 제거하는 엔진입니다.
 * 이 엔진은 유저의 이름을 키로 사용하여 유저를 캐시하고, 캐시에 없는 유저의 경우 SeatHandler를 사용하여 유저를 조회합니다.
 * NOTE: SeAT 에서 User가 절대 삭제되지 않는다는 가정 하에 만들어졌습니다.
 **/
export class SeatRoleEngine {
  private seatUsersCache = new Map<string, SeatUser>();

  /**
   * mainCharacterName에 해당하는 seatUserId를 가져옵니다.
   * @param {string} mainCharacterName
   * @returns {Promise<string>}
   */
  async getSeatUserId(mainCharacterName: string): Promise<string> {
    let user = this.seatUsersCache.get(mainCharacterName);
    let seatUserIndex = 1;

    while (user === undefined) {
      const seatUsers = await SeatHandler.getUsers(seatUserIndex);

      for (const seatUser of seatUsers.data) {
        this.seatUsersCache.set(seatUser.name, seatUser);

        if (seatUser.name === mainCharacterName) {
          user = seatUser;
        }
      }

      seatUserIndex++;
    }

    return user.id.toString();
  }

  /**
   * mainCharacterName에 해당하는 유저에게 뉴비 롤을 부여합니다.
   * @param {string} mainCharacterName
   * @param {string} roleId
   */
  async add(mainCharacterName: string, roleId: string) {
    const seatUserId = await this.getSeatUserId(mainCharacterName);
    await SeatHandler.addUserRole(seatUserId, roleId);
  }

  /**
   * mainCharacterName에 해당하는 roleId에 해당하는 롤을 제거합니다.
   * @param {string} mainCharacterName
   * @param {string} roleId
   */
  async remove(mainCharacterName: string, roleId: string) {
    const seatUserId = await this.getSeatUserId(mainCharacterName);
    await SeatHandler.removeUserRole(seatUserId, roleId);
  }
}

interface SeatUser {
  id: number;
  name: string;
  email: string;
  active: boolean;
  last_login: string;
  last_login_source: string;
  associated_character_ids: string[];
  main_character_id: string;
}
