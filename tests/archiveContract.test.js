// Contract tests against intel-archive's API (src/intel_archive/main.py, schemas.py, service.py).
const test = require("node:test");
const assert = require("node:assert/strict");
const { ArchiveClient, idempotencyKey, normalizeResponse } = require("../dist/lib/archive/ArchiveClient");
const { loadArchiveConfig, loadAssetPolicy } = require("../dist/lib/archive/config");
const { ArchiveError, MutationError } = require("../dist/lib/archive/errors");
const { archiveVerifyThenMutate, verifyArchive } = require("../dist/lib/archive/ArchiveWorkflow");
const { collectDownloadableAssets, assertArchivableAttachments } = require("../dist/lib/archive/ConsultationCollector");

const hashA = "a".repeat(64), hashB = "b".repeat(64), digest = "d".repeat(64);
const payload = {
  schema_version: 2, discord_guild_id: "100", discord_channel_id: "200", channel_name: "alice-recruit", recruitment_type: "NIS",
  applicant_discord_id: "300", applicant_display_name: "Alice", completed_by_discord_id: "600", completed_by_display_name: "Recruiter",
  started_at: "2026-09-10T10:00:00.000Z", captured_at: "2026-09-10T11:00:00.000Z", cutoff_message_id: "401", closed_at: "2026-09-10T11:00:00.000Z",
  guild: {}, channel: {}, permission_snapshot: {}, raw_snapshot: {},
  participants: [{ discord_user_id: "300", username: "alice", display_name: "Alice", role: "applicant" }],
  messages: [
    { discord_message_id: "400", author_discord_id: "300", author_name: "Alice", content: "mytoken=abc duration 3.0", created_at: "2026-09-10T10:00:00.000Z", edited_at: null, sequence: 0, attachments: [] },
    { discord_message_id: "401", author_discord_id: "300", author_name: "Alice", content: "file", created_at: "2026-09-10T10:01:00.000Z", edited_at: null, sequence: 1, attachments: [{ discord_attachment_id: "500", filename: "fixture.txt", content_type: "text/plain", size: 14, source_url: "https://cdn.discordapp.com/attachments/1/500/fixture.txt?ex=1&hm=2" }] },
  ],
  assets: [
    { kind: "attachment", source_discord_id: "500", source_url: "https://cdn.discordapp.com/attachments/1/500/fixture.txt?ex=1&hm=2", filename: "fixture.txt", content_type: "Text/Plain; charset=UTF-8", size: 14, owner_reference: { message_id: "401", attachment_id: "500" } },
    { kind: "avatar", source_discord_id: "300", source_url: "https://cdn.discordapp.com/avatars/300/a.png?size=4096", filename: "a.png", content_type: "image/png", size: 20, owner_reference: { participant_id: "300" } },
  ],
};
// What the server sends: discord_snapshot is its own canonical form (redaction rules, float formatting)
// that the bot does not re-derive; fields equal to their defaults are omitted (response_model_exclude_defaults).
function serverResponse(overrides = {}) {
  return {
    archive_id: "archive-1", schema_version: 2, status: "verified", discord_guild_id: "100", discord_channel_id: "200", cutoff_message_id: "401",
    sorted_message_ids: ["400", "401"],
    attachments: [{ discord_attachment_id: "500", sha256: hashA, actual_size: 14, verified: true }],
    assets: [
      { asset_id: "asset-1", kind: "attachment", source_discord_id: "500", filename: "fixture.txt", content_type: "text/plain", declared_size: 14, sha256: hashA, actual_size: 14, owner_reference: { message_id: "401", attachment_id: "500" }, verified: true },
      { asset_id: "asset-2", kind: "avatar", source_discord_id: "300", filename: "a.png", content_type: "image/png", declared_size: 20, sha256: hashB, actual_size: 20, owner_reference: { participant_id: "300" }, verified: true },
    ],
    discord_snapshot: { messages: [{ content: "mytoken=[REDACTED] duration 3.0", duration_secs: 3.0 }] },
    verification: { complete: true, submitted: { participants: 1, messages: 2, attachments: 1, assets: 2 }, stored: { participants: 1, messages: 2, attachments: 1, assets: 2 }, ordering_verified: true, attachments_verified: true, manifest_verified: true },
    manifest_digest: digest,
    ...overrides,
  };
}
const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const config = (extra = {}) => ({ baseUrl: "http://archive", token: "do-not-leak", postTimeoutMs: 50, getTimeoutMs: 50, maxRetries: 2, retryDelayMs: 1, maxRequestBytes: 16 * 1024 * 1024, ...extra });
const hang = (init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));

