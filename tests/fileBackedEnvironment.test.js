const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  loadFileBackedEnvironmentVariables,
} = require("../dist/lib/functions.js");

function withSecretFile(value, callback) {
  const tempRoot = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, "secret-test-"));
  const secretPath = path.join(directory, "secret");
  fs.writeFileSync(secretPath, value, { mode: 0o600 });

  try {
    callback(secretPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const variableName of [
  "DISCORD_TOKEN",
  "SEAT_TOKEN",
  "INTEL_ARCHIVE_TOKEN",
]) {
  test(`loads ${variableName} from a Docker secret file`, () => {
    withSecretFile(`${variableName.toLowerCase()}-value\n`, (secretPath) => {
      delete process.env[variableName];
      process.env[`${variableName}_FILE`] = secretPath;

      loadFileBackedEnvironmentVariables();

      assert.equal(process.env[variableName], `${variableName.toLowerCase()}-value`);
      delete process.env[variableName];
      delete process.env[`${variableName}_FILE`];
    });
  });
}

test("does not replace an explicitly supplied environment variable", () => {
  withSecretFile("file-secret", (secretPath) => {
    process.env.SEAT_TOKEN = "environment-secret";
    process.env.SEAT_TOKEN_FILE = secretPath;

    loadFileBackedEnvironmentVariables();

    assert.equal(process.env.SEAT_TOKEN, "environment-secret");
    delete process.env.SEAT_TOKEN;
    delete process.env.SEAT_TOKEN_FILE;
  });
});

test("rejects an empty Docker secret", () => {
  withSecretFile("\n", (secretPath) => {
    delete process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN_FILE = secretPath;

    assert.throws(
      () => loadFileBackedEnvironmentVariables(),
      /DISCORD_TOKEN_FILE points to an empty file/,
    );
    delete process.env.DISCORD_TOKEN_FILE;
  });
});

test("preserves intentional leading and trailing whitespace", () => {
  withSecretFile("  password with spaces  \n", (secretPath) => {
    delete process.env.SEAT_TOKEN;
    process.env.SEAT_TOKEN_FILE = secretPath;

    loadFileBackedEnvironmentVariables();

    assert.equal(process.env.SEAT_TOKEN, "  password with spaces  ");
    delete process.env.SEAT_TOKEN;
    delete process.env.SEAT_TOKEN_FILE;
  });
});
