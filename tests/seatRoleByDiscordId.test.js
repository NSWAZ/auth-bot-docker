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
// The custom-plugin lookup answers only the links of the asked Discord ID.
const LINK_PATH = "/api/v2/custom-plugin/discord-links";
const defaultLinks = { 111: [{ user_id: 7 }], 222: [{ user_id: 9 }] };

function fakeSeat({ links = defaultLinks, fail, body } = {}) {
  const calls = [];
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url);
    calls.push({ method: config.method, path: url.pathname, search: url.search, data: config.data, maxRedirects: config.maxRedirects });
    if (fail) {
      throw new axios.AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, null, { status: 500, statusText: "x", headers: {}, config, data: {} });
    }
    if (url.pathname === LINK_PATH) {
      const data = body !== undefined ? body : { data: links[url.searchParams.get("discord_id")] ?? [] };
      return { data, status: 200, statusText: "OK", headers: {}, config };
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
  assert.deepEqual(calls.filter((c) => c.method === "get").map((c) => [c.path, c.search]), [[LINK_PATH, "?discord_id=222"]], "one lookup for the target's Discord ID only");
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
  for (const [links, reason] of [
    [{}, /연결된 SeAT 계정이 없습니다/],
    [{ 333: [{ user_id: 7 }, { user_id: 8 }] }, /2개/],
  ]) {
    const calls = fakeSeat({ links });
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

test("a failed SeAT request reports method, path and status, never the X-TOKEN", async () => {
  fakeSeat({ fail: true });
  const error = await SeatHandler.addUserRole("9", "48").catch((e) => e);
  assert.match(error.message, /POST \/api\/v2\/roles\/members.*500/);
  const dump = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error.stack) + String(error.cause ?? "");
  assert.ok(!dump.includes("seat-token-do-not-leak"));
  assert.equal(error.config, undefined);
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

test("regression: links without a usable SeAT user ID (null, text, zero) refuse instead of writing a role", async () => {
  // seat-connector 3.1.2 answered every link with user_id null; that must never become a role write.
  for (const body of [
    { data: [{ user_id: null }] },
    { data: [{ user_id: "7" }] },
    { data: [{ user_id: 0 }] },
    { data: [{ user_id: 7.5 }] },
    { data: [null] },
  ]) {
    const calls = fakeSeat({ body });
    await assert.rejects(new SeatRoleEngine().add("111", "48"), (error) => error instanceof SeatLookupError && /올바른 SeAT 사용자 ID가 없어/.test(error.message), JSON.stringify(body));
    assert.equal(roleWrites(calls).length, 0, JSON.stringify(body));
  }
});

test("regression: an answer without a link list is a broken answer, not 'no linked account'", async () => {
  // Telling the admin "link Discord in SeAT first" for a broken API answer would send them the wrong way.
  for (const body of [{ data: null }, {}, { data: "x" }, { data: { user_id: 7 } }, "<!doctype html>", null]) {
    const calls = fakeSeat({ body });
    await assert.rejects(
      new SeatRoleEngine().add("111", "48"),
      (error) => error instanceof SeatLookupError && /응답 형식이 올바르지 않아/.test(error.message) && !/연결된 SeAT 계정이 없습니다/.test(error.message),
      JSON.stringify(body),
    );
    assert.equal(roleWrites(calls).length, 0, JSON.stringify(body));
  }
});

test("the lookup carries the SeAT token in X-TOKEN, never in the URL", async () => {
  const seen = [];
  axios.defaults.adapter = async (config) => {
    seen.push({ url: config.url, token: config.headers["X-TOKEN"] });
    return { data: { data: [{ user_id: 9 }] }, status: 200, statusText: "OK", headers: {}, config };
  };
  assert.equal(await new SeatRoleEngine().getSeatUserIdByDiscordId("222"), "9");
  assert.deepEqual(seen, [{ url: "https://seat.nisuwaz.com/api/v2/custom-plugin/discord-links?discord_id=222", token: "seat-token-do-not-leak" }]);
});

test("the same SeAT user listed twice for one Discord ID is still one account", async () => {
  const calls = fakeSeat({ links: { 111: [{ user_id: 7 }, { user_id: 7 }] } });
  await new SeatRoleEngine().add("111", "48");
  assert.deepEqual(roleWrites(calls).map((c) => JSON.parse(c.data).user_id), ["7"]);
});

test("a malformed Discord ID is refused before any SeAT request", async () => {
  for (const id of ["", "12a", "1".repeat(21), "1&discord_id=2"]) {
    const calls = fakeSeat();
    await assert.rejects(new SeatRoleEngine().add(id, "48"), SeatLookupError);
    assert.equal(calls.length, 0, id);
  }
});
