/**
 * Moves the tileset images embedded as data URIs inside
 * designer:section:tilesets (~36MB of base64 in Redis) onto the asset-storage
 * server as real PNG files, and rewrites the profiles to reference them by
 * root-relative path (/tilesets/<itemId>/tileset.png, autotile-<slot>.png).
 *
 * After this runs the tilesets section shrinks to ~1MB of metadata: the map
 * editor downloads it instantly, designer saves stop re-uploading 36MB
 * through Socket.IO, and the images are cached by the browser like any other
 * asset (the client already resolves root-relative paths against
 * assetStorageBaseUrl with CORS enabled — see tilesetRenderer.loadImageElement).
 *
 * Usage (local shared folder, default ../asset-storage/assets/tilesets):
 *   npx ts-node tools/exportTilesetsToAssetStorage.ts [--dry-run]
 * Remote upload through the nginx upload API:
 *   npx ts-node tools/exportTilesetsToAssetStorage.ts \
 *     --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN
 *
 * Re-running is safe: files are overwritten by name and profiles already
 * referencing paths (not data URIs) are left untouched.
 */
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "redis";

const TILESETS_REDIS_KEY = "designer:section:tilesets";
const TILESETS_ASSET_PATH = "tilesets";

type AutotileSlot = { name?: string; imageSrc?: string } | null;

type TilesetProfile = {
  tilesetImageSrc?: string;
  autotiles?: AutotileSlot[];
};

type SectionItem = {
  id: string;
  name: string;
  tilesetProfile?: TilesetProfile;
};

function parseDataUri(value: string | undefined) {
  if (typeof value !== "string" || !value.startsWith("data:")) {
    return null;
  }

  const match = value.match(/^data:image\/(png|gif|webp|jpe?g);base64,(.+)$/);

  if (!match) {
    return null;
  }

  const extension = match[1] === "jpeg" ? "jpg" : match[1];

  return { extension, buffer: Buffer.from(match[2], "base64") };
}

// Upload API path segments must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.
function sanitizePathSegment(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+/, "");

  return cleaned.length > 0 ? cleaned.slice(0, 128) : "tileset";
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
    path.resolve(process.cwd(), "../asset-storage/assets", TILESETS_ASSET_PATH);

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
        `${uploadUrl.replace(/\/+$/, "")}/api/upload/${TILESETS_ASSET_PATH}/${relPath}`,
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
        throw new Error(
          `Upload failed for ${relPath}: ${response.status} ${await response.text()}`
        );
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
    const raw = await redis.get(TILESETS_REDIS_KEY);

    if (!raw) {
      console.error(`${TILESETS_REDIS_KEY} is empty — nothing to export.`);
      process.exit(1);
    }

    const payload = JSON.parse(raw);
    const items: SectionItem[] = Array.isArray(payload?.state?.items)
      ? payload.state.items
      : [];
    const beforeBytes = raw.length;
    let convertedImages = 0;
    let convertedTilesets = 0;
    let skippedTilesets = 0;

    for (const item of items) {
      const profile = item?.tilesetProfile;

      if (!profile) {
        continue;
      }

      const folder = sanitizePathSegment(item.id);
      let touched = false;

      const mainImage = parseDataUri(profile.tilesetImageSrc);
      if (mainImage) {
        const relPath = `${folder}/tileset.${mainImage.extension}`;
        await writeFile(relPath, mainImage.buffer, mainImage.extension);
        profile.tilesetImageSrc = `/${TILESETS_ASSET_PATH}/${relPath}`;
        convertedImages += 1;
        touched = true;
      }

      if (Array.isArray(profile.autotiles)) {
        for (let slot = 0; slot < profile.autotiles.length; slot += 1) {
          const autotile = profile.autotiles[slot];
          const parsed = parseDataUri(autotile?.imageSrc);

          if (autotile && parsed) {
            const relPath = `${folder}/autotile-${slot}.${parsed.extension}`;
            await writeFile(relPath, parsed.buffer, parsed.extension);
            autotile.imageSrc = `/${TILESETS_ASSET_PATH}/${relPath}`;
            convertedImages += 1;
            touched = true;
          }
        }
      }

      if (touched) {
        convertedTilesets += 1;
      } else {
        skippedTilesets += 1;
      }
    }

    if (convertedTilesets === 0) {
      console.log(
        `All ${items.length} tilesets already reference asset paths — nothing to do.`
      );
      return;
    }

    payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
    payload.updatedAt = new Date().toISOString();
    payload.updatedByUsername = "tilesets-asset-export";

    const nextRaw = JSON.stringify(payload);

    console.log(
      `${convertedTilesets} tilesets converted (${convertedImages} images extracted, ` +
        `${skippedTilesets} already converted). Section payload: ` +
        `${(beforeBytes / 1024 / 1024).toFixed(1)}MB -> ${(nextRaw.length / 1024 / 1024).toFixed(1)}MB. ` +
        `Target: ${uploadUrl ? `${uploadUrl}/api/upload/${TILESETS_ASSET_PATH}/` : targetDir}` +
        (dryRun ? " (dry run — nothing written)" : "")
    );

    if (dryRun) {
      return;
    }

    await redis.set(TILESETS_REDIS_KEY, nextRaw);
    console.log(
      `Wrote ${TILESETS_REDIS_KEY} at version ${payload.version}. ` +
        "Clients pick the slim payload up on their next HTTP fetch."
    );
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
