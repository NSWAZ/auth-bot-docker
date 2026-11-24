// Bot-side archive flow: ordering of collect → POST → GET → mutation, Discord collection, and
// /grill_reload channel mutation compensation (/상담완료 deletion is in recruitMerge.test.js). The archive's API contract itself is in archiveContract.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { archiveVerifyThenMutate } = require("../dist/lib/archive/ArchiveWorkflow");
const { ArchiveClient, parseRetryAfter, normalizeResponse } = require("../dist/lib/archive/ArchiveClient");
const { fetchAllMessages, collectDownloadableAssets, resolveApplicant } = require("../dist/lib/archive/ConsultationCollector");
const { isArchiveConfirmation, mutateArchivedChannel, archiveFailureMessage } = require("../dist/lib/classes/DiscordHandler");
const { ArchiveError, MutationError } = require("../dist/lib/archive/errors");

const hashA = "a".repeat(64);
const payload = {
  schema_version: 2, discord_guild_id: "100", discord_channel_id: "200", channel_name: "alice-recruit", recruitment_type: "NIS",
  applicant_discord_id: "300", applicant_display_name: "Alice", completed_by_discord_id: "600", completed_by_display_name: "Recruiter",
  started_at: "2026-09-10T10:00:00.000Z", captured_at: "2026-09-10T11:00:00.000Z", cutoff_message_id: "401", closed_at: "2026-09-10T11:00:00.000Z",
  guild: {}, channel: {}, permission_snapshot: {}, raw_snapshot: {}, participants: [{ discord_user_id: "300", username: "alice", display_name: "Alice", role: "applicant" }],
  messages: [
    { discord_message_id: "400", author_discord_id: "300", author_name: "Alice", content: "hello", created_at: "2026-09-10T10:00:00.000Z", edited_at: null, sequence: 0, attachments: [] },
    { discord_message_id: "401", author_discord_id: "300", author_name: "Alice", content: "file", created_at: "2026-09-10T10:01:00.000Z", edited_at: null, sequence: 1, attachments: [{ discord_attachment_id: "500", filename: "fixture.txt", content_type: "text/plain", size: 14, source_url: "https://cdn.discordapp.com/attachments/1/500/fixture.txt?hm=1" }] },
  ],
  assets: [{ kind: "attachment", source_discord_id: "500", source_url: "https://cdn.discordapp.com/attachments/1/500/fixture.txt?hm=1", filename: "fixture.txt", content_type: "text/plain", size: 14, owner_reference: { message_id: "401", attachment_id: "500" } }],
};
const response = normalizeResponse({
  archive_id: "archive-1", schema_version: 2, status: "verified", discord_guild_id: "100", discord_channel_id: "200", cutoff_message_id: "401",
  sorted_message_ids: ["400", "401"], attachments: [{ discord_attachment_id: "500", sha256: hashA, actual_size: 14, verified: true }],
  assets: [{ asset_id: "asset-1", kind: "attachment", source_discord_id: "500", filename: "fixture.txt", content_type: "text/plain", declared_size: 14, sha256: hashA, actual_size: 14, owner_reference: { message_id: "401", attachment_id: "500" }, verified: true }],
  discord_snapshot: { messages: [] },
  verification: { complete: true, submitted: { participants: 1, messages: 2, attachments: 1, assets: 1 }, stored: { participants: 1, messages: 2, attachments: 1, assets: 1 }, ordering_verified: true, attachments_verified: true, manifest_verified: true },
  manifest_digest: "d".repeat(64),
});

test("verified POST and independent GET happen before mutation", async () => {
  const order = [];
  await archiveVerifyThenMutate({}, {}, { collect: async () => { order.push("collect"); return payload; }, client: { submit: async () => { order.push("post"); return response; }, get: async () => { order.push("verified-get"); return structuredClone(response); } } }, async () => order.push("mutation"));
  assert.deepEqual(order, ["collect", "post", "verified-get", "mutation"]);
});

test("a failed POST answer is reported without asking for a GET", async () => {
  let gets = 0;
  const failed = { ...structuredClone(response), status: "failed", failure_reason: "asset integrity verification failed" };
  await assert.rejects(archiveVerifyThenMutate({}, {}, { collect: async () => payload, client: { submit: async () => failed, get: async () => { gets++; return response; } } }, async () => assert.fail("mutated")), /asset integrity verification failed/);
  assert.equal(gets, 0);
});

