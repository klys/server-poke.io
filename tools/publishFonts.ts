/**
 * Publishes the game's font files (Fonts/*.ttf|otf) to asset-storage under
 * /fonts/ and seeds designer:section:fonts with one item per font
 * (fontProfile: assetId, sourcePath, familyName), so the designer Fonts
 * section finally has real content.
 *
 * Usage:
 *   npx ts-node tools/publishFonts.ts ["<project>/Fonts"] [--dry-run]
 *   # defaults to ~/Downloads/Venova Adventure/Fonts
 *   # remote upload: --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN
 *
 * Idempotent: files are overwritten by name and section items merged by id.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { createClient } from "redis";

const FONTS_SECTION_KEY = "designer:section:fonts";
const FONTS_ASSET_PATH = "fonts";

// Known family names for the classic Pokemon Essentials fonts; anything not
// listed falls back to a cleaned-up file name.
const FAMILY_NAMES: Record<string, string> = {
  "pkmndp.ttf": "Power Green",
  "pkmndpb.ttf": "Power Green Bold",
  "pkmnem.ttf": "Power Clear",
  "pkmnemn.ttf": "Power Clear Narrow",
  "pkmnems.ttf": "Power Clear Small",
  "pkmnfl.ttf": "Power Red and Blue",
  "pkmnrs.ttf": "Power Red and Green",
  "pkmnrsi.ttf": "Power Red and Green Intl",
};

function sanitizeFileName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

function familyNameFor(fileName: string) {
  const known = FAMILY_NAMES[fileName.toLowerCase()];

  if (known) {
    return known;
  }

  return fileName
    .replace(/\.(ttf|otf)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1]?.startsWith("--") !== true);
  const flagValue = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const sourceDir =
    positional.find((arg) => !arg.startsWith("--")) ||
    path.join(os.homedir(), "Downloads", "Venova Adventure", "Fonts");
  const uploadUrl = flagValue("--upload-url");
  const uploadToken = flagValue("--token") || process.env.ASSET_UPLOAD_TOKEN;
  const targetDir =
    flagValue("--target") ||
    path.resolve(process.cwd(), "../asset-storage/assets", FONTS_ASSET_PATH);

  if (uploadUrl && !uploadToken) {
    console.error("--upload-url requires --token or ASSET_UPLOAD_TOKEN.");
    process.exit(1);
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const fonts = entries
    .filter((entry) => entry.isFile() && /\.(ttf|otf)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (fonts.length === 0) {
    console.error(`No .ttf/.otf fonts found in ${sourceDir}`);
    process.exit(1);
  }

  console.log(
    `${fonts.length} fonts from ${sourceDir} -> ` +
      (uploadUrl ? `${uploadUrl}/api/upload/${FONTS_ASSET_PATH}/` : targetDir) +
      (dryRun ? " (dry run)" : "")
  );

  if (!dryRun) {
    for (const name of fonts) {
      const body = await fs.readFile(path.join(sourceDir, name));
      const safeName = sanitizeFileName(name);

      if (uploadUrl) {
        const response = await fetch(
          `${uploadUrl.replace(/\/+$/, "")}/api/upload/${FONTS_ASSET_PATH}/${safeName}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${uploadToken}`, "Content-Type": "font/ttf" },
            body,
          }
        );

        if (!response.ok) {
          throw new Error(`Upload failed for ${name}: ${response.status}`);
        }
      } else {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, safeName), body);
      }
    }
  }

  // Seed the designer section.
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  try {
    const raw = await redis.get(FONTS_SECTION_KEY);
    const payload = raw
      ? JSON.parse(raw)
      : {
          sectionKey: "fonts",
          state: { categories: ["Runtime Fonts"], items: [] },
          version: 0,
          updatedAt: null,
          updatedByUserId: null,
          updatedByUsername: null,
        };
    const existingItems: Array<{ id: string }> = Array.isArray(payload?.state?.items)
      ? payload.state.items
      : [];

    const fontItems = fonts.map((name) => {
      const safeName = sanitizeFileName(name);
      const familyName = familyNameFor(name);

      return {
        id: `font-${safeName.toLowerCase().replace(/\./g, "-")}`,
        name: familyName,
        category: "Runtime Fonts",
        details: [
          { label: "File", value: safeName },
          { label: "Family", value: familyName },
          { label: "Path", value: `/${FONTS_ASSET_PATH}/${safeName}` },
        ],
        fontProfile: {
          assetId: `font-${safeName.toLowerCase().replace(/\./g, "-")}`,
          sourcePath: `/${FONTS_ASSET_PATH}/${safeName}`,
          familyName,
        },
      };
    });
    const fontIds = new Set(fontItems.map((item) => item.id));
    const keptItems = existingItems.filter((item) => !fontIds.has(item?.id));

    const categories: string[] = Array.isArray(payload?.state?.categories)
      ? payload.state.categories.filter((c: unknown): c is string => typeof c === "string")
      : [];

    payload.sectionKey = "fonts";
    payload.state = {
      categories: categories.includes("Runtime Fonts")
        ? categories
        : ["Runtime Fonts", ...categories],
      items: [...fontItems, ...keptItems],
    };
    payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
    payload.updatedAt = new Date().toISOString();
    payload.updatedByUsername = "publish-fonts";

    console.log(
      `fonts section: ${fontItems.length} published fonts, ${keptItems.length} custom items kept, ` +
        `new version ${payload.version}` +
        (dryRun ? " (dry run — not written)" : "")
    );

    if (!dryRun) {
      await redis.set(FONTS_SECTION_KEY, JSON.stringify(payload));
      console.log(`Wrote ${FONTS_SECTION_KEY}.`);
    }
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
