// Who the applicant of a consultation is when /상담완료 runs: from the recruit state, the applicant's own
// permission overwrite, the authors of the channel's messages and the channel name, also for an applicant
// who left the server (2026-11-24: a month-old channel failed with eligible=0 and stayed undeleted).
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveApplicant } = require("../dist/lib/archive/ConsultationCollector");

const user = (id, username, extra = {}) => ({ id, username, globalName: null, bot: false, system: false, ...extra });
const member = (u, { recruiter = false, displayName } = {}) => ({
  id: u.id,
  displayName: displayName ?? u.username,
  user: u,
  roles: { cache: new Map(recruiter ? [["r", { id: "r", name: "리크루터" }]] : []) },
});
const message = (author, extra = {}) => ({ author, webhookId: null, ...extra });

const commanderUser = user("600", "commander");
const otherRecruiterUser = user("601", "otherrecruiter");
const botUser = user("900", "recruitbot", { bot: true });

/** A channel whose guild has `members` (left users are absent) and whose client knows `users`. */
function channelWith({ name = "applicant-recruit", members = [], users = [], overwrites = [] }) {
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const userMap = new Map([...users, ...members.map((m) => m.user)].map((u) => [u.id, u]));
  return {
    name,
    client: { users: { fetch: async (id) => { if (!userMap.has(id)) throw Object.assign(new Error("Unknown User"), { code: 10013 }); return userMap.get(id); } } },
    guild: { members: { fetch: async (id) => { if (!memberMap.has(id)) throw Object.assign(new Error("Unknown Member"), { code: 10007 }); return memberMap.get(id); } } },
    permissionOverwrites: {
      cache: new Map([
        ["100", { id: "100", type: 0 }],
        ["role-recruiter", { id: "role-recruiter", type: 0 }],
        ...overwrites.map((id) => [id, { id, type: 1 }]),
      ]),
    },
  };
}
const interaction = (picked = null) => ({
  user: commanderUser,
  options: { getUser: (name) => (name === "지원자" ? picked : null) },
});
const staff = [member(commanderUser, { recruiter: true }), member(otherRecruiterUser, { recruiter: true }), member(botUser)];

test("an applicant who left the server is found through their remaining overwrite and messages", async () => {
  const applicant = user("300", "gangseocan");
  const channel = channelWith({ members: staff, users: [applicant], overwrites: ["300"] });
  const found = await resolveApplicant(interaction(), channel, null, [message(botUser), message(applicant), message(commanderUser)]);
  assert.equal(found.id, "300");
  assert.equal(found.inGuild, false);
  assert.equal(found.displayName, "gangseocan");
  assert.deepEqual(found.evidence, ["permission", "messages"]);
});

test("with the overwrite gone, the one author who is not staff, a bot or the commander is the applicant", async () => {
  const applicant = user("300", "gangseocan", { globalName: "강서캔" });
  const channel = channelWith({ name: "gangseocan-recruit_2026-10-24", members: staff, users: [applicant] });
  const messages = [message(botUser), message(applicant), message(otherRecruiterUser), message(commanderUser), message(user("950", "hook"), { webhookId: "950" })];
  const found = await resolveApplicant(interaction(), channel, null, messages);
  assert.equal(found.id, "300");
  assert.equal(found.inGuild, false);
  assert.equal(found.displayName, "강서캔");
  assert.deepEqual(found.evidence, ["messages", "channel_name"]);
});

test("an applicant who has since become a recruiter is found only when the channel name names them", async () => {
  const applicantUser = user("300", "gangseocan");
  const applicant = member(applicantUser, { recruiter: true, displayName: "강서캔" });
  const messages = [message(botUser), message(applicantUser), message(commanderUser)];
  const named = channelWith({ name: "gangseocan-recruit_2026-10-24", members: [...staff, applicant], overwrites: ["300"] });
  const found = await resolveApplicant(interaction(), named, null, messages);
  assert.equal(found.id, "300");
  assert.equal(found.inGuild, true);
  assert.equal(found.displayName, "강서캔");
  assert.deepEqual(found.evidence, ["permission", "messages", "channel_name"]);

  const unnamed = channelWith({ name: "someone-recruit", members: [...staff, applicant], overwrites: ["300"] });
  await assert.rejects(resolveApplicant(interaction(), unnamed, null, messages), (error) => {
    assert.equal(error.name, "ArchiveError");
    assert.equal(error.kind, "collection");
    assert.match(error.message, /지원자를 찾지 못했습니다/);
    assert.match(error.message, /강서캔\(300, 리크루터\)/);
    assert.match(error.message, /지원자:/);
    return true;
  });
});

test("several candidates are narrowed by messages and the channel name, and otherwise named in the failure", async () => {
  const a = user("300", "alpha");
  const b = user("301", "bravo");
  const both = channelWith({ name: "alpha-recruit", members: [...staff, member(b)], users: [a], overwrites: ["300", "301"] });
  // Two overwrites, but only one of them talked.
  assert.equal((await resolveApplicant(interaction(), both, null, [message(a), message(commanderUser)])).id, "300");

  // Two departed authors, no overwrite, and the channel name matches neither.
  const ambiguous = channelWith({ name: "charlie-recruit", members: staff, users: [a, b] });
  await assert.rejects(resolveApplicant(interaction(), ambiguous, null, [message(a), message(b), message(commanderUser)]), (error) => {
    assert.equal(error.kind, "collection");
    assert.match(error.message, /후보 2명/);
    assert.match(error.message, /alpha\(300, 대화·서버 나감\)/);
    assert.match(error.message, /bravo\(301, 대화·서버 나감\)/);
    assert.match(error.message, /지원자:/);
    return true;
  });

  // Two overwrites that both talked stay ambiguous.
  await assert.rejects(resolveApplicant(interaction(), channelWith({ name: "x-recruit", members: [...staff, member(b)], users: [a], overwrites: ["300", "301"] }), null, [message(a), message(b)]), /후보 2명/);
});