test("archive failures are pre-mutation fail-closed", async () => {
  const cases = [
    { collect: async () => { throw Error("history"); }, client: {} },
    { collect: async () => payload, client: { submit: async () => { throw Error("timeout"); } } },
    { collect: async () => payload, client: { submit: async () => response, get: async () => { throw Error("GET"); } } },
    { collect: async () => payload, client: { submit: async () => response, get: async () => ({ ...structuredClone(response), status: "failed" }) } },
    { collect: async () => payload, client: { submit: async () => response, get: async () => ({ ...structuredClone(response), discord_snapshot: {} }) } },
  ];
  for (const dependencies of cases) {
    let mutations = 0;
    await assert.rejects(archiveVerifyThenMutate({}, {}, dependencies, async () => mutations++), (error) => error instanceof ArchiveError);
    assert.equal(mutations, 0);
  }
});

test("recruiter messages say the channel was left alone on archive failure, and that deletion failed on mutation failure", () => {
  const archive = archiveFailureMessage("alice-recruit", new ArchiveError("unsupported_attachment", "첨부 파일 v.mp4의 형식(video/mp4)은 보관소가 받지 않습니다."));
  assert.match(archive, /그대로 두었습니다/);
  assert.match(archive, /v\.mp4/);
  const mutation = archiveFailureMessage("alice-recruit", new MutationError("채널 삭제에 실패했습니다."));
  assert.match(mutation, /보관은 검증되었/);
  assert.match(mutation, /채널 삭제/);
  const unknown = archiveFailureMessage("alice-recruit", new Error("boom https://cdn.discordapp.com/x?hm=secret"));
  assert.match(unknown, /채널 상태를 확인/);
  assert.ok(!unknown.includes("hm=secret"));
});

