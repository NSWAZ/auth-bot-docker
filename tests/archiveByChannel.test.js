// GET /api/v1/consultations/by-channel and the recovery paths that use it (ArchiveWorkflow.ts):
// POST 409 → read the channel's existing archive; verified POST + failed GET → by-channel read-back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ArchiveClient, normalizeResponse } = require("../dist/lib/archive/ArchiveClient");
const { ArchiveError, MutationError } = require("../dist/lib/archive/errors");
const { archiveVerifyThenMutate, verifyExistingArchive } = require("../dist/lib/archive/ArchiveWorkflow");
const { loadArchiveConfig } = require("../dist/lib/archive/config");

const hashA = "a".repeat(64), digest = "d".repeat(64);
const msg = (id, minute, attachments = []) => ({ discord_message_id: id, author_discord_id: "300", author_name: "Alice", content: id, created_at: `2026-09-10T10:${String(minute).padStart(2, "0")}:00.000Z`, edited_at: null, sequence: minute, attachments });
const attachment = { discord_attachment_id: "500", filename: "fixture.txt", content_type: "text/plain", size: 14, source_url: "https://cdn.discordapp.com/attachments/1/500/fixture.txt?hm=1" };
// The channel as collected by this run: the earlier archive's cutoff was 401; 402 and 403 came after it.
const payload = {
  schema_version: 2, discord_guild_id: "100", discord_channel_id: "200", channel_name: "alice-recruit", recruitment_type: "NIS",
  applicant_discord_id: "300", applicant_display_name: "Alice", completed_by_discord_id: "600", completed_by_display_name: "Recruiter",
  started_at: "2026-09-10T10:00:00.000Z", captured_at: "2026-09-10T12:00:00.000Z", cutoff_message_id: "403", closed_at: "2026-09-10T12:00:00.000Z",
  guild: {}, channel: {}, permission_snapshot: {}, raw_snapshot: {}, participants: [{ discord_user_id: "300", username: "alice", display_name: "Alice", role: "applicant" }],
  messages: [msg("400", 0), msg("401", 1, [attachment]), msg("402", 2), msg("403", 3)],
  assets: [{ kind: "attachment", source_discord_id: "500", source_url: attachment.source_url, filename: "fixture.txt", content_type: "text/plain", size: 14, owner_reference: { message_id: "401", attachment_id: "500" } }],
};
function existing(overrides = {}, verification = {}) {
  return normalizeResponse({
    archive_id: "archive-old", schema_version: 2, status: "verified", discord_guild_id: "100", discord_channel_id: "200", cutoff_message_id: "401",
    sorted_message_ids: ["400", "401"], attachments: [{ discord_attachment_id: "500", sha256: hashA, actual_size: 14, verified: true }],
    assets: [{ asset_id: "asset-1", kind: "attachment", source_discord_id: "500", filename: "fixture.txt", content_type: "text/plain", declared_size: 14, sha256: hashA, actual_size: 14, owner_reference: { message_id: "401", attachment_id: "500" }, verified: true }],
    discord_snapshot: { messages: [] },
    verification: { complete: true, submitted: { participants: 1, messages: 2, attachments: 1, assets: 1 }, stored: { participants: 1, messages: 2, attachments: 1, assets: 1 }, ordering_verified: true, attachments_verified: true, manifest_verified: true, ...verification },
    manifest_digest: digest,
    ...overrides,
  });
}
const conflict = () => new ArchiveError("conflict", "이 채널은 이미 보관되어 있습니다 (409)");
const run = (client, mutate = async () => {}) => archiveVerifyThenMutate({}, {}, { collect: async () => structuredClone(payload), client }, mutate);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const config = { baseUrl: "http://archive", token: "do-not-leak", postTimeoutMs: 50, getTimeoutMs: 50, maxRetries: 2, retryDelayMs: 1, maxRequestBytes: 1 << 24 };