test("nobody left to choose from fails closed with the excluded people named", async () => {
  const channel = channelWith({ members: staff });
  await assert.rejects(resolveApplicant(interaction(), channel, null, [message(botUser), message(commanderUser), message(otherRecruiterUser)]), (error) => {
    assert.equal(error.kind, "collection");
    assert.match(error.message, /지원자를 찾지 못했습니다/);
    assert.match(error.message, /otherrecruiter\(601, 리크루터\)/);
    return true;
  });
});

test("the recruit state names the applicant, even one who left the server", async () => {
  const applicant = user("301", "stated");
  const channel = channelWith({ members: staff, users: [applicant], overwrites: ["300"] });
  const found = await resolveApplicant(interaction(), channel, { context: { applicantDiscordId: "301" } }, [message(commanderUser)]);
  assert.equal(found.id, "301");
  assert.equal(found.inGuild, false);
  assert.deepEqual(found.evidence, ["state"]);
  // A bot or an unknown user in the state is refused.
  await assert.rejects(resolveApplicant(interaction(), channel, { context: { applicantDiscordId: "900" } }, []), /지원자 정보/);
  await assert.rejects(resolveApplicant(interaction(), channel, { context: { applicantDiscordId: "999" } }, []), /지원자 정보/);
});

test("the 지원자 option picks among the people of this channel only", async () => {
  const a = user("300", "alpha");
  const b = user("301", "bravo");
  const channel = channelWith({ name: "charlie-recruit", members: staff, users: [a, b, user("302", "stranger")] });
  const messages = [message(a), message(b), message(commanderUser)];
  const picked = await resolveApplicant(interaction(b), channel, null, messages);
  assert.equal(picked.id, "301");
  assert.deepEqual(picked.evidence, ["option", "messages"]);
  // Someone who neither has an overwrite here nor wrote in the channel, a bot, or the commander is refused.
  await assert.rejects(resolveApplicant(interaction(user("302", "stranger")), channel, null, messages), /이 채널에 권한도 대화 기록도 없습니다/);
  await assert.rejects(resolveApplicant(interaction(botUser), channel, null, [...messages, message(botUser)]), /봇/);
  await assert.rejects(resolveApplicant(interaction(commanderUser), channel, null, messages), /명령을 실행한 사람/);
  // An option that disagrees with the recruit state is refused rather than silently ignored.
  await assert.rejects(resolveApplicant(interaction(b), channel, { context: { applicantDiscordId: "300" } }, messages), /상담 상태의 지원자/);
});

test("the failure reply keeps a long candidate list and the /상담완료 command offers the 지원자 option", () => {
  const { archiveFailureMessage } = require("../dist/lib/classes/DiscordHandler");
  const { ArchiveError } = require("../dist/lib/archive/errors");
  const reason = `지원자를 한 명으로 정할 수 없습니다. 후보 5명: ${Array.from({ length: 5 }, (_, i) => `후보이름${"가".repeat(30)}${i}(30000000000000000${i}, 대화·서버 나감)`).join(", ")}. \`/상담완료 지원자:\`로 지원자를 직접 지정해 주세요.`;
  assert.ok(reason.length > 300);
  const text = archiveFailureMessage("<#1> 채널", new ArchiveError("collection", reason));
  assert.ok(text.endsWith("직접 지정해 주세요."), text);
  assert.ok(text.length < 2000);

  const command = require("../dist/commands/finish_talk").default.command.toJSON();
  const option = command.options.find((o) => o.name === "지원자");
  assert.equal(option.type, 6); // USER
  assert.equal(option.required, false);
});

test("a departed author alone, an unreadable overwrite or a failing Discord lookup never picks anyone", async () => {
  const gone = user("300", "gangseocan");
  // Only someone who left talked and the channel name is not theirs: a recruiter who left looks the same.
  const silent = channelWith({ name: "someoneelse-recruit", members: staff, users: [gone] });
  await assert.rejects(resolveApplicant(interaction(), silent, null, [message(gone), message(commanderUser)]), (error) => {
    assert.equal(error.kind, "collection");
    assert.match(error.message, /지원자인지 리크루터인지 알 수 없습니다/);
    assert.match(error.message, /gangseocan\(300, 대화·서버 나감\)/);
    return true;
  });

  // An overwrite for an account Discord no longer knows may be the applicant's: someone else who talked is not picked.
  const other = user("301", "bravo");
  const unreadable = channelWith({ name: "bravo-recruit", members: [...staff, member(other)], overwrites: ["399"] });
  await assert.rejects(resolveApplicant(interaction(), unreadable, null, [message(other)]), (error) => {
    assert.equal(error.kind, "collection");
    assert.match(error.message, /확인할 수 없는 사람이 있어/);
    assert.match(error.message, /399/);
    return true;
  });

  // A transient failure (429) is not "left the server": the archive stops instead.
  const flaky = channelWith({ members: staff, users: [gone], overwrites: ["300"] });
  flaky.guild.members.fetch = async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); };
  await assert.rejects(resolveApplicant(interaction(), flaky, null, [message(gone)]), (error) => {
    assert.equal(error.kind, "collection");
    assert.match(error.message, /참가자 정보를 읽지 못했습니다/);
    return true;
  });
});
