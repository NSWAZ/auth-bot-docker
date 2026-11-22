// /grill_reload confirmation is bound to the invoker and its own prompt; the startup
// announcement replaces only the bot's own message.
const test = require("node:test");
const assert = require("node:assert/strict");
const { TextChannel } = require("discord.js");
const { DiscordHandler, isArchiveConfirmation, syncAnnouncement } = require("../dist/lib/classes/DiscordHandler");

function grillReload(clicks) {
  const ops = [];
  let customIds = [];
  const channel = Object.create(TextChannel.prototype);
  channel.awaitMessageComponent = async ({ filter }) => {
    for (const make of clicks) {
      const click = make(customIds);
      if (filter(click)) return click;
    }
    throw new Error("time");
  };
  const target = { id: "300", name: "grill", clone: async () => ops.push("clone"), setName: async (n) => ops.push(`name:${n}`), setParent: async () => ops.push("parent") };
  const interaction = {
    user: { id: "admin" }, channelId: "chan", channel,
    reply: async ({ components }) => { customIds = components[0].components.map((b) => b.data.custom_id); },
    fetchReply: async () => ({ id: "prompt" }),
    editReply: async ({ content }) => ops.push(`reply:${content.slice(0, 12)}`),
    guild: { channels: { cache: { filter: () => ({ size: 1, first: () => ({ id: "cat" }) }) } } },
  };
  return { ops, run: () => DiscordHandler.archiveChannel(interaction, target, "불판 갈기", "Copy") };
}
const click = (user, message, pick, channelId = "chan") => (ids) => ({
  user: { id: user }, message: { id: message }, channelId, customId: pick(ids),
  update: async () => {},
});
const yes = (ids) => ids.find((id) => id.endsWith(":yes"));

test("/grill_reload: another member's yes, a yes on another prompt, or a plain 'yes' id does nothing", async () => {
  const { ops, run } = grillReload([
    click("member", "prompt", yes),
    click("admin", "other-prompt", yes),
    click("admin", "prompt", () => "yes"),
    click("admin", "prompt", yes, "other-channel"),
  ]);
  await run();
  assert.ok(!ops.includes("clone") && !ops.includes("parent"), ops.join(","));
  assert.match(ops.at(-1), /확인 시간이/);
});

test("/grill_reload: the invoker's own yes on its own prompt runs the archive", async () => {
  const { ops, run } = grillReload([click("member", "prompt", yes), click("admin", "prompt", yes)]);
  await run();
  // Order differs by version (rollback-aware code moves before renaming); all three must run.
  assert.deepEqual(ops.slice(0, 3).map((o) => o.split(":")[0]).sort(), ["clone", "name", "parent"]);
});

test("confirmation ids are fresh per prompt and bound to invoker, message and channel", () => {
  const base = { user: { id: "42" }, customId: "archive:n:yes", message: { id: "m1" }, channelId: "c1" };
  assert.equal(isArchiveConfirmation("42", "n", "m1", "c1", base), true);
  assert.equal(isArchiveConfirmation("43", "n", "m1", "c1", base), false);
  assert.equal(isArchiveConfirmation("42", "n", "m2", "c1", base), false);
  assert.equal(isArchiveConfirmation("42", "n", "m1", "c2", base), false);
  assert.equal(isArchiveConfirmation("42", "other", "m1", "c1", base), false);
});

test("announcement: only the bot's own message is replaced; other people's messages are never deleted", async () => {
  const collection = (items) => ({ values: () => items.values() });
  const message = { content: "안내 v2" };
  const run = async (items) => {
    const sent = [];
    const result = await syncAnnouncement({ messages: { fetch: async () => collection(items) }, send: async (m) => sent.push(m) }, message, "999");
    return { result, sent };
  };
  const other = { id: "500", author: { id: "300" }, content: "staff notice", delete: async () => assert.fail("deleted someone else's message") };
  assert.equal((await run([other])).result, "sent");
  let deleted = false;
  const stale = { id: "400", author: { id: "999" }, content: "안내 v1", delete: async () => { deleted = true; } };
  assert.equal((await run([other, stale])).result, "replaced");
  assert.ok(deleted);
  assert.deepEqual(await run([other, { id: "401", author: { id: "999" }, content: "안내 v2" }]), { result: "unchanged", sent: [] });
});

test("startup announcement failures are caught: the process keeps running", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.ts"), "utf8");
  assert.match(src, /syncAnnouncement\(/);
  assert.match(src, /catch \(error\)[\s\S]*AnnounceManager/);
  assert.ok(!/messages\.first\(\)\?\.delete\(\)/.test(src));
});
