// /newbie and /inactive pick the SeAT account by the target member's Discord user ID (through
// the SeAT Discord connector mapping), never by nickname, and SeAT failures never log X-TOKEN.
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

process.env.SEAT_TOKEN = "seat-token-do-not-leak";
const { SeatRoleEngine, SeatLookupError } = require("../dist/lib/classes/seat/RoleEngine");
const { SeatHandler } = require("../dist/lib/classes/seat/Handler");
const { DiscordHandler } = require("../dist/lib/classes/DiscordHandler");

// Victim: SeAT user 7, Discord 111, main character "Victim Main". Attacker: SeAT user 9, Discord 222.
const connectorPages = {
  1: { data: [{ user_id: 7, connector_type: "discord", connector_id: "111", connector_name: "Victim Main" }, { user_id: 8, connector_type: "teamspeak", connector_id: "222", connector_name: "x" }], meta: { current_page: 1, last_page: 2 } },
  2: { data: [{ user_id: 9, connector_type: "discord", connector_id: "222", connector_name: "Attacker Main" }], meta: { current_page: 2, last_page: 2 } },
};

function fakeSeat({ pages = connectorPages, fail } = {}) {
  const calls = [];
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url);
    calls.push({ method: config.method, path: url.pathname, search: url.search, data: config.data, maxRedirects: config.maxRedirects });
    if (fail) {
      throw new axios.AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, null, { status: 500, statusText: "x", headers: {}, config, data: {} });
    }
    if (url.pathname === "/api/v2/seat-connector/users") {
      const page = pages[url.searchParams.get("page")] ?? { data: [], meta: { last_page: 1 } };
      return { data: page, status: 200, statusText: "OK", headers: {}, config };
    }
    return { data: {}, status: 200, statusText: "OK", headers: {}, config };
  };
  return calls;
}
const roleWrites = (calls) => calls.filter((c) => c.method !== "get");

test("the role goes to the SeAT account linked to the target's Discord ID", async () => {
  const calls = fakeSeat();
  await new SeatRoleEngine().add("222", "48");
  assert.deepEqual(roleWrites(calls).map((c) => [c.method, c.path, JSON.parse(c.data)]), [["post", "/api/v2/roles/members", { user_id: "9", role_id: "48" }]]);
  assert.deepEqual(calls.filter((c) => c.method === "get").map((c) => c.search), ["?page=1", "?page=2"]);
  assert.ok(calls.every((c) => c.maxRedirects === 0), "the X-TOKEN is never sent on to a redirect");
  const removeCalls = fakeSeat();
  await new SeatRoleEngine().remove("111", "52");
  assert.deepEqual(roleWrites(removeCalls).map((c) => [c.method, c.path]), [["delete", "/api/v2/roles/members/7/52"]]);
});

test("regression: a member who takes another pilot's main name as nickname cannot move the victim's role", async () => {
  const calls = fakeSeat();
  const replies = [];
  const attacker = { id: "222", username: "attacker", toString: () => "<@222>" };
  const interaction = {
    commandName: "newbie",
    deferReply: async () => {},
    editReply: async (content) => replies.push(content),
    options: { getSubcommand: () => "add", getUser: () => attacker },
    guild: { members: { cache: new Map([["222", { nickname: "Victim Main", displayName: "Victim Main", user: attacker }]]) } },
    client: { seatRoleEngine: new SeatRoleEngine() },
  };
  await DiscordHandler.reflectRoleToMember(interaction, "48");
  const writes = roleWrites(calls);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].data).user_id, "9", "attacker's own account, not the victim's (7)");
});

test("no linked account, or more than one, refuses without changing any role and tells the admin why", async () => {
  for (const [pages, reason] of [
    [{ 1: { data: [], meta: { last_page: 1 } } }, /연결된 SeAT 계정이 없습니다/],
    [{ 1: { data: [{ user_id: 7, connector_type: "discord", connector_id: "333" }, { user_id: 8, connector_type: "discord", connector_id: "333" }], meta: { last_page: 1 } } }, /2개/],
  ]) {
    const calls = fakeSeat({ pages });
    await assert.rejects(new SeatRoleEngine().add("333", "48"), (error) => error instanceof SeatLookupError && reason.test(error.message));
    assert.equal(roleWrites(calls).length, 0);

    const replies = [];
    const user = { id: "333", username: "u", toString: () => "<@333>" };
    await DiscordHandler.reflectRoleToMember({
      commandName: "inactive", deferReply: async () => {}, editReply: async (content) => replies.push(content),
      options: { getSubcommand: () => "remove", getUser: () => user },
      guild: { members: { cache: new Map([["333", { nickname: "Someone", user }]]) } },
      client: { seatRoleEngine: new SeatRoleEngine() },
    }, "52");
    assert.equal(roleWrites(calls).length, 0);
    assert.match(String(replies.at(-1)), /바꾸지 않았습니다/);
  }
});

