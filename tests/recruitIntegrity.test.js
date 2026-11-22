// run-4 findings in the recruit flow: one open consultation per member (by ID, locked),
// ban checks on canonical names and alliance history, and backups that reflect current state.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionsBitField, OverwriteType } = require("discord.js");
const memberOverwrite = (id) => ({ id, type: OverwriteType.Member, allow: new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]) });
const { RecruitActions } = require("../dist/lib/classes/recruit/Actions");
const { StateMachineHandler } = require("../dist/lib/classes/recruit/StateMachineHandler");

function recruitGuild({ existing = [], createDelayMs = 20 } = {}) {
  const children = new Map(existing.map((c) => [c.id, c]));
  const created = [];
  let next = 1;
  const category = {
    type: ChannelType.GuildCategory, name: "상담중",
    children: {
      cache: { find: (fn) => [...children.values()].find(fn) },
      create: async (options) => {
        await new Promise((r) => setTimeout(r, createDelayMs));
        const member = options.permissionOverwrites.find((o) => o.allow && !String(o.id).startsWith("role"));
        const channel = { id: `c${next++}`, name: options.name, type: ChannelType.GuildText, permissionOverwrites: { cache: new Map([[member.id, memberOverwrite(member.id)]]) }, send: async () => {}, toString: () => `#${options.name}` };
        children.set(channel.id, channel); created.push(options.name); return channel;
      },
    },
  };
  const guild = { id: "guild", channels: { cache: { find: (fn) => [category].find(fn) } }, roles: { cache: { find: () => ({ id: "role-recruiter", toString: () => "@리크루터" }) } } };
  return { guild, created };
}
const clicker = (guild, id, tag) => {
  const replies = [];
  return { replies, interaction: { guild, user: { id, tag, username: tag, toString: () => `<@${id}>` }, reply: async ({ content }) => replies.push(content) } };
};
const existingChannel = (name, memberId) => ({ id: `old-${name}`, name, type: ChannelType.GuildText, permissionOverwrites: { cache: new Map([[memberId, memberOverwrite(memberId)]]) }, toString: () => `#${name}` });

test("concurrent clicks by one member create at most one consultation channel", async () => {
  const { guild, created } = recruitGuild();
  const a = clicker(guild, "300", "dummyuser"), b = clicker(guild, "300", "dummyuser"), c = clicker(guild, "300", "dummyuser");
  await Promise.all([
    RecruitActions.createRecruitChannel(a.interaction, new StateMachineHandler(), async () => {}),
    RecruitActions.createRecruitChannel(b.interaction, new StateMachineHandler(), async () => {}),
    RecruitActions.createDaehwaChannel(c.interaction),
  ]);
  assert.equal(created.length, 1, created.join(","));
});

test("another member whose name extends yours does not block your consultation; your own open channel does", async () => {
  const { guild, created } = recruitGuild({ existing: [existingChannel("dummyuser2-recruit", "301")] });
  const me = clicker(guild, "300", "dummyuser");
  await RecruitActions.createDaehwaChannel(me.interaction);
  assert.deepEqual(created, ["dummyuser-daehwa"]);

  const second = clicker(guild, "300", "renamed-user");
  await RecruitActions.createDaehwaChannel(second.interaction);
  assert.equal(created.length, 1, "the member's own channel is found by ID even after a rename");
  assert.match(second.replies.at(-1), /이미 진행 중인 상담/);
});

const { StateBackup } = require("../dist/lib/classes/recruit/StateBackup");

