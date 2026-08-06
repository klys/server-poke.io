/**
 * Batch migration: legacy single-character accounts -> account/character split.
 *
 * For every `auth:user:{id}` hash that has no `characters` field yet, this
 * moves the per-character gameplay fields (party, inventory, money, position,
 * badges, event state, ...) onto a new `auth:character:{id}` hash (the default
 * character reuses the account id), stamps every shared-box asset with that
 * character as its owner, converts the legacy `pc_money` balance into a
 * shared-currency deposit owned by it, and dedupes/self-filters the friends
 * list. Account-level data (credentials, profile, friends, requests, prefs,
 * box containers) stays on the account hash.
 *
 * The server also performs this migration lazily on first read of each
 * account (Auth.migrateAccountHash), so this tool exists to (a) migrate a
 * whole database up front in one pass and (b) report what it did. Running it
 * twice is safe — migrated accounts are skipped.
 *
 * Usage:
 *   npx ts-node tools/migrateAccountsToCharacters.ts [--dry-run]
 */
import { createClient } from "redis";
import type { RedisClientType } from "redis";
import Auth from "../components/Auth";
import MailService from "../components/MailService";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  const auth = new Auth(redis as RedisClientType, new MailService());

  const highestUserId = Number.parseInt((await redis.get("auth:user:id:sequence")) ?? "0", 10);
  if (!Number.isFinite(highestUserId) || highestUserId <= 0) {
    console.log("No accounts found (auth:user:id:sequence is empty). Nothing to do.");
    await redis.quit();
    return;
  }

  let migrated = 0;
  let alreadyMigrated = 0;
  let missing = 0;

  for (let userId = 1; userId <= highestUserId; userId += 1) {
    const account = await redis.hGetAll(`auth:user:${userId}`);
    if (!account.id) {
      missing += 1;
      continue;
    }
    if (account.characters) {
      alreadyMigrated += 1;
      continue;
    }
    if (dryRun) {
      console.log(
        `[dry-run] would migrate account ${userId} (${account.username ?? "?"}): ` +
        `money=${account.money ?? "-"} pc_money=${account.pc_money ?? "-"} ` +
        `party=${account.pokemon_party ? "yes" : "no"} box=${account.pokemon_box ? "yes" : "no"}`
      );
      migrated += 1;
      continue;
    }
    await auth.migrateAccountHash(userId, account);
    migrated += 1;
    console.log(`migrated account ${userId} (${account.username ?? "?"}) -> character ${userId}`);
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}done: ${migrated} migrated, ` +
    `${alreadyMigrated} already migrated, ${missing} ids without an account (deleted/gaps).`
  );
  await redis.quit();
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exit(1);
});
