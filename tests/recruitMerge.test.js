// Behaviour added when the recruit bot was merged back into auth-bot v4:
// /상담완료 deletes the channel only after a verified archive, announcements replace only the
// bot's own message, state backups are trusted only from this bot, and the ban list is external.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { archiveVerifyThenMutate } = require("../dist/lib/archive/ArchiveWorkflow");
const { ArchiveError, MutationError } = require("../dist/lib/archive/errors");
const {
  deleteArchivedConsultation, countUnarchivedHumanMessages, consultationDeletionNotice, syncAnnouncement, archiveFailureMessage,
} = require("../dist/lib/classes/DiscordHandler");
const { isOwnBackupMessage, isRestorableChannel } = require("../dist/lib/classes/recruit/StateBackup");
const { StateMachineHandler } = require("../dist/lib/classes/recruit/StateMachineHandler");
const { parseBanList, loadBanList, findBanMatches } = require("../dist/lib/banList");

const collection = (items) => ({ size: items.length, first: () => items[0], values: function* () { yield* items; } });
const human = (id) => ({ id, author: { id: "300", bot: false }, content: `human ${id}` });
const botMessage = (id, content = "bot") => ({ id, author: { id: "999", bot: true }, content, deleted: false, async delete() { this.deleted = true; } });

function consultationChannel({ after = [], fetchFails = false, deleteFails = false } = {}) {
  const events = [];
  return {
    events, id: "200", name: "alice-recruit",
    messages: { fetch: async (options) => { events.push(`fetch:after=${options.after}`); if (fetchFails) throw new Error("history"); return collection(options.after === "401" ? after : []); } },
    delete: async () => { events.push("delete"); if (deleteFails) throw new Error("Missing Permissions"); },
  };
}
function recruiter(events) {
  return { user: { id: "600", send: async (text) => events.push(`dm:${text}`) }, editReply: async ({ content }) => events.push(`reply:${content}`) };
}
/** The recruiters' channel (리크루터-working) where the completion notice goes instead of a DM. */
function noticeChannel(events, { fails = false } = {}) {
  return { send: async (message) => { events.push(`notice:${message.content}|mentions:${JSON.stringify(message.allowedMentions)}`); if (fails) throw new Error("Missing Access"); } };
}
const verified = { archive_id: "archive-1", cutoff_message_id: "401" };

test("verified archive: the recruiter is told how many unarchived human messages go with the channel, then it is deleted", async () => {
  const channel = consultationChannel({ after: [human("402"), botMessage("403"), human("404")] });
  await deleteArchivedConsultation(recruiter(channel.events), channel, verified, () => noticeChannel(channel.events));
  const notice = consultationDeletionNotice("alice-recruit", "archive-1", 2);
  assert.match(notice, /새 메시지 2개/);
  // No DM: the notice goes to the recruiters' channel, naming who completed it without pinging anyone.
  assert.deepEqual(channel.events, ["fetch:after=401", `reply:${notice}`, `notice:${notice} (처리: <@600>)|mentions:{"parse":[]}`, "delete"]);
  assert.ok(!notice.includes("human 402"), "message content is never repeated");
});

test("without a reachable recruiters' channel nobody is DMed and the channel is still deleted", async () => {
  const missing = consultationChannel();
  await deleteArchivedConsultation(recruiter(missing.events), missing, verified, () => null);
  assert.ok(!missing.events.some((e) => e.startsWith("dm:")));
  assert.equal(missing.events.at(-1), "delete");
  const failing = consultationChannel();
  await deleteArchivedConsultation(recruiter(failing.events), failing, verified, () => noticeChannel(failing.events, { fails: true }));
  assert.ok(!failing.events.some((e) => e.startsWith("dm:")));
  assert.equal(failing.events.at(-1), "delete");
  // Even a lookup that throws does not stop the deletion.
  const throwing = consultationChannel();
  await deleteArchivedConsultation(recruiter(throwing.events), throwing, verified, () => { throw new Error("cache"); });
  assert.equal(throwing.events.at(-1), "delete");
});