function backupChannel(initial = []) {
  const messages = [...initial];
  const ops = [];
  const collection = () => {
    const items = [...messages];
    return { size: items.length, values: () => items.values(), filter: (fn) => { const f = items.filter(fn); return { size: f.length, values: () => f.values() }; } };
  };
  let id = 1000;
  const channel = {
    type: ChannelType.GuildText, name: "states-backup", isTextBased: () => true,
    messages: { fetch: async () => collection() },
    send: async (payload) => { const m = { id: String(id++), author: { id: "bot" }, content: payload.content, attachments: { size: 0 }, delete: async () => { ops.push(`delete:${m.id}`); messages.splice(messages.indexOf(m), 1); } }; messages.unshift(m); ops.push(`send:${m.id}`); return m; },
  };
  const client = { user: { id: "bot" }, guilds: { fetch: async () => ({ channels: { cache: { find: (fn) => [channel].find(fn) } } }) }, channels: { fetch: async () => { throw new Error("unknown channel"); } } };
  return { channel, client, messages, ops };
}
const oldBackup = (sessions) => ({ id: "1", author: { id: "bot" }, content: `**State Backup** - x\n\`\`\`json\n${JSON.stringify({ timestamp: "t", sessions })}\n\`\`\``, attachments: { size: 0 } });

test("with no active session the old backup is replaced, so a finished consultation is not restored", async () => {
  const stale = oldBackup({ "200000000000000002": { value: "showSeatRegistrationForm", context: {} } });
  const b = backupChannel([stale]);
  stale.delete = async () => { b.ops.push("delete:1"); b.messages.splice(b.messages.indexOf(stale), 1); };
  await new StateBackup(b.client, new StateMachineHandler(), "states-backup", "recruit").backupState();
  assert.deepEqual(b.ops, ["send:1000", "delete:1"], "new backup first, then the old one");
  assert.equal(b.messages.length, 1);
  assert.match(b.messages[0].content, /"sessions": \{\}/);
});

test("if sending the new backup fails, the old backup is kept", async () => {
  const stale = oldBackup({ a: {} });
  const b = backupChannel([stale]);
  let deleted = false;
  stale.delete = async () => { deleted = true; };
  b.channel.send = async () => { throw new Error("Missing Access"); };
  await new StateBackup(b.client, new StateMachineHandler(), "states-backup", "recruit").backupState();
  assert.equal(deleted, false);
});

test("restoreState reports whether restore finished, so backups wait for a successful restore", async () => {
  const ok = backupChannel([oldBackup({})]);
  assert.equal(await new StateBackup(ok.client, new StateMachineHandler(), "states-backup", "recruit").restoreState({ restoreSession() {} }), true);
  const broken = backupChannel();
  broken.channel.messages.fetch = async () => { throw new Error("Discord down"); };
  assert.equal(await new StateBackup(broken.client, new StateMachineHandler(), "states-backup", "recruit").restoreState({ restoreSession() {} }), false);
});

test("a completed session is ended and removed from memory", () => {
  const handler = new StateMachineHandler();
  const channel = { id: "c1" };
  handler.startSession("c1", "c1", channel, () => {});
  for (const event of [
    { type: "START_RECRUIT", interaction: null },
    { type: "SELECTED_RECRUIT_TYPE", interaction: null, recruitType: "NIDU" },
    { type: "SUBMIT_MAIN_CHAR", interaction: null, characterName: "Example Pilot", characterId: "1" },
    { type: "CONFIRM_SEAT_REGISTRATION", interaction: null },
    { type: "SUCCESS_CALL_RECRUITER" },
  ]) handler.sendEvent("c1", event);
  assert.equal(handler.getSession("c1") === undefined, true, "actor removed");
  assert.deepEqual(handler.getActiveSessions(), {});
});

const { EsiRequester } = require("../dist/lib/classes/EsiHandler");
const banList = require("../dist/lib/banList");