test("connector paging stops at last_page even if SeAT keeps answering", async () => {
  const endless = new Proxy({}, { get: (_t, page) => ({ data: [], meta: { current_page: Number(page), last_page: 3 } }) });
  const calls = fakeSeat({ pages: endless });
  await assert.rejects(new SeatRoleEngine().add("444", "48"), SeatLookupError);
  assert.equal(calls.length, 3);
});

test("a failed SeAT request reports method, path and status, never the X-TOKEN", async () => {
  fakeSeat({ fail: true });
  const error = await SeatHandler.addUserRole("9", "48").catch((e) => e);
  assert.match(error.message, /POST \/api\/v2\/roles\/members.*500/);
  const dump = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error.stack) + String(error.cause ?? "");
  assert.ok(!dump.includes("seat-token-do-not-leak"));
  assert.equal(error.config, undefined);
});

test("more connector pages than the cap refuses instead of deciding on a partial list", async () => {
  const endless = new Proxy({}, { get: (_t, page) => ({ data: Number(page) === 1 ? [{ user_id: 9, connector_type: "discord", connector_id: "222" }] : [], meta: { current_page: Number(page), last_page: 250 } }) });
  const calls = fakeSeat({ pages: endless });
  await assert.rejects(new SeatRoleEngine().add("222", "48"), (error) => error instanceof SeatLookupError && /끝까지 확인하지 못해/.test(error.message));
  assert.equal(roleWrites(calls).length, 0);
});

test("a failed SeAT request tells the admin the role was not changed and why, without the token", async () => {
  fakeSeat({ fail: true });
  const replies = [];
  const user = { id: "222", username: "u", toString: () => "<@222>" };
  await DiscordHandler.reflectRoleToMember({
    commandName: "newbie", deferReply: async () => {}, editReply: async (content) => replies.push(content),
    options: { getSubcommand: () => "add", getUser: () => user },
    guild: { members: { cache: new Map([["222", { user }]]) } },
    client: { seatRoleEngine: new SeatRoleEngine() },
  }, "48");
  assert.match(String(replies.at(-1)), /바꾸지 않았습니다.*SeAT.*500/);
  assert.ok(!String(replies.at(-1)).includes("seat-token-do-not-leak"));
});

test("SeAT requests have a time limit; a timed-out lookup changes no role", async () => {
  const seen = [];
  axios.defaults.adapter = async (config) => {
    seen.push({ method: config.method, timeout: config.timeout });
    throw new axios.AxiosError("timeout of 10000ms exceeded", "ECONNABORTED", config);
  };
  const replies = [];
  const user = { id: "222", username: "u", toString: () => "<@222>" };
  await DiscordHandler.reflectRoleToMember({
    commandName: "newbie", deferReply: async () => {}, editReply: async (content) => replies.push(content),
    options: { getSubcommand: () => "add", getUser: () => user },
    guild: { members: { cache: new Map([["222", { user }]]) } },
    client: { seatRoleEngine: new SeatRoleEngine() },
  }, "48");
  assert.ok(seen.length > 0 && seen.every((c) => c.timeout === 10000), JSON.stringify(seen));
  assert.ok(seen.every((c) => c.method === "get"), "no role write after a timed-out lookup");
  assert.match(String(replies.at(-1)), /바꾸지 않았습니다.*no response/);
});

test("the whole connector lookup has a time limit; past it no role changes", async () => {
  const calls = fakeSeat({ pages: new Proxy({}, { get: (_t, page) => ({ data: [], meta: { current_page: Number(page), last_page: 50 } }) }) });
  const slow = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => { await new Promise((r) => setTimeout(r, 15)); return slow(config); };
  const previous = SeatRoleEngine.lookupDeadlineMs;
  SeatRoleEngine.lookupDeadlineMs = 40;
  try {
    await assert.rejects(new SeatRoleEngine().add("222", "48"), (error) => error instanceof SeatLookupError && /제한 시간/.test(error.message));
  } finally { SeatRoleEngine.lookupDeadlineMs = previous; }
  assert.ok(calls.length < 50, `stopped early after ${calls.length} pages`);
  assert.equal(roleWrites(calls).length, 0);
});
