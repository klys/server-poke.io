/**
 * Admin-uploaded rxdata_json bundles for the "Repair Essentials Events"
 * maintenance action. The server ships a bundled dump under
 * migration-data/rxdata_json; an admin can replace it per-deploy by uploading
 * a zip of a fresh rxdata->JSON export from the admin panel. The upload is
 * validated (maps/Map###.json + data/System.json must parse) and staged under
 * migration-data/rxdata_json_uploaded — the repair action prefers the staged
 * upload over the bundled dump whenever one is present.
 *
 * Only the files the repair tool actually reads are extracted (maps/Map*.json,
 * data/System.json, index.json); anything else in the zip is ignored, and
 * entry names are sanitized so a crafted zip cannot write outside the staging
 * directory.
 */
import AdmZip from "adm-zip";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";

// Compiled: <root>/dist/components/RxdataUploadStore.js. Dev (ts-node keeps
// .ts filenames): <root>/components/RxdataUploadStore.ts.
const IS_COMPILED = __filename.endsWith(".js");
const SERVER_ROOT = IS_COMPILED ? path.join(__dirname, "..", "..") : path.join(__dirname, "..");
const MIGRATION_DATA_DIR = path.join(SERVER_ROOT, "migration-data");
export const BUNDLED_RXDATA_DIR = path.join(MIGRATION_DATA_DIR, "rxdata_json");
export const UPLOADED_RXDATA_DIR = path.join(MIGRATION_DATA_DIR, "rxdata_json_uploaded");
const UPLOAD_META_FILE = "upload-meta.json";

/** Hard caps: a legitimate dump is ~22MB on disk / ~5MB zipped. */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

export type RxdataUploadMeta = {
  uploadedAt: string;
  uploadedBy: string;
  originalName: string;
  zipBytes: number;
  mapCount: number;
};

export type RxdataValidationResult =
  | { ok: true; mapCount: number; warnings: string[] }
  | { ok: false; errors: string[] };

type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  header: { size: number };
  getData: () => Buffer;
};

/**
 * Locates the dump inside the zip: entries may sit at the root
 * ("maps/Map001.json") or under a single wrapping folder
 * ("rxdata_json/maps/Map001.json"). Returns the prefix ("" or "folder/").
 */
function findRootPrefix(entryNames: string[]): string | null {
  for (const name of entryNames) {
    const match = name.match(/^(.*?)data\/System\.json$/);
    if (match && (match[1] === "" || match[1].endsWith("/"))) {
      return match[1];
    }
  }
  return null;
}

export default class RxdataUploadStore {
  /** Directory the repair action should read: staged upload if present, else bundled. */
  public activeDataDir(): { dir: string; source: "uploaded" | "bundled" } | null {
    if (existsSync(path.join(UPLOADED_RXDATA_DIR, "data", "System.json"))) {
      return { dir: UPLOADED_RXDATA_DIR, source: "uploaded" };
    }
    if (existsSync(path.join(BUNDLED_RXDATA_DIR, "data", "System.json"))) {
      return { dir: BUNDLED_RXDATA_DIR, source: "bundled" };
    }
    return null;
  }

  public async readUploadMeta(): Promise<RxdataUploadMeta | null> {
    try {
      const raw = await fs.readFile(path.join(UPLOADED_RXDATA_DIR, UPLOAD_META_FILE), "utf8");
      return JSON.parse(raw) as RxdataUploadMeta;
    } catch {
      return null;
    }
  }

  /** Drops the staged upload; the repair action falls back to the bundled dump. */
  public async clearUpload(): Promise<void> {
    await fs.rm(UPLOADED_RXDATA_DIR, { recursive: true, force: true });
  }

  /**
   * Validates and stages an uploaded zip. On success the previous upload (if
   * any) is atomically replaced. Never touches the bundled dump.
   */
  public async stageZip(
    zipBuffer: Buffer,
    options: { uploadedBy: string; originalName: string }
  ): Promise<RxdataValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (zipBuffer.length > MAX_ZIP_BYTES) {
      return { ok: false, errors: [`Zip is too large (${zipBuffer.length} bytes; limit ${MAX_ZIP_BYTES}).`] };
    }