function modalRun({ typed, canonical = "Example Pilot One", alliances = { 2001: [{ alliance_id: 3001 }] }, failAlliance = false, list }) {
  const calls = { alliance: 0 };
  RecruitActions.clearAllianceCache();
  EsiRequester.getIdsFromNames = async () => ({ characters: [{ id: 90000001, name: canonical }] });
  EsiRequester.getCorpHistoryFromCharId = async () => [{ corporation_id: 2001, start_date: "2026-01-01T00:00:00Z" }];
  EsiRequester.getAllianceHistoryFromCorpId = async (corpId) => { calls.alliance++; if (failAlliance) throw new Error("ESI 503"); return alliances[corpId] ?? []; };
  EsiRequester.getNamesFromIds = async (ids) => ids.map((id) => ({ id, name: { 2001: "Clean Corp", 3001: "Banned Alliance" }[id] ?? `n${id}` }));
  banList.getBanList = () => list;
  const sent = [], events = [];
  const recruiterChannel = { type: ChannelType.GuildText, name: "리크루터-working", send: async (m) => sent.push(m.content) };
  const interaction = {
    fields: { getTextInputValue: () => typed }, reply: async () => {}, editReply: async () => {},
    guild: { roles: { cache: { find: () => ({ id: "role" }) } }, channels: { cache: { find: (fn) => [recruiterChannel].find(fn) } } },
  };
  const state = { matches: (s) => s === "showingEnterMainCharForm", context: { recruitType: "NIS" } };
  const machine = { sendEvent: (_c, e) => events.push(e) };
  return { calls, sent, events, interaction, state, machine, run: () => RecruitActions.submitMainCharModal(interaction, "c1", state, machine) };
}

test("the character ban check uses the ESI canonical name, not the typed text", async () => {
  for (const typed of ["example pilot one", "EXAMPLE PILOT ONE", "Example Pilot One"]) {
    const r = modalRun({ typed, list: { categories: [{ label: "밴", char: ["Example Pilot One"], corp: [], alli: [] }] } });
    await r.run();
    assert.equal(r.sent.length, 1, typed);
    assert.equal(r.events[0].characterName, "Example Pilot One");
  }
});

test("alliance ban entries are checked against the corporations' alliance history", async () => {
  const r = modalRun({ typed: "Example Pilot One", list: { categories: [{ label: "얼라이언스 밴", char: [], corp: [], alli: ["Banned Alliance"] }] } });
  await r.run();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /얼라이언스 Banned Alliance/);
  assert.equal(r.events.length, 1);
});

test("an alliance-history ESI failure fails the step like other ESI failures (no event, no warning)", async () => {
  const r = modalRun({ typed: "Example Pilot One", failAlliance: true, list: { categories: [{ label: "x", char: [], corp: [], alli: ["Banned Alliance"] }] } });
  await assert.rejects(r.run(), /ESI 503/);
  assert.deepEqual([r.sent.length, r.events.length], [0, 0]);
});

test("alliance histories are cached, so a retry in the same consultation does not refetch", async () => {
  const list = { categories: [{ label: "x", char: [], corp: [], alli: ["Banned Alliance"] }] };
  const first = modalRun({ typed: "Example Pilot One", list, alliances: { 2001: [{ alliance_id: 3001 }] } });
  RecruitActions.clearAllianceCache?.();
  await first.run();
  const before = first.calls.alliance;
  await first.run();
  assert.equal(first.calls.alliance, before, "second run served from cache");
});

const fs = require("node:fs");
const path = require("node:path");
const { RecruitHandler } = require("../dist/lib/classes/recruit/Handler");

test("after an error-recovery step the skip flag is cleared once, without re-posting, and later steps post again", async () => {
  const sent = [];
  const channel = { id: "200000000000000002", name: "c", isTextBased: () => true, send: async (m) => { sent.push(m.content ?? "components"); return {}; } };
  const handler = new RecruitHandler({ channels: { fetch: async () => channel } });
  const backup = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v3.0.2-state-backup.json"), "utf8"));
  const [channelId, snapshot] = Object.entries(backup.sessions)[0];
  handler.restoreSession(channelId, "c", channel, snapshot);
  const machine = handler.getStateMachineHandler();
  const tick = () => new Promise((r) => setTimeout(r, 20));
  machine.sendEvent(channelId, { type: "checkingConditions_ERROR" });
  await tick(); await tick();
  assert.equal(machine.getCurrentState(channelId).value, "showingEnterMainCharForm");
  assert.equal(machine.getCurrentState(channelId).context.skipStateChangeMessage, false, "flag cleared");
  assert.equal(sent.length, 0, "the recovered step is not re-posted");
  machine.sendEvent(channelId, { type: "SUBMIT_MAIN_CHAR", interaction: null, characterName: "Example Pilot", characterId: "1" });
  await tick(); await tick();
  assert.equal(machine.getCurrentState(channelId).value, "checkingConditions");
  assert.equal(sent.length, 1, "the next step posts its form again");
});

