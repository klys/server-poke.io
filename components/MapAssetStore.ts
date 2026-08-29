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

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

// Accepts the asset server origin or any of the paths people configure
// ("https://assets.example/", ".../assets", ".../assets/map-assets") and
// returns the origin (+ mount prefix) the upload API hangs off.
function normalizeUploadOrigin(value: string) {
  const url = new URL(value);
  const pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/map-assets$/, "")
    .replace(/\/assets$/, "");

  return `${url.origin}${pathname}`;
}

export interface MapAssetStoreOptions {
  /** Local folder the asset nginx serves as /map-assets (filesystem mode). */
  baseDir?: string;
  /** asset-storage origin whose /api/upload/ sidecar receives files (HTTP mode). */
  uploadUrl?: string;
  uploadToken?: string;
}

/**
 * Stores baked map surfaces (and other per-map images) where the asset-storage
 * nginx serves them as "/map-assets/<mapId>/<file>". Two modes:
 *
 * - Filesystem (dev): ASSET_STORAGE_URL is a directory — the asset server's
 *   assets/map-assets folder on this machine — and files are written there.
 * - HTTP (prod / dockerized): ASSET_STORAGE_URL (or ASSET_UPLOAD_URL) is the
 *   asset server's http(s) origin, which usually lives on ANOTHER machine, so
 *   files are PUT through its /api/upload/ sidecar with ASSET_UPLOAD_TOKEN.
 *   Writing to a local folder in that setup used to "succeed" while the
 *   published /map-assets paths 404'd on the real asset host — every baked
 *   map then failed with "Some map graphics failed to load".
 *
 * Emitted paths stay root-relative and clients resolve them against their
 * configured asset-storage origin.
 */
export default class MapAssetStore {
  private readonly baseDir: string;
  private readonly uploadOrigin: string | null;
  private readonly uploadToken: string;

  constructor(options: MapAssetStoreOptions = {}) {
    const configured = (process.env.ASSET_STORAGE_URL || "").trim();
    const uploadUrl =
      options.uploadUrl ??
      (process.env.ASSET_UPLOAD_URL || "").trim() ??
      "";
    const derivedUploadUrl = uploadUrl || (isHttpUrl(configured) ? configured : "");

    this.uploadOrigin = derivedUploadUrl ? normalizeUploadOrigin(derivedUploadUrl) : null;
    this.uploadToken = options.uploadToken ?? (process.env.ASSET_UPLOAD_TOKEN || "");
    this.baseDir =
      options.baseDir ??
      (configured && !isHttpUrl(configured)
        ? configured
        : path.resolve(process.cwd(), "map-assets"));
  }

  /** One-line description for the startup log. */
  describeTarget() {
    if (this.uploadOrigin) {
      return `Map assets: uploading to ${this.uploadOrigin}/api/upload/map-assets/ (${
        this.uploadToken ? "token set" : "ASSET_UPLOAD_TOKEN MISSING — designer saves will embed tiles inline"
      })`;
    }

    return `Map assets: writing to ${this.baseDir}`;
  }

  private async uploadFile(mapId: string, name: string, mimeType: string, bytes: Buffer) {
    if (!this.uploadToken) {
      throw new Error(
        "Map asset upload is not configured: set ASSET_UPLOAD_TOKEN to the asset server's upload token."
      );
    }

    const url = `${this.uploadOrigin}/api/upload/map-assets/${mapId}/${name}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.uploadToken}`,
          "Content-Type": mimeType
        },
        body: new Uint8Array(bytes)
      });
    } catch (error) {
      throw new Error(
        `Map asset upload to ${this.uploadOrigin} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (response.status === 503) {
      throw new Error("The asset server has uploads disabled (its ASSET_UPLOAD_TOKEN is not set).");
    }

    if (response.status === 401) {
      throw new Error("The asset server rejected ASSET_UPLOAD_TOKEN.");
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Map asset upload failed (${response.status}): ${detail.slice(0, 200)}`);
    }
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

    // HTTP mode: the sidecar overwrites by name (chunk names are deterministic
    // "bg-<col>-<row>.png"), so a re-save replaces what it re-bakes; chunks a
    // smaller re-bake no longer references are left behind, unreferenced.
    if (this.uploadOrigin) {
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

        await this.uploadFile(mapId, name, decoded.mimeType, decoded.bytes);
        records.push({ name, path: `${MAP_ASSET_URL_PREFIX}${mapId}/${name}` });
      }

      return records;
    }

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
