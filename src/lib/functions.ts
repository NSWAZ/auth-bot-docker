import { Client, ActivityType } from "discord.js";
import log, { LogLevelDesc } from "loglevel";
import fs from "node:fs";

const fileBackedEnvironmentVariables = [
  "DISCORD_TOKEN",
  "SEAT_TOKEN",
  "INTEL_ARCHIVE_TOKEN",
] as const;

export function loadFileBackedEnvironmentVariables() {
  for (const variableName of fileBackedEnvironmentVariables) {
    if (process.env[variableName]) continue;

    const filePath = process.env[`${variableName}_FILE`];
    if (!filePath) continue;

    const value = fs.readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
    if (!value) {
      throw new Error(`${variableName}_FILE points to an empty file.`);
    }

    process.env[variableName] = value;
  }
}

/**
 * .env 파일 또는 Docker 환경 변수에서 환경 변수를 로드합니다.
 */
export function loadEnvironmentVariables() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./loadEnvironmentVariables");
  } catch {
    log.warn(".env not found. using docker environment variable");
  }

  loadFileBackedEnvironmentVariables();
}

/**
 * 디스코드 상태를 설정합니다.
 */
export function setDiscordPresence(client: Client, state: string) {
  client.user?.setPresence({
    activities: [
      {
        type: ActivityType.Custom,
        name: "custom",
        state: state,
      },
    ],
  });
}

/**
 * 로그 레벨을 설정합니다
 */
export function setDefaultLogLevel() {
  // Empty LOG_LEVEL values must preserve the existing INFO fallback behavior.
  log.setDefaultLevel((process.env.LOG_LEVEL as LogLevelDesc) || "INFO");
}

/**
 * Waits for `promise` at most `ms`. Used before exiting so a stuck Discord call cannot keep a
 * crashed or stopping process alive.
 */
export async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<"settled" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