test("with nothing after the cutoff the notice does not mention lost messages", async () => {
  const channel = consultationChannel();
  await deleteArchivedConsultation(recruiter(channel.events), channel, verified, () => noticeChannel(channel.events));
  assert.ok(!channel.events[1].includes("새 메시지"));
  assert.equal(channel.events.at(-1), "delete");
});

test("a failed notice or reply does not stop the deletion; a failed count or delete is a MutationError with the channel left", async () => {
  const channel = consultationChannel();
  await deleteArchivedConsultation({ user: { id: "600" }, editReply: async () => { throw new Error("gone"); } }, channel, verified, () => noticeChannel(channel.events, { fails: true }));
  assert.equal(channel.events.at(-1), "delete");

  const counting = consultationChannel({ fetchFails: true });
  await assert.rejects(deleteArchivedConsultation(recruiter(counting.events), counting, verified, () => null), /지우지 않았습니다/);
  assert.ok(!counting.events.includes("delete"));

  const deleting = consultationChannel({ deleteFails: true });
  await assert.rejects(deleteArchivedConsultation(recruiter(deleting.events), deleting, verified, () => null), /채널 삭제에 실패/);
  assert.match(archiveFailureMessage("#x", new MutationError("채널 삭제에 실패했습니다.")), /채널은 남아 있습니다/);
});

test("no channel deletion on any archive failure", async () => {
  const failing = [
    { collect: async () => { throw new Error("history"); }, client: {} },
    { collect: async () => ({}), client: { submit: async () => { throw new ArchiveError("timeout", "POST"); } } },
    { collect: async () => ({}), client: { submit: async () => { throw new ArchiveError("conflict", "409"); }, getByChannel: async () => { throw new ArchiveError("not_found", "404"); } } },
  ];
  for (const dependencies of failing) {
    const channel = consultationChannel();
    await assert.rejects(archiveVerifyThenMutate({}, channel, dependencies, (archive) => deleteArchivedConsultation(recruiter(channel.events), channel, archive, () => null)), (error) => error instanceof ArchiveError);
    assert.deepEqual(channel.events, []);
  }
});

test("unarchived message count follows the after-cursor across pages", async () => {
  const pages = { "401": Array.from({ length: 100 }, (_, i) => human(String(1000 + i))), "1099": [human("1100"), botMessage("1101")] };
  const seen = [];
  const count = await countUnarchivedHumanMessages({ messages: { fetch: async ({ after, limit }) => { seen.push(`${after}/${limit}`); return collection(pages[after] ?? []); } } }, "401");
  assert.equal(count, 101);
  assert.deepEqual(seen, ["401/100", "1099/100"]);
});

test("announcements: only the bot's own message is replaced; other people's messages are never deleted", async () => {
  const message = { content: "안내 v2" };
  const run = async (items) => {
    const sent = [];
    const result = await syncAnnouncement({ messages: { fetch: async () => collection(items) }, send: async (m) => sent.push(m) }, message, "999");
    return { result, sent };
  };
  const other = { ...human("500"), delete: async () => assert.fail("deleted someone else's message") };
  let r = await run([other]);
  assert.equal(r.result, "sent");
  const stale = botMessage("400", "안내 v1");
  r = await run([other, stale]);
  assert.equal(r.result, "replaced");
  assert.ok(stale.deleted);
  r = await run([other, botMessage("401", "안내 v2")]);
  assert.deepEqual(r, { result: "unchanged", sent: [] });
});

