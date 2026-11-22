// Recruit flow promises must not escape unhandled: in Node 22 an unhandled rejection ends the
// process through the uncaughtException handler, which would stop both guilds' bot.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RecruitActions } = require("../dist/lib/classes/recruit/Actions");
const { RecruitHandler } = require("../dist/lib/classes/recruit/Handler");

async function unhandledDuring(run) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}
const failingChannel = () => ({ id: "200", name: "alice-recruit", send: async () => { throw new Error("Missing Access"); } });

test("error message fallback to the channel does not leave a rejected send behind", async () => {
  const seen = await unhandledDuring(() => RecruitActions.sendErrorMessage(null, failingChannel()));
  assert.deepEqual(seen, []);
});

test("a failed term message is reported to the caller instead of escaping", async () => {
  let rejected = false;
  const seen = await unhandledDuring(async () => { await RecruitActions.showTerm(failingChannel(), 0).catch(() => { rejected = true; }); });
  assert.equal(rejected, true);
  assert.deepEqual(seen, []);
});

test("a failing state-change handler of a restored session is logged, not left unhandled", async () => {
  const backup = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v3.0.2-state-backup.json"), "utf8"));
  const [channelId, snapshot] = Object.entries(backup.sessions)[0];
  const handler = new RecruitHandler({});
  handler.handleStateChange = async () => { throw new Error("state change failed"); };
  const seen = await unhandledDuring(async () => {
    await handler.restoreSession(channelId, "alice-recruit", {}, snapshot);
    handler.getStateMachineHandler().sendEvent(channelId, { type: "CONFIRM_CONDITIONS", interaction: null });
  });
  assert.deepEqual(seen, []);
});

test("the agree-conditions message waits for the confirmation it sends", async () => {
  const handler = new RecruitHandler({});
  const machine = handler.getStateMachineHandler();
  machine.getCurrentState = () => ({ matches: (state) => state === "checkingConditions" });
  machine.sendEvent = () => {};
  await assert.rejects(handler.handleAgreeConditionsMessage(failingChannel()), /Missing Access/);
});

test("the recruit error message names a contact only from RECRUIT_ERROR_CONTACT_ID", () => {
  const { recruitErrorMessage } = require("../dist/lib/classes/recruit/Actions");
  assert.match(recruitErrorMessage("t1", "123456789012345678"), /<@123456789012345678> 에게 문의/);
  for (const contact of [undefined, "", "not-an-id", "<@1>"]) {
    const text = recruitErrorMessage("t1", contact);
    assert.ok(!text.includes("<@"), String(contact));
    assert.match(text, /리크루터에게 문의/);
  }
});

test("shutdown backups are bounded so a stuck Discord call cannot keep a crashed process alive", async () => {
  const { settleWithin } = require("../dist/lib/functions");
  const started = Date.now();
  assert.equal(await settleWithin(new Promise(() => {}), 50), "timeout");
  assert.ok(Date.now() - started < 1000);
  assert.equal(await settleWithin(Promise.resolve(1), 50), "settled");
  assert.equal(await settleWithin(Promise.reject(new Error("x")), 50), "settled");
});