    let entries: ZipEntryLike[];
    try {
      const zip = new AdmZip(zipBuffer);
      entries = zip.getEntries() as unknown as ZipEntryLike[];
    } catch (error) {
      return { ok: false, errors: [`Not a readable zip file: ${(error as Error).message}`] };
    }

    const fileEntries = entries.filter((entry) => !entry.isDirectory);
    const totalUncompressed = fileEntries.reduce((sum, entry) => sum + (entry.header.size || 0), 0);
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, errors: ["Zip expands past the allowed size — refusing to extract."] };
    }

    const prefix = findRootPrefix(fileEntries.map((entry) => entry.entryName));
    if (prefix === null) {
      return {
        ok: false,
        errors: [
          "The zip does not contain a data/System.json. Expected an rxdata_json dump with maps/Map###.json and data/System.json (optionally inside one wrapping folder)."
        ]
      };
    }

    // Collect and validate the files the repair tool reads.
    const wanted = new Map<string, Buffer>();
    let mapCount = 0;
    for (const entry of fileEntries) {
      if (!entry.entryName.startsWith(prefix)) {
        continue;
      }
      const relative = entry.entryName.slice(prefix.length);
      // Zip-slip guard: only accept plain relative paths we expect.
      const isSystem = relative === "data/System.json";
      const isIndex = relative === "index.json";
      const isMap = /^maps\/Map\d+\.json$/.test(relative);
      if (!isSystem && !isIndex && !isMap) {
        continue;
      }

      let data: Buffer;
      try {
        data = entry.getData();
      } catch (error) {
        errors.push(`${relative}: unable to decompress (${(error as Error).message}).`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        errors.push(`${relative}: not valid JSON.`);
        continue;
      }

      if (isSystem) {
        const system = parsed as { data?: { switches?: unknown; variables?: unknown } };
        if (typeof system !== "object" || system === null || typeof system.data !== "object" || system.data === null) {
          errors.push("data/System.json: missing the expected top-level \"data\" object.");
          continue;
        }
        if (!Array.isArray(system.data.switches) && !Array.isArray(system.data.variables)) {
          warnings.push("data/System.json has no switches/variables arrays — script-switch import will be empty.");
        }
      }

      if (isMap) {
        const rxMap = parsed as { data?: { events?: unknown } };
        if (typeof rxMap !== "object" || rxMap === null || typeof rxMap.data !== "object" || rxMap.data === null) {
          errors.push(`${relative}: missing the expected top-level "data" object.`);
          continue;
        }
        if (typeof rxMap.data.events !== "object" || rxMap.data.events === null) {
          warnings.push(`${relative}: has no events — nothing to repair on that map.`);
        }
        mapCount += 1;
      }

      wanted.set(relative, data);
    }

    if (mapCount === 0) {
      errors.push("No maps/Map###.json files found in the zip.");
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Stage into a temp dir, then swap it in so a failed extraction can never
    // leave a half-written upload behind.
    const stagingDir = `${UPLOADED_RXDATA_DIR}.tmp`;
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(path.join(stagingDir, "maps"), { recursive: true });
    await fs.mkdir(path.join(stagingDir, "data"), { recursive: true });
    for (const [relative, data] of wanted) {
      await fs.writeFile(path.join(stagingDir, relative), data);
    }
    const meta: RxdataUploadMeta = {
      uploadedAt: new Date().toISOString(),
      uploadedBy: options.uploadedBy,
      originalName: options.originalName,
      zipBytes: zipBuffer.length,
      mapCount
    };
    await fs.writeFile(path.join(stagingDir, UPLOAD_META_FILE), JSON.stringify(meta, null, 2));
    await fs.rm(UPLOADED_RXDATA_DIR, { recursive: true, force: true });
    await fs.rename(stagingDir, UPLOADED_RXDATA_DIR);

    return { ok: true, mapCount, warnings };
  }
}