test("state backups are trusted only from this bot and restored only into recruit-guild text channels", () => {
  assert.equal(isOwnBackupMessage({ author: { id: "999" }, content: "**State Backup** - x" }, "999"), true);
  assert.equal(isOwnBackupMessage({ author: { id: "300" }, content: "**State Backup** - x" }, "999"), false);
  assert.equal(isOwnBackupMessage({ author: { id: "999" }, content: "hello" }, "999"), false);
  assert.equal(isOwnBackupMessage({ author: { id: "999" }, content: "**State Backup**" }, undefined), false);
  assert.equal(isRestorableChannel({ type: 0, guildId: "recruit" }, "recruit"), true);
  assert.equal(isRestorableChannel({ type: 0, guildId: "nis" }, "recruit"), false);
  assert.equal(isRestorableChannel({ type: 2, guildId: "recruit" }, "recruit"), false);
  assert.equal(isRestorableChannel(null, "recruit"), false);
});

test("a v3.0.2 state backup (xstate 5.25.0 snapshot) restores and keeps running", () => {
  const backup = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v3.0.2-state-backup.json"), "utf8"));
  const [channelId, snapshot] = Object.entries(backup.sessions)[0];
  const handler = new StateMachineHandler();
  const states = [];
  handler.restoreSessionFromSnapshot(channelId, "alice-recruit", {}, snapshot, (_id, state) => states.push(state));
  assert.equal(handler.getCurrentState(channelId).value, "checkingConditions");
  assert.equal(handler.getCurrentState(channelId).context.mainCharacterName, "Example Pilot");
  handler.sendEvent(channelId, { type: "CONFIRM_CONDITIONS", interaction: null });
  assert.equal(handler.getCurrentState(channelId).value, "showingSelectRecruitRouteForm");
  assert.deepEqual(states, ["showingSelectRecruitRouteForm"]);
});

test("ban list: read from BAN_LIST_FILE; missing gives an empty list, malformed throws", () => {
  const example = fs.readFileSync(path.join(__dirname, "..", "ban-list.example.json"), "utf8");
  const list = parseBanList(example);
  assert.deepEqual(findBanMatches(list, { char: ["Example Pilot One"], corp: ["Nobody"] }), [{ label: "예시 밴 분류", type: "char", name: "Example Pilot One" }]);
  assert.deepEqual(findBanMatches(list, { char: ["Someone"], corp: ["Example Corporation"] }).map((m) => m.type), ["corp"]);
  assert.deepEqual(loadBanList({}), { categories: [] });
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.deepEqual(loadBanList({ BAN_LIST_FILE: "/run/configs/ban-list.json" }, () => { throw missing; }), { categories: [] });
  assert.throws(() => loadBanList({ BAN_LIST_FILE: "x" }, () => "not json"), /not valid JSON/);
  assert.throws(() => parseBanList(JSON.stringify({ categories: [{ char: ["x"] }] })), /label/);
  assert.throws(() => parseBanList(JSON.stringify({ categories: [{ label: "x", char: "x" }] })), /array of strings/);
  assert.throws(() => loadBanList({ BAN_LIST_FILE: "x" }, () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }), /could not be read/);
});

test("the repository carries no ban list data", () => {
  const data = fs.readFileSync(path.join(__dirname, "..", "src", "static", "data.ts"), "utf8");
  assert.ok(!/banData|evegall|char:\s*\[/.test(data));
});

test("the completion notice channel is the guild's text channel named 리크루터-working", () => {
  const { findRecruiterNoticeChannel, RECRUITER_NOTICE_CHANNEL_NAME } = require("../dist/lib/classes/DiscordHandler");
  assert.equal(RECRUITER_NOTICE_CHANNEL_NAME, require("../dist/static/data").recruiterChannelNames.NIS);
  const working = { type: 0, name: "리크루터-working", send: async () => {} };
  const guild = (channels) => ({ channels: { cache: { find: (fn) => channels.find(fn) } } });
  assert.equal(findRecruiterNoticeChannel(guild([{ type: 2, name: "리크루터-working" }, working])), working);
  assert.equal(findRecruiterNoticeChannel(guild([{ type: 0, name: "웜홀-해병트럭" }])), null);
});