test("client: by-channel sends guild/channel as query with Bearer, reads once, and maps 404/401/422", async () => {
  const seen = [];
  const client = new ArchiveClient(config, async (url, init) => { seen.push({ url, init }); return json({ ...existing(), verification: existing().verification }); }, async () => {});
  assert.equal((await client.getByChannel("100", "200")).archive_id, "archive-old");
  assert.equal(seen[0].url, "http://archive/api/v1/consultations/by-channel?guild_id=100&channel_id=200");
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[0].init.headers.Authorization, "Bearer do-not-leak");
  for (const [status, kind] of [[404, "not_found"], [401, "auth"], [422, "invalid_request"]]) {
    let calls = 0;
    const failing = new ArchiveClient(config, async () => { calls++; return json({ detail: "x" }, status); }, async () => {});
    await assert.rejects(failing.getByChannel("100", "200"), (error) => error.kind === kind && !error.message.includes("do-not-leak"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const transient = new ArchiveClient(config, async () => { calls++; return json({ detail: "x" }, 503); }, async () => {});
  await assert.rejects(transient.getByChannel("100", "200"), (error) => error.kind === "server");
  assert.equal(calls, 1, "recovery reads are single attempts");
  const never = new ArchiveClient(config, async () => assert.fail("fetched"), async () => {});
  await assert.rejects(never.getByChannel("100&x=1", "200"), (error) => error.kind === "invalid_request");
});

test("POST 409: a verified existing archive found by channel and re-read by ID lets the cleanup run", async () => {
  const order = [];
  let mutated = null;
  const verified = await run({
    submit: async () => { order.push("post"); throw conflict(); },
    getByChannel: async (guild, channel) => { order.push(`by-channel:${guild}/${channel}`); return existing(); },
    get: async (id, attempts) => { order.push(`get:${id}:${attempts}`); return existing(); },
  }, async (archive) => { order.push("mutate"); mutated = archive; });
  assert.deepEqual(order, ["post", "by-channel:100/200", "get:archive-old:1", "mutate"]);
  assert.equal(mutated.archive_id, "archive-old");
  assert.equal(verified.cutoff_message_id, "401");
});

test("POST 409: no cleanup when the existing archive is incomplete, missing, foreign or disagrees with its GET", async () => {
  const cases = [
    { getByChannel: async () => existing({}, { complete: false }), get: async () => existing() },
    { getByChannel: async () => existing({ status: "failed" }), get: async () => existing() },
    { getByChannel: async () => existing({ discord_channel_id: "201" }), get: async () => existing() },
    { getByChannel: async () => existing({ cutoff_message_id: "404", sorted_message_ids: ["400", "404"] }), get: async () => existing() },
    // 400 is still in the channel but not in the archive.
    { getByChannel: async () => existing({ sorted_message_ids: ["399", "401"] }), get: async () => existing() },
    // order differs from the channel's
    { getByChannel: async () => existing({ sorted_message_ids: ["401", "400"] }), get: async () => existing() },
    // attachment size differs from the channel's
    { getByChannel: async () => existing({ attachments: [{ discord_attachment_id: "500", sha256: hashA, actual_size: 15, verified: true }] }), get: async () => existing() },
    { getByChannel: async () => existing(), get: async () => existing({ manifest_digest: "e".repeat(64) }) },
    { getByChannel: async () => existing(), get: async () => { throw new ArchiveError("timeout", "GET"); } },
    { getByChannel: async () => { throw new ArchiveError("network", "down"); }, get: async () => existing() },
  ];
  for (const client of cases) {
    let mutations = 0;
    await assert.rejects(run({ submit: async () => { throw conflict(); }, ...client }, async () => mutations++), (error) => error instanceof ArchiveError);
    assert.equal(mutations, 0);
  }
});

test("POST 409 with no verified archive for the channel (404) fails closed as a conflict", async () => {
  let mutations = 0;
  await assert.rejects(
    run({ submit: async () => { throw conflict(); }, getByChannel: async () => { throw new ArchiveError("not_found", "404"); }, get: async () => assert.fail("GET") }, async () => mutations++),
    (error) => error instanceof ArchiveError && error.kind === "conflict" && /찾지 못했습니다/.test(error.message),
  );
  assert.equal(mutations, 0);
});

test("a message deleted from the channel after archiving does not block the cleanup", () => {
  const current = structuredClone(payload);
  current.messages = current.messages.filter((m) => m.discord_message_id !== "400");
  verifyExistingArchive(current, existing(), "by-channel");
});

test("verified POST whose GET cannot be read is checked against the by-channel read instead", async () => {
  const fresh = existing({ archive_id: "archive-new", cutoff_message_id: "403", sorted_message_ids: ["400", "401", "402", "403"] }, { submitted: { participants: 1, messages: 4, attachments: 1, assets: 1 }, stored: { participants: 1, messages: 4, attachments: 1, assets: 1 } });
  const order = [];
  await run({ submit: async () => fresh, get: async () => { order.push("get"); throw new ArchiveError("timeout", "GET"); }, getByChannel: async () => { order.push("by-channel"); return structuredClone(fresh); } }, async () => order.push("mutate"));
  assert.deepEqual(order, ["get", "by-channel", "mutate"]);

  let mutations = 0;
  await assert.rejects(run({ submit: async () => fresh, get: async () => { throw new ArchiveError("network", "GET"); }, getByChannel: async () => existing() }, async () => mutations++), (error) => error instanceof ArchiveError);
  await assert.rejects(run({ submit: async () => fresh, get: async () => { throw new ArchiveError("not_found", "GET"); }, getByChannel: async () => assert.fail("by-channel") }, async () => mutations++), (error) => error.kind === "not_found");
  await assert.rejects(run({ submit: async () => fresh, get: async () => { throw new ArchiveError("timeout", "GET"); }, getByChannel: async () => { throw new ArchiveError("not_found", "404"); } }, async () => mutations++), (error) => error.kind === "timeout");
  assert.equal(mutations, 0);
});

test("a cleanup failure after a recovered archive is a MutationError", async () => {
  await assert.rejects(
    run({ submit: async () => { throw conflict(); }, getByChannel: async () => existing(), get: async () => existing() }, async () => { throw new Error("delete"); }),
    (error) => error instanceof MutationError,
  );
});

test("config: the default retries still fit Discord's reply window with one extra recovery read", () => {
  const c = loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x" });
  assert.equal(c.maxRetries, 2);
  assert.throws(() => loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x", INTEL_ARCHIVE_GET_TIMEOUT_MS: "31000" }), (error) => error.kind === "config");
});
