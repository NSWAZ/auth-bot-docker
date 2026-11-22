import fs from "node:fs";
import log from "loglevel";

/**
 * Ban list used by the recruit flow. It names third parties, so it is not kept in the
 * repository: operators mount it as a Swarm config/secret and point BAN_LIST_FILE at it.
 *
 * File format (JSON):
 *   { "categories": [ { "label": "...", "char": ["..."], "corp": ["..."], "alli": ["..."] } ] }
 */
export interface BanListCategory {
  label: string;
  char: string[];
  corp: string[];
  alli: string[];
}

export interface BanList {
  categories: BanListCategory[];
}

export interface BanMatch {
  label: string;
  type: "char" | "corp" | "alli";
  name: string;
}

const EMPTY: BanList = { categories: [] };

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`BAN_LIST_FILE: ${field} must be an array of strings.`);
  return [...value];
}

export function parseBanList(text: string): BanList {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("BAN_LIST_FILE is not valid JSON.");
  }
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { categories?: unknown }).categories)
  )
    throw new Error("BAN_LIST_FILE must contain a categories array.");
  const categories = (data as { categories: unknown[] }).categories.map(
    (item, index) => {
      if (!item || typeof item !== "object")
        throw new Error(
          `BAN_LIST_FILE: categories[${index}] must be an object.`,
        );
      const category = item as Record<string, unknown>;
      if (typeof category.label !== "string" || !category.label.trim())
        throw new Error(
          `BAN_LIST_FILE: categories[${index}].label is required.`,
        );
      return {
        label: category.label,
        char: stringList(category.char, `categories[${index}].char`),
        corp: stringList(category.corp, `categories[${index}].corp`),
        alli: stringList(category.alli, `categories[${index}].alli`),
      };
    },
  );
  return { categories };
}

/**
 * Reads BAN_LIST_FILE. A missing variable or file gives an empty list and a warning, so the
 * bot still runs; a file that exists but is malformed throws, so a broken config is noticed.
 */
export function loadBanList(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
): BanList {
  const path = env.BAN_LIST_FILE;
  if (!path) {
    log.warn("BAN_LIST_FILE is not set; the recruit ban list check is empty.");
    return EMPTY;
  }
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.warn(
        "BAN_LIST_FILE does not exist; the recruit ban list check is empty.",
      );
      return EMPTY;
    }
    throw new Error("BAN_LIST_FILE could not be read.");
  }
  return parseBanList(text);
}

let cached: BanList | undefined;

/** The ban list loaded once per process (index.ts loads it at startup). */
export function getBanList(): BanList {
  cached ??= loadBanList();
  return cached;
}

export function findBanMatches(
  list: BanList,
  info: { char: string[]; corp: string[]; alli?: string[] },
): BanMatch[] {
  const matches: BanMatch[] = [];
  for (const category of list.categories) {
    for (const type of ["char", "corp", "alli"] as const) {
      const names = info[type];
      if (!names) continue;
      for (const name of category[type]) {
        if (names.includes(name))
          matches.push({ label: category.label, type, name });
      }
    }
  }
  return matches;
}
