// The consultation payload must match the archive's JSON shapes (intel-archive schemas.py): every
// JsonObject field is a plain object, never an array. Built from real discord.js objects, because a
// discord.js Collection's toJSON() returns an array (a plain Map stand-in hid this, v4.0.1 422 on
// body.channel.permission_snapshot and body.permission_snapshot).
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, GatewayIntentBits, Message, Collection } = require("discord.js");
const { collectConsultation } = require("../dist/lib/archive/ConsultationCollector");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function buildConsultation() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const guild = client.guilds._add({ id: "100", name: "DummyRecruit", channels: [], roles: [{ id: "100", name: "@everyone", permissions: "0", position: 0 }], members: [] });
  client.channels._add({ id: "110", type: 4, guild_id: "100", name: "상담중", position: 0, permission_overwrites: [] }, guild);
  const consult = client.channels._add({
    id: "111", type: 0, guild_id: "100", name: "dummy-consult", parent_id: "110", position: 0,
    permission_overwrites: [{ id: "100", type: 0, allow: "0", deny: "1024" }, { id: "301", type: 1, allow: "1024", deny: "0" }],
  }, guild);
  const applicant = { id: "301", username: "dummyapplicant", discriminator: "0" };
  const msg = new Message(client, {
    id: "1000", channel_id: "111", guild_id: "100", author: applicant, content: "hello",
    timestamp: new Date(1700000000000).toISOString(), edited_timestamp: null, tts: false, mention_everyone: false,
    mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
    // Message parts the collector json()s one by one, so each must stay an object (or list of objects).
    reactions: [{ count: 1, me: false, emoji: { id: null, name: "👍" }, count_details: { burst: 0, normal: 1 }, burst_colors: [] }],
    sticker_items: [{ id: "900", name: "dummy-sticker", format_type: 1 }],
    poll: { question: { text: "dummy?" }, answers: [{ answer_id: 1, poll_media: { text: "yes" } }], expiry: null, allow_multiselect: false, layout_type: 1 },
    interaction_metadata: { id: "950", type: 2, user: applicant, authorizing_integration_owners: {} },
    message_reference: { type: 1, channel_id: "111", guild_id: "100", message_id: "999" },
    message_snapshots: [{ message: { content: "forwarded", timestamp: new Date(1700000000000).toISOString(), edited_timestamp: null, type: 0, flags: 0, mentions: [], mention_roles: [], attachments: [], embeds: [] } }],
  });
  consult.messages.fetch = async () => new Collection([[msg.id, msg]]);
  guild.members.fetch = async (id) => (id === "301" ? { id: "301", displayName: "dummyapplicant", user: applicant, roles: { cache: new Collection() } } : null);
  const interaction = { inGuild: () => true, client, user: { id: "302", username: "dummyrecruiter", globalName: null }, member: { displayName: "dummyrecruiter" } };
  return { client, consult, interaction };
}

test("a real discord.js Collection's toJSON() is an array (why the snapshot must be rebuilt)", () => {
  assert.ok(Array.isArray(new Collection([["a", { id: "a" }]]).toJSON()));
});

test("payload JsonObject fields are plain objects; permission snapshots are keyed by overwrite id", async () => {
  const { client, consult, interaction } = buildConsultation();
  try {
    const collected = await collectConsultation(interaction, consult, { policy: { hosts: [], mimeTypes: [], maxAttachmentBytes: 1 }, fetchImpl: async () => { throw new Error("no network"); } });
    // Check what ArchiveClient actually sends: the JSON.stringify'd body.
    const payload = JSON.parse(JSON.stringify(collected));
    const objects = {
      "guild.raw": payload.guild.raw,
      "channel.permission_snapshot": payload.channel.permission_snapshot,
      "channel.raw": payload.channel.raw,
      permission_snapshot: payload.permission_snapshot,
      raw_snapshot: payload.raw_snapshot,
      "participants[0].raw_snapshot": payload.participants[0].raw_snapshot,
      "messages[0].raw_snapshot": payload.messages[0].raw_snapshot,
      "messages[0].poll": payload.messages[0].poll,
      "messages[0].interaction": payload.messages[0].interaction,
    };
    for (const [field, value] of Object.entries(objects)) assert.ok(isObject(value), `${field} must be a JSON object`);
    assert.ok(payload.messages[0].application === null || isObject(payload.messages[0].application), "messages[0].application must be an object or null");
    for (const field of ["mentions", "embeds", "reactions", "stickers", "components", "message_snapshots"]) {
      const list = payload.messages[0][field];
      assert.ok(Array.isArray(list) && list.every(isObject), `messages[0].${field} must be a list of JSON objects`);
    }
    for (const field of ["reactions", "stickers", "message_snapshots"]) assert.equal(payload.messages[0][field].length, 1, `messages[0].${field} is exercised`);
    for (const field of ["category", "thread_metadata", "forum_metadata"]) {
      const value = payload.channel[field];
      assert.ok(value === null || isObject(value), `channel.${field} must be an object or null`);
    }

    const snapshot = payload.channel.permission_snapshot;
    assert.deepEqual(Object.keys(snapshot).sort(), ["100", "301"]);
    assert.equal(snapshot["301"].id, "301");
    assert.equal(snapshot["301"].type, 1);
    assert.equal(snapshot["301"].allow, "1024");
    assert.equal(snapshot["100"].deny, "1024");
    assert.equal(snapshot["100"].allow, "0");
    assert.deepEqual(payload.permission_snapshot, snapshot);
  } finally {
    await client.destroy();
  }
});

test("an applicant who left the server is archived from their user, marked as gone", async () => {
  const { client, consult, interaction } = buildConsultation();
  // Left the server: the member lookup fails, the user (seen through the message author) remains.
  consult.guild.members.fetch = async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); };
  try {
    const payload = await collectConsultation(interaction, consult, { policy: { hosts: [], mimeTypes: [], maxAttachmentBytes: 1 }, fetchImpl: async () => { throw new Error("no network"); } });
    assert.equal(payload.applicant_discord_id, "301");
    assert.equal(payload.applicant_display_name, "dummyapplicant (서버 나감)");
    assert.deepEqual(payload.raw_snapshot.applicant, { in_guild: false, evidence: ["permission", "messages"] });
    assert.equal(payload.participants.find((p) => p.discord_user_id === "301").role, "applicant");
  } finally {
    await client.destroy();
  }
});
