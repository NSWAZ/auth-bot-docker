// The consultation archive keeps only the consultation guild's mentioned-channel names; channels
// of other guilds the bot can see are stored as IDs only (run-4 needs_validation, fixed).
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, GatewayIntentBits, Message, Collection } = require("discord.js");
const { collectConsultation } = require("../dist/lib/archive/ConsultationCollector");

test("mentioned channels: same guild -> {id, name}; other guild -> {id}; no other-guild names or topics anywhere", async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const recruit = client.guilds._add({ id: "100", name: "DummyRecruit", channels: [], roles: [{ id: "100", name: "@everyone", permissions: "0", position: 0 }], members: [] });
  const other = client.guilds._add({ id: "200", name: "DummyOther", channels: [], roles: [{ id: "200", name: "@everyone", permissions: "0", position: 0 }], members: [] });
  client.channels._add({ id: "110", type: 4, guild_id: "100", name: "상담중", position: 0, permission_overwrites: [] }, recruit);
  const consult = client.channels._add({ id: "111", type: 0, guild_id: "100", name: "dummy-consult", parent_id: "110", position: 0, permission_overwrites: [{ id: "100", type: 0, allow: "0", deny: "1024" }, { id: "301", type: 1, allow: "1024", deny: "0" }] }, recruit);
  client.channels._add({ id: "100000000000000112", type: 0, guild_id: "100", name: "dummy-public", topic: "SAME-GUILD-TOPIC", position: 1, permission_overwrites: [] }, recruit);
  client.channels._add({ id: "200000000000000211", type: 0, guild_id: "200", name: "dummy-private-staff", topic: "DUMMY-PRIVATE-TOPIC", position: 0, permission_overwrites: [{ id: "555", type: 0, allow: "1024", deny: "0" }] }, other);
  const applicant = { id: "301", username: "dummyapplicant", discriminator: "0" };
  const msg = new Message(client, {
    id: "1000", channel_id: "111", guild_id: "100", author: applicant, content: "see <#200000000000000211> and <#100000000000000112>",
    timestamp: new Date(1700000000000).toISOString(), edited_timestamp: null, tts: false, mention_everyone: false,
    mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
  });
  consult.messages.fetch = async () => new Collection([[msg.id, msg]]);
  recruit.members.fetch = async (id) => (id === "301" ? { id: "301", displayName: "dummyapplicant", user: applicant, roles: { cache: new Collection() } } : null);
  const interaction = { inGuild: () => true, client, user: { id: "302", username: "dummyrecruiter", globalName: null }, member: { displayName: "dummyrecruiter" } };
  try {
    const payload = await collectConsultation(interaction, consult, { policy: { hosts: [], mimeTypes: [], maxAttachmentBytes: 1 }, fetchImpl: async () => { throw new Error("no network"); } });
    const mentioned = payload.messages[0].mention_channels;
    assert.deepEqual(mentioned.sort((a, b) => a.id.localeCompare(b.id)), [{ id: "100000000000000112", name: "dummy-public" }, { id: "200000000000000211" }]);
    const whole = JSON.stringify(payload);
    for (const secret of ["dummy-private-staff", "DUMMY-PRIVATE-TOPIC", "SAME-GUILD-TOPIC", "\"555\""]) assert.ok(!whole.includes(secret), secret);
    assert.equal(payload.messages[0].content, "see <#200000000000000211> and <#100000000000000112>", "content is kept as written");
  } finally {
    await client.destroy();
  }
});
