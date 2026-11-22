import axios from "axios";
import log from "loglevel";

// axios의 기본 헤더를 제거하는 인터셉터 설정
axios.interceptors.request.use((config) => {
  // 기본 Accept 헤더 제거
  delete config.headers.Accept;
  return config;
});

const SEAT_API = "https://seat.nisuwaz.com/api/v2";
// Each SeAT call gives up after this; a timed-out lookup changes no role (SeatRequestError, "no response").
const SEAT_TIMEOUT_MS = 10_000;

/**
 * A failed SeAT request. It carries only the method, path and status: the axios error it
 * replaces holds the request config with the X-TOKEN header, so it is never kept or logged.
 */
export class SeatRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | null,
  ) {
    super(`SeAT ${method} ${path} failed (${status ?? "no response"})`);
    this.name = "SeatRequestError";
  }
}

export class SeatHandler {
  private static headers(kind: "get" | "post" | "delete") {
    if (process.env.SEAT_TOKEN === undefined)
      throw new Error("SEAT_TOKEN is not defined in .env file.");
    if (kind === "get")
      return { accept: "application/json", "X-TOKEN": process.env.SEAT_TOKEN };
    if (kind === "post")
      return {
        accept: "*/*",
        "Content-Type": "application/json",
        "X-TOKEN": process.env.SEAT_TOKEN,
      };
    return { accept: "*/*", "X-TOKEN": process.env.SEAT_TOKEN };
  }

  /** Every SeAT call goes through here: no redirects (the token stays on SeAT), sanitized errors. */
  private static async request<T>(
    method: "get" | "post" | "delete",
    path: string,
    data?: unknown,
  ): Promise<T> {
    try {
      const response = await axios.request<T>({
        method,
        url: `${SEAT_API}${path}`,
        data,
        headers: this.headers(method),
        maxRedirects: 0,
        timeout: SEAT_TIMEOUT_MS,
      });
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? (error.response?.status ?? null)
        : null;
      throw new SeatRequestError(
        method.toUpperCase(),
        `/api/v2${path.split("?")[0]}`,
        status,
      );
    }
  }

  /**
   * seatUserId에 해당하는 유저에게 seatRoleId 롤을 제거합니다.
   */
  static async removeUserRole(seatUserId: string, seatRoleId: string) {
    log.info(`removing role ${seatRoleId} from user ${seatUserId}`);
    await this.request(
      "delete",
      `/roles/members/${encodeURIComponent(seatUserId)}/${encodeURIComponent(seatRoleId)}`,
    );
  }

  /**
   * seatUserId에 해당하는 유저에게 seatRoleId 롤을 부여합니다.
   */
  static async addUserRole(seatUserId: string, seatRoleId: string) {
    log.info(`adding role ${seatRoleId} to user ${seatUserId}`);
    await this.request("post", "/roles/members", {
      user_id: seatUserId,
      role_id: seatRoleId,
    });
  }

  /**
   * SeAT Connector(seat-connector 플러그인)의 사용자↔커넥터 연결 목록 한 페이지를 가져옵니다.
   * GET /api/v2/seat-connector/users: user_id, connector_type("discord"), connector_id(Discord 사용자 ID)
   */
  static async getConnectorUsers(
    page = 1,
  ): Promise<APIGetSeatConnectorUsersResponse> {
    return this.request("get", `/seat-connector/users?page=${page}`);
  }

  /**
   * page에 해당하는 seat 유저들을 가져옵니다.
   */
  static async getUsers(page = 1): Promise<APIGetSeatUsersResponse> {
    return this.request("get", `/users?page=${page}`);
  }

  /**
   * characterId에 해당하는 캐릭터의 시트를 가져옵니다.
   */
  static async getCharacterSheetFromId(
    characterId: string,
  ): Promise<APIGetSeatCharacterSheetResponse> {
    return this.request(
      "get",
      `/character/sheet/${encodeURIComponent(characterId)}`,
    );
  }

  static async getUserFromId(userId: number): Promise<APIGetSeatUserResponse> {
    return this.request("get", `/users/${userId}`);
  }

  static async getCorpContracts(
    corpId: number,
    page: number,
  ): Promise<APIGetContractsResponse> {
    return this.request("get", `/corporation/contracts/${corpId}?page=${page}`);
  }
}

export interface SeatConnectorUser {
  user_id: number;
  connector_type: string;
  connector_id: string;
  connector_name?: string;
}

export interface APIGetSeatConnectorUsersResponse {
  data: SeatConnectorUser[];
  meta?: { current_page?: number; last_page?: number };
}

interface seatEntity {
  entity_id: number;
  name: string;
  category: string;
}

interface APIGetSeatUsersResponse {
  data: SeatUser[];
  links: {
    first: string;
    last: string;
    prev: string;
    next: string;
  };
  meta: {
    current_page: number;
    from: number;
    last_page: number;
    path: string;
    per_page: number;
    to: number;
    total: number;
  };
}

interface APIGetContractsResponse {
  data: SeatContract[];
  links: {
    first: string;
    last: string;
    prev: string;
    next: string;
  };
  meta: {
    current_page: number;
    from: number;
    last_page: number;
    path: string;
    per_page: number;
    to: number;
    total: number;
  };
}

interface SeatContract {
  contract_id: number;
  type: string;
  status: string;
  title: string;
  for_corporation: boolean;
  availability: string;
  date_issued: string;
  date_expired: string;
  date_accepted: string;
  days_to_complete: number;
  date_completed: string;
  price: number;
  reward: number;
  collateral: number;
  buyout: number;
  volume: number;
  issuer: seatEntity;
  assignee: seatEntity;
  acceptor: seatEntity;
  // TODO: add lines field
  // lines
}

interface APIGetSeatCharacterSheetResponse {
  data: SeatCharacterSheet;
}

interface APIGetSeatUserResponse {
  data: SeatUser;
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

interface SeatCharacterSheet {
  name: string;
  description: string;
  corporation?: {
    entity_id: number;
    name: string;
    category: "corporation";
  };
  alliance?: {
    entity_id: number;
    name: string;
    category: "alliance";
  };
  faction: {
    entity_id: null;
    name: string;
    category: "faction";
  };
  birthday: string;
  gender: string;
  race_id: number;
  bloodline_id: number;
  security_status: number;
  balance: number;
  skillpoints: {
    total_sp: number;
    unallocated_sp: number;
  };
  user_id: number;
}