test("replies that echo the typed character name do not ping anyone", async () => {
  const r = modalRun({ typed: "@everyone <@&1>", list: { categories: [] } });
  const payloads = [];
  EsiRequester.getIdsFromNames = async () => ({ characters: [] });
  const interaction = { fields: { getTextInputValue: () => "@everyone <@&1>" }, reply: async (p) => payloads.push(p), editReply: async (p) => payloads.push(p), guild: null };
  await RecruitActions.submitMainCharModal(interaction, "c1", { matches: () => true, context: { recruitType: "NIS" } }, { sendEvent() {} });
  assert.equal(payloads.length, 2);
  for (const p of payloads) assert.deepEqual(p.allowedMentions, { parse: [] });
  void r;
});

test("a member overwrite without View (e.g. a per-member deny) is not an open consultation", () => {
  const { findOpenConsultation } = require("../dist/lib/classes/recruit/Actions");
  const denied = { id: "x", name: "x", type: ChannelType.GuildText, permissionOverwrites: { cache: new Map([["300", { id: "300", type: OverwriteType.Member, allow: new PermissionsBitField() }]]) } };
  const role = { id: "y", name: "y", type: ChannelType.GuildText, permissionOverwrites: { cache: new Map([["300", { id: "300", type: OverwriteType.Role, allow: new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]) }]]) } };
  const cat = { children: { cache: { find: (fn) => [denied, role].find(fn) } } };
  assert.equal(findOpenConsultation(cat, "300"), undefined);
});

test("restore reads the same 100-message window backups are deleted from", async () => {
  const filler = Array.from({ length: 12 }, (_, i) => ({ id: String(2000 + i), author: { id: "member" }, content: "hi", attachments: { size: 0 } }));
  const b = backupChannel([...filler, oldBackup({ "200000000000000002": { value: "x", context: {} } })]);
  let limit;
  const original = b.channel.messages.fetch;
  b.channel.messages.fetch = async (options) => { limit = options.limit; return original(options); };
  b.client.channels.fetch = async () => ({ id: "200000000000000002", type: ChannelType.GuildText, guildId: "recruit", name: "c", isTextBased: () => true });
  const restored = [];
  const ok = await new StateBackup(b.client, new StateMachineHandler(), "states-backup", "recruit").restoreState({ restoreSession: (id) => restored.push(id) });
  assert.equal(limit, 100);
  assert.equal(ok, true);
  assert.deepEqual(restored, ["200000000000000002"]);
});

test("a transient channel fetch error makes restore report failure (backup kept); Unknown Channel drops the session", async () => {
  const sessions = { "200000000000000002": { value: "x", context: {} } };
  const transient = backupChannel([oldBackup(sessions)]);
  transient.client.channels.fetch = async () => { throw Object.assign(new Error("Service Unavailable"), { status: 503 }); };
  assert.equal(await new StateBackup(transient.client, new StateMachineHandler(), "states-backup", "recruit").restoreState({ restoreSession() {} }), false);
  const gone = backupChannel([oldBackup(sessions)]);
  gone.client.channels.fetch = async () => { throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); };
  assert.equal(await new StateBackup(gone.client, new StateMachineHandler(), "states-backup", "recruit").restoreState({ restoreSession() {} }), true);
});

