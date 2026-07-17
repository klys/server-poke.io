import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export interface MapAssetUploadFile {
  name?: string;
  dataUrl: string;
}

export interface MapAssetRecord {
  name: string;
  path: string;
}

const MAP_ASSET_URL_PREFIX = "/map-assets/";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_MAP = 512;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg"
};

function isSafeSegment(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);

  if (!match) {
    return null;
  }

  const bytes = Buffer.from(match[2], "base64");

  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    return null;
  }

  return { mimeType: match[1], bytes };
}

/**
 * Stores baked map surfaces (and other per-map images) on disk. ASSET_STORAGE_URL
 * must point at the asset-storage server's assets/map-assets folder — the
 * nginx asset server (ASSET_STORAGE_BASE_URL) serves the files; this server
 * only writes them. Emitted paths stay root-relative
 * ("/map-assets/<mapId>/<file>") and clients resolve them against their
 * configured asset-storage origin. File names are content hashes, so
 * responses are immutable-cacheable.
 */
export default class MapAssetStore {
  private readonly baseDir: string;

  constructor(baseDir = process.env.ASSET_STORAGE_URL || path.resolve(process.cwd(), "map-assets")) {
    this.baseDir = baseDir;
  }

  async saveFiles(
    mapId: string,
    files: MapAssetUploadFile[],
    options?: { replace?: boolean }
  ): Promise<MapAssetRecord[]> {
    if (!isSafeSegment(mapId)) {
      throw new Error("Invalid map id.");
    }

    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_MAP) {
      throw new Error("Invalid map asset file list.");
    }

    const mapDir = path.join(this.baseDir, mapId);

    if (options?.replace) {
      // Only clear the image files this store manages. The same folder holds
      // sidecars written by other services (pokecraft-api's tile-data.json
      // runtime export) that a designer re-save must not destroy.
      const imageExtensions = new Set([...Object.values(MIME_TO_EXTENSION), "jpeg"]);
      const entries = await fs.readdir(mapDir, { withFileTypes: true }).catch(() => []);

      await Promise.all(
        entries
          .filter((entry) => {
            const extension = entry.name.split(".").pop() ?? "";
            return entry.isFile() && imageExtensions.has(extension.toLowerCase());
          })
          .map((entry) => fs.rm(path.join(mapDir, entry.name), { force: true }))
      );
    }

    await fs.mkdir(mapDir, { recursive: true });

    const records: MapAssetRecord[] = [];

    for (const file of files) {
      if (typeof file?.dataUrl !== "string") {
        throw new Error("Invalid map asset payload.");
      }

      const decoded = decodeDataUrl(file.dataUrl);

      if (!decoded) {
        throw new Error("Map assets must be base64 png, webp, or jpeg data URLs under 8MB.");
      }

      const extension = MIME_TO_EXTENSION[decoded.mimeType];
      const defaultName = `${createHash("sha1").update(decoded.bytes).digest("hex")}.${extension}`;
      const name =
        typeof file.name === "string" && isSafeSegment(file.name) ? file.name : defaultName;

      await fs.writeFile(path.join(mapDir, name), decoded.bytes);
      records.push({ name, path: `${MAP_ASSET_URL_PREFIX}${mapId}/${name}` });
    }

    return records;
  }
}