test("POST timeout is retried with the same Idempotency-Key and byte-identical body", async () => {
  const calls = []; const sleeps = [];
  const client = new ArchiveClient(config(), async (url, init) => { calls.push(init); return calls.length === 1 ? hang(init) : json(serverResponse()); }, async (ms) => sleeps.push(ms));
  const result = await client.submit(payload);
  assert.equal(result.archive_id, "archive-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["Idempotency-Key"], idempotencyKey(payload));
  assert.equal(calls[1].headers["Idempotency-Key"], calls[0].headers["Idempotency-Key"]);
  assert.ok(calls[0].headers["Idempotency-Key"].length <= 200);
  assert.equal(calls[1].body, calls[0].body);
  assert.equal(calls[0].headers.Authorization, "Bearer do-not-leak");
  assert.equal(sleeps.length, 1);
});

test("retryable outcomes: network error, 5xx, 429 and the server's 'retry with the same Idempotency-Key' 422", async () => {
  const outcomes = [
    () => { throw new TypeError("fetch failed"); },
    () => json({ detail: "boom" }, 503),
    () => json({ detail: "slow down" }, 429, { "retry-after": "0" }),
    () => json({ detail: { status: "failed", failure_reason: "archive commit outcome unknown; retry with the same Idempotency-Key" } }, 422),
  ];
  for (const first of outcomes) {
    let count = 0;
    const client = new ArchiveClient(config(), async () => (++count === 1 ? first() : json(serverResponse())), async () => {});
    assert.equal((await client.submit(payload)).archive_id, "archive-1");
    assert.equal(count, 2);
  }
});

test("retries are bounded and the last failure is reported as a timeout", async () => {
  let count = 0;
  const client = new ArchiveClient(config({ maxRetries: 2 }), async (_url, init) => { count++; return hang(init); }, async () => {});
  await assert.rejects(client.submit(payload), (error) => error instanceof ArchiveError && error.kind === "timeout" && !error.message.includes("do-not-leak"));
  assert.equal(count, 3);
});

test("non-retryable statuses map to clear reasons and are not retried", async () => {
  const cases = [
    [json({ detail: "channel was already archived with different content" }, 409), "conflict", /이미 보관되어/],
    [json({ detail: "invalid bearer token" }, 401), "auth", /인증/],
    [json({ detail: "request body too large" }, 413), "too_large", /너무 큽니다/],
    [json({ detail: { status: "failed", failure_reason: "attachment MIME type is not allowed" } }, 422), "rejected", /attachment MIME type is not allowed/],
    [json({ detail: [{ type: "string_pattern_mismatch", loc: ["body", "discord_guild_id"], msg: "x" }] }, 422), "invalid_request", /body\.discord_guild_id:string_pattern_mismatch/],
    [json({ detail: "valid Idempotency-Key header required" }, 400), "invalid_request", /400/],
  ];
  for (const [response, kind, pattern] of cases) {
    let count = 0;
    const client = new ArchiveClient(config(), async () => { count++; return response.clone(); }, async () => {});
    await assert.rejects(client.submit(payload), (error) => error instanceof ArchiveError && error.kind === kind && pattern.test(error.message));
    assert.equal(count, 1, kind);
  }
});

test("server failure reasons are shown without URLs or control characters", async () => {
  const client = new ArchiveClient(config(), async () => json({ detail: { status: "failed", failure_reason: "download https://cdn.discordapp.com/x?hm=secret failed\nnext" } }, 422), async () => {});
  await assert.rejects(client.submit(payload), (error) => !error.message.includes("hm=secret") && !error.message.includes("\n") && error.message.includes("[URL]"));
});

test("GET 404 (not yet verified) is not retried and fails", async () => {
  let count = 0;
  const client = new ArchiveClient(config(), async () => { count++; return json({ detail: "verified archive not found" }, 404); }, async () => {});
  await assert.rejects(client.get("archive-1"), (error) => error.kind === "not_found");
  assert.equal(count, 1);
});

test("oversized payload is refused before sending", async () => {
  let count = 0;
  const client = new ArchiveClient(config({ maxRequestBytes: 100 }), async () => { count++; return json(serverResponse()); }, async () => {});
  await assert.rejects(client.submit(payload), (error) => error.kind === "too_large");
  assert.equal(count, 0);
});

test("responses with default-valued fields omitted are filled with the contract defaults", () => {
  const omitted = serverResponse({ assets: undefined });
  delete omitted.assets; delete omitted.verification.submitted.assets; delete omitted.verification.stored.assets;
  const normalized = normalizeResponse(omitted);
  assert.deepEqual(normalized.assets, []);
  assert.equal(normalized.failure_reason, null);
  assert.equal(normalized.idempotent_replay, false);
  assert.equal(normalized.verification.assets_verified, true);
  assert.equal(normalized.verification.submitted.assets, 0);
  assert.equal(normalized.verification.stored.assets, 0);
  assert.throws(() => normalizeResponse({ archive_id: "x" }), (error) => error.kind === "schema");
});

test("a payload without assets verifies against an exclude_defaults response", () => {
  const bare = { ...payload, messages: [payload.messages[0], { ...payload.messages[1], attachments: [] }], assets: [] };
  const raw = serverResponse({ attachments: [] });
  delete raw.assets; raw.verification.submitted = { participants: 1, messages: 2, attachments: 0 }; raw.verification.stored = { participants: 1, messages: 2, attachments: 0 };
  const response = normalizeResponse(raw);
  verifyArchive(bare, response, structuredClone(response));
});

test("verification trusts the server's own manifest check instead of re-deriving its redaction", () => {
  // discord_snapshot differs from the submitted text (server redaction, 3.0 vs 3); still verified.
  const posted = normalizeResponse(serverResponse());
  verifyArchive(payload, posted, structuredClone(posted));
});

test("verification fails closed on every contract mismatch", () => {
  const base = () => normalizeResponse(serverResponse());
  const mutations = {
    status: (r) => { r.status = "failed"; },
    complete: (r) => { r.verification.complete = false; },
    manifest: (r) => { r.verification.manifest_verified = false; },
    ordering: (r) => { r.verification.ordering_verified = false; },
    storedCount: (r) => { r.verification.stored.messages = 1; },
    submittedCount: (r) => { r.verification.submitted.attachments = 2; r.verification.stored.attachments = 2; },
    assetCount: (r) => { r.verification.submitted.assets = 3; r.verification.stored.assets = 3; },
    identity: (r) => { r.discord_channel_id = "999"; },
    cutoff: (r) => { r.cutoff_message_id = "400"; },
    schema: (r) => { r.schema_version = 1; },
    order: (r) => { r.sorted_message_ids = ["401", "400"]; },
    attachmentSize: (r) => { r.attachments[0].actual_size = 13; },
    attachmentHash: (r) => { r.attachments[0].sha256 = "bad"; },
    attachmentUnverified: (r) => { r.attachments[0].verified = false; },
    attachmentMissing: (r) => { r.attachments = []; },
    assetHash: (r) => { r.assets[1].sha256 = "nothex"; },
    assetSize: (r) => { r.assets[1].actual_size = 1; },
    assetOwner: (r) => { r.assets[1].owner_reference = { participant_id: "999" }; },
    assetKind: (r) => { r.assets[1].kind = "emoji"; },
    digestFormat: (r) => { r.manifest_digest = ""; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const bad = base(); mutate(bad);
    assert.throws(() => verifyArchive(payload, bad, structuredClone(bad)), (error) => error instanceof ArchiveError && error.kind === "verification", `POST ${name}`);
    assert.throws(() => verifyArchive(payload, base(), bad), (error) => error instanceof ArchiveError, `GET ${name}`);
  }
});

test("POST and GET must agree with each other", () => {
  const cross = {
    archiveId: (r) => { r.archive_id = "archive-2"; },
    digest: (r) => { r.manifest_digest = "e".repeat(64); },
    snapshot: (r) => { r.discord_snapshot = { messages: [] }; },
    attachmentHash: (r) => { r.attachments[0].sha256 = "c".repeat(64); },
    assetId: (r) => { r.assets[0].asset_id = "asset-9"; },
  };
  for (const [name, mutate] of Object.entries(cross)) {
    const readBack = normalizeResponse(serverResponse()); mutate(readBack);
    assert.throws(() => verifyArchive(payload, normalizeResponse(serverResponse()), readBack), (error) => error.kind === "verification", name);
  }
});

test("no channel mutation on any archive failure; mutation failures are typed separately", async () => {
  const ok = normalizeResponse(serverResponse());
  const failing = [
    { collect: async () => { throw new Error("history"); }, client: {} },
    { collect: async () => payload, client: { submit: async () => { throw new ArchiveError("conflict", "이미 다른 내용"); } } },
    { collect: async () => payload, client: { submit: async () => ok, get: async () => { throw new ArchiveError("not_found", "404"); } } },
    { collect: async () => payload, client: { submit: async () => ok, get: async () => ({ ...ok, manifest_digest: "f".repeat(64) }) } },
  ];
  for (const dependencies of failing) {
    let mutations = 0;
    await assert.rejects(archiveVerifyThenMutate({}, {}, dependencies, async () => mutations++), (error) => error instanceof ArchiveError);
    assert.equal(mutations, 0);
  }
  await assert.rejects(
    archiveVerifyThenMutate({}, {}, { collect: async () => payload, client: { submit: async () => ok, get: async () => structuredClone(ok) } }, async () => { throw new Error("setParent"); }),
    (error) => error instanceof MutationError,
  );
  const verified = await archiveVerifyThenMutate({}, {}, { collect: async () => payload, client: { submit: async () => ok, get: async () => structuredClone(ok) } }, async () => {});
  assert.equal(verified.archive_id, "archive-1");
});

test("config: long POST timeout by default, token required, URL validated, total inside Discord's 15 minutes", () => {
  const c = loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x" });
  assert.equal(c.postTimeoutMs, 180000);
  assert.throws(() => loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x", INTEL_ARCHIVE_TIMEOUT_MS: "600000" }), (error) => error.kind === "config");
  assert.equal(c.getTimeoutMs, 30000);
  assert.equal(c.maxRetries, 2);
  assert.equal(c.baseUrl, "http://127.0.0.1:8000");
  assert.throws(() => loadArchiveConfig({}), (error) => error.kind === "config");
  assert.throws(() => loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x", INTEL_ARCHIVE_URL: "ftp://x" }), (error) => error.kind === "config");
  assert.throws(() => loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x", INTEL_ARCHIVE_TIMEOUT_MS: "abc" }), (error) => error.kind === "config");
  const policy = loadAssetPolicy({});
  assert.deepEqual(policy.hosts, ["cdn.discordapp.com", "media.discordapp.net"]);
  assert.ok(policy.mimeTypes.includes("image/png") && !policy.mimeTypes.includes("video/mp4"));
  assert.equal(policy.maxAttachmentBytes, 25 * 1024 * 1024);
});

const policy = { hosts: ["cdn.discordapp.com", "media.discordapp.net"], mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"], maxAttachmentBytes: 25 * 1024 * 1024 };
const head = (type, length = "20") => new Response(null, { status: 200, headers: { "content-type": type, "content-length": length } });

test("embed images download from Discord's proxy; external-only images and disallowed MIME assets are omitted", async () => {
  const headed = [];
  const author = { id: "300", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/300/a.png?size=4096" };
  const message = {
    id: "400", author, attachments: new Map(), reactions: { cache: new Map() },
    stickers: new Map([["800", { id: "800", url: "https://media.discordapp.net/stickers/800.json", name: "lottie" }]]),
    embeds: [{ toJSON: () => ({ image: { url: "https://i.ytimg.com/vi/x/hq.jpg", proxy_url: "https://images-ext-1.discordapp.net/external/abc/hq.jpg" }, thumbnail: { url: "https://example.com/t.png", proxy_url: "https://media.discordapp.net/external/t.png?w=1" } }) }],
  };
  const omitted = [];
  const assets = await collectDownloadableAssets([message], async (url, init) => { headed.push([url, init.redirect]); return head(url.endsWith(".json") ? "application/json" : "image/png"); }, policy, omitted);
  const thumb = assets.find((a) => a.kind === "embed_image");
  assert.equal(thumb.source_url, "https://media.discordapp.net/external/t.png?w=1");
  assert.equal(thumb.owner_reference.url, "https://example.com/t.png");
  assert.equal(thumb.owner_reference.embed_part, "thumbnail");
  assert.equal(assets.filter((a) => a.kind === "embed_image").length, 1);
  assert.ok(!assets.some((a) => a.kind === "sticker"));
  assert.ok(headed.every(([url]) => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url)), "no HEAD to non-allowlisted hosts");
  assert.ok(headed.every(([, redirect]) => redirect === "manual"));
  assert.deepEqual(new Set(omitted.map((o) => o.reason)), new Set(["host_not_allowed", "mime_not_allowed"]));
  assert.ok(omitted.every((o) => !("source_url" in o)));
});

test("optional asset metadata failures omit the asset instead of failing the archive", async () => {
  const author = { id: "300", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/300/a.png" };
  const message = { id: "400", author, attachments: new Map(), reactions: { cache: new Map([["r", { emoji: { id: "700", url: "https://cdn.discordapp.com/emojis/700.png" } }]]) }, stickers: new Map(), embeds: [] };
  const omitted = [];
  const assets = await collectDownloadableAssets([message], async (url) => (url.includes("emojis") ? new Response(null, { status: 302, headers: { location: "https://elsewhere" } }) : head("image/png")), policy, omitted);
  assert.deepEqual(assets.map((a) => a.kind), ["avatar"]);
  assert.deepEqual(omitted, [{ kind: "emoji", source_discord_id: "700", reason: "metadata_unavailable" }]);
});

test("attachment assets keep the signed Discord URL the server must download", async () => {
  const author = { id: "300", displayAvatarURL: () => null };
  const signed = "https://cdn.discordapp.com/attachments/1/500/f.png?ex=1&is=2&hm=3";
  const message = { id: "400", author, attachments: new Map([["500", { id: "500", url: signed, name: "f.png", contentType: "image/png", size: 10 }]]), reactions: { cache: new Map() }, stickers: new Map(), embeds: [] };
  const [asset] = await collectDownloadableAssets([message], async () => { throw new Error("no HEAD expected"); }, policy, []);
  assert.equal(asset.source_url, signed);
});

test("attachments the archive will not accept stop the archive before submission with a reason", () => {
  const msg = (attachments) => ({ id: "400", attachments: new Map(attachments.map((a) => [a.id, a])) });
  assertArchivableAttachments([msg([{ id: "1", url: "https://cdn.discordapp.com/a/1/x.png?hm=1", name: "x.png", contentType: "image/png", size: 10 }])], policy);
  const cases = [
    [{ id: "2", url: "https://cdn.discordapp.com/a/2/v.mp4", name: "v.mp4", contentType: "video/mp4", size: 10 }, /v\.mp4.*video\/mp4/],
    [{ id: "3", url: "https://cdn.discordapp.com/a/3/big.png", name: "big.png", contentType: "image/png", size: 26 * 1024 * 1024 }, /big\.png.*크기/],
    [{ id: "4", url: "https://evil.example/a/4/x.png", name: "x.png", contentType: "image/png", size: 10 }, /x\.png.*주소/],
  ];
  for (const [attachment, pattern] of cases) assert.throws(() => assertArchivableAttachments([msg([attachment])], policy), (error) => error.kind === "unsupported_attachment" && pattern.test(error.message));
});

test("409 for a concurrent request still running on the server is retried with the same key; other 409s are not", async () => {
  let count = 0;
  const client = new ArchiveClient(config(), async () => (++count === 1 ? json({ detail: "concurrent archive did not produce a verified result" }, 409) : json(serverResponse())), async () => {});
  assert.equal((await client.submit(payload)).archive_id, "archive-1");
  assert.equal(count, 2);
  count = 0;
  const permanent = new ArchiveClient(config(), async () => { count++; return json({ detail: "idempotency key was already used with different content" }, 409); }, async () => {});
  await assert.rejects(permanent.submit(payload), (error) => error.kind === "conflict");
  assert.equal(count, 1);
});

test("config: the worst case of every POST/GET attempt, backoff and Retry-After wait fits Discord's reply window", () => {
  loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x" });
  assert.throws(() => loadArchiveConfig({ INTEL_ARCHIVE_TOKEN: "x", INTEL_ARCHIVE_TIMEOUT_MS: "200000", INTEL_ARCHIVE_GET_TIMEOUT_MS: "60000" }), (error) => error.kind === "config");
});

test("optional media HEADs run at most 8 at a time and a transient failure is retried once", async () => {
  let active = 0, peak = 0;
  const calls = new Map();
  const reactions = new Map(Array.from({ length: 30 }, (_, i) => [String(i), { emoji: { id: String(700 + i), url: `https://cdn.discordapp.com/emojis/${700 + i}.png` } }]));
  const message = { id: "400", author: { id: "300", displayAvatarURL: () => null }, attachments: new Map(), reactions: { cache: reactions }, stickers: new Map(), embeds: [] };
  const assets = await collectDownloadableAssets([message], async (url) => {
    active++; peak = Math.max(peak, active);
    calls.set(url, (calls.get(url) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return url.endsWith("/700.png") && calls.get(url) === 1 ? new Response(null, { status: 503 }) : head("image/png");
  }, policy, []);
  assert.ok(peak <= 8, `peak ${peak}`);
  assert.equal(assets.length, 30);
  assert.equal(calls.get("https://cdn.discordapp.com/emojis/700.png"), 2);
});

test("asset hosts with an explicit port are not allowed", () => {
  const msg = { id: "400", attachments: new Map([["1", { id: "1", url: "https://cdn.discordapp.com:8443/a/1/x.png", name: "x.png", contentType: "image/png", size: 10 }]]) };
  assert.throws(() => assertArchivableAttachments([msg], policy), (error) => error.kind === "unsupported_attachment");
});