test("client: numeric and HTTP-date Retry-After are bounded", async () => {
  const delays = [];
  let calls = 0;
  const client = new ArchiveClient({ baseUrl: "http://127.0.0.1:8000", token: "secret", postTimeoutMs: 500, getTimeoutMs: 500, maxRetries: 1, retryDelayMs: 1, maxRequestBytes: 1 << 24 }, async () => (++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0.01" } }) : new Response(JSON.stringify(response), { status: 200 })), async (ms) => delays.push(ms));
  await client.submit(payload);
  assert.deepEqual(delays, [10]);
  assert.equal(parseRetryAfter("Wed, 11 Sep 2026 12:00:10 GMT", Date.parse("2026-09-11T12:00:00Z"), 5000), 5000);
});

test("Discord pagination honors SDK collection cursor semantics", async () => {
  const all = Array.from({ length: 250 }, (_, index) => ({ id: String(1000 + index), createdTimestamp: index }));
  let calls = 0;
  const collection = (items) => ({ size: items.length, first: () => items[0], last: () => items[items.length - 1], values: function* () { yield* items; } });
  const channel = { messages: { fetch: async ({ limit, before } = {}) => { calls++; assert.equal(limit, 100); const eligible = before ? all.filter((m) => BigInt(m.id) < BigInt(before)) : all; return collection(eligible.slice(-100).reverse()); } } };
  const result = await fetchAllMessages(channel);
  assert.equal(calls, 3);
  assert.deepEqual(result.messages.map((m) => m.id), all.map((m) => m.id));
});

test("collector emits and deduplicates attachment/avatar/emoji/sticker/embed media", async () => {
  const cdn = (path) => `https://cdn.discordapp.com/${path}`;
  const author = { id: "300", displayAvatarURL: () => cdn("avatars/300/a.png?size=4096") };
  const attachment = { id: "500", url: cdn("attachments/1/500/file.txt?hm=1"), name: "file.txt", contentType: "text/plain", size: 14 };
  const message = { id: "400", author, attachments: new Map([["500", attachment]]), reactions: { cache: new Map([["r", { emoji: { id: "700", url: cdn("emojis/700.png") } }]]) }, stickers: new Map([["800", { id: "800", url: cdn("stickers/800.png"), name: "s" }]]), embeds: [{ toJSON: () => ({ id: "900", image: { url: cdn("i.png") }, thumbnail: { url: cdn("t.png") }, fields: [{ name: "media", value: "x", url: cdn("f.png") }] }) }] };
  const policy = { hosts: ["cdn.discordapp.com", "media.discordapp.net"], mimeTypes: ["image/png", "text/plain"], maxAttachmentBytes: 1 << 20 };
  const assets = await collectDownloadableAssets([message, message], async () => new Response(null, { status: 200, headers: { "content-length": "14", "content-type": "image/png" } }), policy, []);
  assert.deepEqual(new Set(assets.map((a) => a.kind)), new Set(["attachment", "avatar", "emoji", "sticker", "embed_image"]));
  assert.equal(assets.length, 7);
  assert.equal(new Set(assets.map((a) => `${a.kind}:${a.source_discord_id ?? a.source_url}`)).size, 7);
  assert.ok(assets.every((a) => a.size === 14 && a.owner_reference));
});

test("applicant uses authoritative state or narrows to exactly one eligible overwrite", async () => {
  const applicant = { id: "300", user: { bot: false }, roles: { cache: new Map() } };
  const recruiter = { id: "600", user: { bot: false }, roles: { cache: new Map([["r", { name: "리크루터" }]]) } };
  const members = new Map([["300", applicant], ["301", { ...applicant, id: "301" }], ["600", recruiter]]);
  const channel = { guild: { members: { fetch: async (id) => members.get(id) } }, permissionOverwrites: { cache: new Map([["a", { type: 1, id: "300" }], ["r", { type: 1, id: "600" }]]) } };
  assert.equal((await resolveApplicant({ user: { id: "600" } }, channel, { context: { applicantDiscordId: "301" } }, [])).id, "301");
  assert.equal((await resolveApplicant({ user: { id: "600" } }, channel, null, [])).id, "300");
  channel.permissionOverwrites.cache.set("b", { type: 1, id: "301" });
  await assert.rejects(resolveApplicant({ user: { id: "600" } }, channel, null, []), /후보 2명/);
});

test("confirmation nonce binds initiator, prompt message and channel", () => {
  const base = { user: { id: "42" }, customId: "archive:n:yes", message: { id: "m1" }, channelId: "c1" };
  assert.equal(isArchiveConfirmation("42", "n", "m1", "c1", base), true);
  assert.equal(isArchiveConfirmation("42", "n", "m2", "c1", base), false);
  assert.equal(isArchiveConfirmation("42", "other", "m1", "c1", base), false);
});

test("/grill_reload Move/Copy mutation failures compensate and report partial state truthfully", async () => {
  const make = ({ cloneFail = false, parentFail = false, nameFail = false, rollbackFail = false, deleteFail = false } = {}) => {
    const events = [];
    const clone = { delete: async () => { events.push("delete-clone"); if (deleteFail) throw Error("delete"); } };
    const channel = { parentId: "old", clone: async () => { events.push("clone"); if (cloneFail) throw Error("clone"); return clone; }, setParent: async function (id) { events.push(`parent:${id}`); if (id === "new" && parentFail) throw Error("parent"); if (id === "old" && rollbackFail) throw Error("rollback"); this.parentId = id; }, setName: async () => { events.push("name"); if (nameFail) throw Error("name"); } };
    return { channel, events };
  };
  let x = make(); await mutateArchivedChannel(x.channel, "new", "archived", "Move"); assert.deepEqual(x.events, ["parent:new", "name"]);
  x = make({ nameFail: true }); await assert.rejects(mutateArchivedChannel(x.channel, "new", "archived", "Move"), /롤백/); assert.deepEqual(x.events, ["parent:new", "name", "parent:old"]);
  x = make({ parentFail: true }); await assert.rejects(mutateArchivedChannel(x.channel, "new", "archived", "Copy"), /결과 불명/); assert.deepEqual(x.events, ["clone", "parent:new", "delete-clone"]);
  x = make({ nameFail: true, rollbackFail: true, deleteFail: true }); await assert.rejects(mutateArchivedChannel(x.channel, "new", "archived", "Copy"), /partial mutation/);
  x = make({ cloneFail: true }); await assert.rejects(mutateArchivedChannel(x.channel, "new", "archived", "Copy"), /시작되지/);
});