test("a retried restore does not restore a session that is already live", async () => {
  const b = backupChannel([oldBackup({ "200000000000000002": { value: "x", context: {} } })]);
  b.client.channels.fetch = async () => ({ id: "200000000000000002", type: ChannelType.GuildText, guildId: "recruit", name: "c", isTextBased: () => true });
  const machine = new StateMachineHandler();
  machine.startSession("200000000000000002", "c", {}, () => {});
  const restored = [];
  await new StateBackup(b.client, machine, "states-backup", "recruit").restoreState({ restoreSession: (id) => restored.push(id), getStateMachineHandler: () => machine });
  assert.deepEqual(restored, []);
});

test("alliance check: a full cache never drops a corporation from the result", async () => {
  const list = { categories: [{ label: "x", char: [], corp: [], alli: ["Banned Alliance"] }] };
  const r = modalRun({ typed: "Example Pilot One", list, alliances: { 2001: [{ alliance_id: 3001 }] } });
  await r.run();
  // Fill the cache with 999 other corporations so 2001 sits at the front, then check again with one new corporation.
  const fill = Array.from({ length: 999 }, (_, i) => 10000 + i);
  EsiRequester.getCorpHistoryFromCharId = async () => fill.map((corporation_id) => ({ corporation_id, start_date: "2026-01-01T00:00:00Z" }));
  await RecruitActions.submitMainCharModal(r.interaction, "c1", r.state, r.machine).catch(() => {});
  EsiRequester.getCorpHistoryFromCharId = async () => [2001, 7000].map((corporation_id) => ({ corporation_id, start_date: "2026-01-01T00:00:00Z" }));
  const before = r.sent.length;
  await RecruitActions.submitMainCharModal(r.interaction, "c1", r.state, r.machine);
  assert.equal(r.sent.length, before + 1, "the banned alliance is still found");
});

test("ESI 404 for a corporation's alliance history counts as no alliances", async () => {
  const axios = require("axios");
  const saved = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => ({ data: { error: "not found" }, status: 404, statusText: "Not Found", headers: {}, config });
  try {
    // modalRun replaced this static with a stub; load a fresh copy of the real module.
    delete require.cache[require.resolve("../dist/lib/classes/EsiHandler")];
    const fresh = require("../dist/lib/classes/EsiHandler").EsiRequester;
    assert.equal(await fresh.getAllianceHistoryFromCorpId(1000001), null);
  } finally { axios.defaults.adapter = saved; }
});

test("a restore retry does not bring back a session restored earlier that has since ended", async () => {
  const sessions = { "200000000000000002": { value: "x", context: {} }, "200000000000000003": { value: "x", context: {} } };
  const b = backupChannel([oldBackup(sessions)]);
  let failOnce = true;
  b.client.channels.fetch = async (id) => {
    if (id === "200000000000000003" && failOnce) { failOnce = false; throw Object.assign(new Error("Service Unavailable"), { status: 503 }); }
    return { id, type: ChannelType.GuildText, guildId: "recruit", name: id, isTextBased: () => true };
  };
  const machine = new StateMachineHandler();
  const restored = [];
  const handler = { restoreSession: (id) => restored.push(id), getStateMachineHandler: () => machine };
  const backup = new StateBackup(b.client, machine, "states-backup", "recruit");
  assert.equal(await backup.restoreState(handler), false);
  assert.deepEqual(restored, ["200000000000000002"]);
  // session ...02 has ended meanwhile (not live); the retry must restore only ...03
  assert.equal(await backup.restoreState(handler), true);
  assert.deepEqual(restored, ["200000000000000002", "200000000000000003"]);
});

test("an ESI 404 alliance history is not cached, so the next check asks ESI again", async () => {
  const list = { categories: [{ label: "x", char: [], corp: [], alli: ["Banned Alliance"] }] };
  const r = modalRun({ typed: "Example Pilot One", list, alliances: {} });
  EsiRequester.getAllianceHistoryFromCorpId = async () => { r.calls.alliance++; return null; };
  await r.run();
  await r.run();
  assert.equal(r.calls.alliance, 2);
});
