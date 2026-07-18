/**
 * Publishes RPG Maker character sheets (Graphics/Characters/*.png) to the
 * asset-storage server so the client can animate imported map events from the
 * full 4x4 sheet (4 walk frames x 4 facing rows) instead of the single
 * pre-cropped frame embedded at import time.
 *
 * Sheets land at <target>/<name>.png and are served as
 * /migration_exports/characters/<name>.png — the URL NpcSprite derives from
 * an event page's graphic.characterName.
 *
 * Usage:
 *   npx ts-node tools/publishCharacterSheets.ts "<essentialsProject>/Graphics/Characters" \
 *     [--target <dir>] [--dry-run]
 *   # remote upload instead of local copy (nginx upload-api):
 *   npx ts-node tools/publishCharacterSheets.ts "<...>/Graphics/Characters" \
 *     --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN
 *
 * Re-running is safe: files are overwritten by name, nothing is deleted.
 */
import { promises as fs } from "fs";
import path from "path";

const CHARACTERS_ASSET_PATH = "migration_exports/characters";

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const flagValue = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const sourceDir = positional[0];

  if (!sourceDir) {
    console.error(
      "Usage: publishCharacterSheets.ts <charactersDir> [--target <dir>] " +
        "[--upload-url <origin> --token <token>] [--dry-run]"
    );
    process.exit(1);
  }

  const uploadUrl = flagValue("--upload-url");
  const uploadToken = flagValue("--token") || process.env.ASSET_UPLOAD_TOKEN;
  const targetDir =
    flagValue("--target") ||
    process.env.CHARACTER_ASSETS_DIR ||
    path.resolve(process.cwd(), "../asset-storage/assets", CHARACTERS_ASSET_PATH);

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const sheets = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name)
    .sort();

  if (sheets.length === 0) {
    console.error(`No .png sheets found in ${sourceDir}`);
    process.exit(1);
  }

  console.log(
    `${sheets.length} sheets from ${sourceDir} -> ` +
      (uploadUrl ? `${uploadUrl}/api/upload/${CHARACTERS_ASSET_PATH}/` : targetDir) +
      (dryRun ? " (dry run)" : "")
  );

  if (dryRun) {
    return;
  }

  if (uploadUrl) {
    if (!uploadToken) {
      console.error("--upload-url requires --token or ASSET_UPLOAD_TOKEN.");
      process.exit(1);
    }
    let uploaded = 0;
    for (const name of sheets) {
      const body = await fs.readFile(path.join(sourceDir, name));
      const response = await fetch(
        `${uploadUrl.replace(/\/+$/, "")}/api/upload/${CHARACTERS_ASSET_PATH}/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${uploadToken}`,
            "Content-Type": "image/png",
          },
          body,
        }
      );
      if (!response.ok) {
        throw new Error(`Upload failed for ${name}: ${response.status} ${await response.text()}`);
      }
      uploaded += 1;
    }
    console.log(`Uploaded ${uploaded} sheets.`);
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  for (const name of sheets) {
    await fs.copyFile(path.join(sourceDir, name), path.join(targetDir, name));
  }
  console.log(`Copied ${sheets.length} sheets to ${targetDir}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
