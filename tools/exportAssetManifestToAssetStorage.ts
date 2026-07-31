/**
 * Shrinks designer:section:assets (the Asset Manifest, ~134MB) the same way
 * exportTilesetsToAssetStorage.ts shrank the tilesets: every embedded image
 * (stored TWICE per item, in assetProfile.dataUri and assetProfile.imageSrc)
 * is written once to asset-storage under /asset-manifest/ and the profile is
 * rewritten to reference it by root-relative path; the duplicate dataUri
 * field is dropped.
 *
 * Consumers keep working: the designer preview reads imageSrc || dataUri and
 * resolves root-relative paths against the asset-storage origin.
 *
 * Usage:
 *   npx ts-node tools/exportAssetManifestToAssetStorage.ts [--dry-run]
 *   # remote: --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN
 */
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "redis";

const ASSETS_REDIS_KEY = "designer:section:assets";
const MANIFEST_ASSET_PATH = "asset-manifest";

function parseDataUri(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("data:")) {
    return null;
  }

  const match = value.match(/^data:image\/(png|gif|webp|jpe?g);base64,(.+)$/);

  if (!match) {
    return null;
  }

  return {
    extension: match[1] === "jpeg" ? "jpg" : match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function sanitizePathSegment(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+/, "");

  return cleaned.length > 0 ? cleaned.slice(0, 120) : "asset";
}

async function main() {
  const args = process.argv.slice(2);
  const flagValue = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const uploadUrl = flagValue("--upload-url");
  const uploadToken = flagValue("--token") || process.env.ASSET_UPLOAD_TOKEN;
  const targetDir =
    flagValue("--target") ||
    path.resolve(process.cwd(), "../asset-storage/assets", MANIFEST_ASSET_PATH);

  if (uploadUrl && !uploadToken) {
    console.error("--upload-url requires --token or ASSET_UPLOAD_TOKEN.");
    process.exit(1);
  }

  const writeFile = async (relPath: string, buffer: Buffer, extension: string) => {
    if (dryRun) {
      return;
    }

    if (uploadUrl) {
      const response = await fetch(
        `${uploadUrl.replace(/\/+$/, "")}/api/upload/${MANIFEST_ASSET_PATH}/${relPath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${uploadToken}`,
            "Content-Type": `image/${extension === "jpg" ? "jpeg" : extension}`,
          },
          body: buffer,
        }
      );

      if (!response.ok) {
        throw new Error(`Upload failed for ${relPath}: ${response.status}`);
      }
      return;
    }

    const filePath = path.join(targetDir, relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  };

  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  try {
    const raw = await redis.get(ASSETS_REDIS_KEY);

    if (!raw) {
      console.error(`${ASSETS_REDIS_KEY} is empty — nothing to export.`);
      process.exit(1);
    }

    const payload = JSON.parse(raw);
    const items: Array<{
      id: string;
      assetProfile?: { dataUri?: unknown; imageSrc?: unknown; [key: string]: unknown };
    }> = Array.isArray(payload?.state?.items) ? payload.state.items : [];
    const beforeBytes = raw.length;
    let converted = 0;

    for (const item of items) {
      const profile = item?.assetProfile;

      if (!profile) {
        continue;
      }

      const parsed = parseDataUri(profile.imageSrc) ?? parseDataUri(profile.dataUri);

      if (!parsed) {
        continue;
      }

      const relPath = `${sanitizePathSegment(item.id)}.${parsed.extension}`;
      await writeFile(relPath, parsed.buffer, parsed.extension);
      profile.imageSrc = `/${MANIFEST_ASSET_PATH}/${relPath}`;
      delete profile.dataUri;
      converted += 1;
    }

    if (converted === 0) {
      console.log(`All ${items.length} assets already reference files — nothing to do.`);
      return;
    }

    payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
    payload.updatedAt = new Date().toISOString();
    payload.updatedByUsername = "asset-manifest-export";

    const nextRaw = JSON.stringify(payload);

    console.log(
      `${converted}/${items.length} assets extracted. Section payload: ` +
        `${(beforeBytes / 1048576).toFixed(1)}MB -> ${(nextRaw.length / 1048576).toFixed(1)}MB. ` +
        `Target: ${uploadUrl ? `${uploadUrl}/api/upload/${MANIFEST_ASSET_PATH}/` : targetDir}` +
        (dryRun ? " (dry run — nothing written)" : "")
    );

    if (dryRun) {
      return;
    }

    await redis.set(ASSETS_REDIS_KEY, nextRaw);
    console.log(`Wrote ${ASSETS_REDIS_KEY} at version ${payload.version}.`);
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
