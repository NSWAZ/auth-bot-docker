import { SeatRequester } from './library/handlers/SeatRequester';
import { SeatUser } from './library/types';

export class SeatRoleApplier {
	private roleId: string;
	private seatRequester: SeatRequester = new SeatRequester();
	private seatUsersCache = new Map<string, SeatUser>();

	constructor() {
		this.roleId = '48';
	}

	/**
	 * mainCharacterName에 해당하는 seatUserId를 가져옵니다.
	 * @param {string} mainCharacterName
	 * @returns {Promise<string>}
	 */
	async getSeatUserId(mainCharacterName: string): Promise<string> {
		let user = this.seatUsersCache.get(mainCharacterName);
		let seatUserIndex = 1;

		while (user === undefined) {
			const seatUsers = (await this.seatRequester.getSeatUsers(seatUserIndex)).data;

			for (const seatUser of seatUsers) {
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
	 * seatUserId에 해당하는 유저에게 뉴비 롤을 부여합니다.
	 * @param {string} mainCharacterName
	 */
	async add(mainCharacterName: string) {
		const seatUserId = await this.getSeatUserId(mainCharacterName);
		await this.seatRequester.userRoleAdd(seatUserId, this.roleId);
	}

	/**
	 * seatUserId에 해당하는 유저에게 뉴비 롤을 제거합니다.
	 * @param {string} mainCharacterName
	 */
	async remove(mainCharacterName: string) {
		const seatUserId = await this.getSeatUserId(mainCharacterName);
		await this.seatRequester.userRoleRemove(seatUserId, this.roleId);
	}
}