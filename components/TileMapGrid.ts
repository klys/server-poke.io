// Tile-map grid contract helpers shared with the client and the Essentials
// migration tool. See MAP_TILEMAP_CONTRACT.md at the workspace root.

export const TILE_MAP_LAYER_ENCODING = "u16le-base64";
export const TILE_MAP_GRID_ENCODING = "u8rle-base64";

// RMXP passage bits carried per collision cell.
export const COLLISION_BLOCK_DOWN = 0x01;
export const COLLISION_BLOCK_LEFT = 0x02;
export const COLLISION_BLOCK_RIGHT = 0x04;
export const COLLISION_BLOCK_UP = 0x08;
export const COLLISION_SOLID_MASK = 0x0f;

export type MapCollisionGrid = {
  width: number;
  height: number;
  cellSize: number;
  cells: Uint8Array;
};

export function isSolidCollisionCell(cellByte: number) {
  return (cellByte & COLLISION_SOLID_MASK) === COLLISION_SOLID_MASK;
}

export function decodeRleBytes(base64Value: string): Uint8Array | null {
  let packed: Buffer;

  try {
    packed = Buffer.from(base64Value, "base64");
  } catch {
    return null;
  }

  if (packed.length === 0 || packed.length % 2 !== 0) {
    return null;
  }

  let totalLength = 0;
  for (let index = 0; index < packed.length; index += 2) {
    totalLength += packed[index];
  }

  const bytes = new Uint8Array(totalLength);
  let cursor = 0;

  for (let index = 0; index < packed.length; index += 2) {
    const count = packed[index];
    const value = packed[index + 1];

    if (count === 0) {
      return null;
    }

    bytes.fill(value, cursor, cursor + count);
    cursor += count;
  }

  return bytes;
}

export function encodeRleBytes(bytes: Uint8Array): string {
  const packed: number[] = [];
  let index = 0;

  while (index < bytes.length) {
    const value = bytes[index];
    let count = 1;

    while (
      count < 255 &&
      index + count < bytes.length &&
      bytes[index + count] === value
    ) {
      count += 1;
    }

    packed.push(count, value);
    index += count;
  }

  return Buffer.from(packed).toString("base64");
}

export function decodeTileLayer(base64Value: string, expectedCells: number): Uint16Array | null {
  let raw: Buffer;

  try {
    raw = Buffer.from(base64Value, "base64");
  } catch {
    return null;
  }

  if (raw.length !== expectedCells * 2) {
    return null;
  }

  const layer = new Uint16Array(expectedCells);
  for (let index = 0; index < expectedCells; index += 1) {
    layer[index] = raw.readUInt16LE(index * 2);
  }

  return layer;
}

export function decodeCollisionGrid(
  base64Value: string,
  width: number,
  height: number,
  cellSize: number
): MapCollisionGrid | null {
  const cells = decodeRleBytes(base64Value);

  if (!cells || cells.length !== width * height) {
    return null;
  }

  return { width, height, cellSize, cells };
}
