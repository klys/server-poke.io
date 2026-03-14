interface PlayerData {
  playerId: string;
  x: number;
  y: number;
  angle: number;
  id: number;
}

interface ProjectilData {
  x: number;
  y: number;
  id: number;
  angle: number;
}

interface ObjectData {
  x: number;
  y: number;
  type: string;
  width: number;
  height: number;
}

export default interface ServerToClientEvents {
  addPlayer: (data: PlayerData) => void;
  removePlayer: (data: { playerId: string; id: number }) => void;

  shotProjectil: (data: ProjectilData) => void;
  explodeProjectil: (data: ProjectilData) => void;

  playerHurt: (data: { playerId: string; life: number; id: number }) => void;
  playerReborn: (data: { playerId: string; id: number }) => void;
  playerDeath: (data: { playerId: string; id: number }) => void;

  addObject: (data: ObjectData) => void;
  test: (data: { test: string }) => void;

  // Dynamic events using template literal types
  [event: `move${string}`]: (data: { x: number; y: number; angle: number; playerId: string; id: number }) => void;
  [event: `moveProjectil${string}`]: (data: ProjectilData) => void;
  [event: `playerReborn${string}`]: (data: { playerId: string; id: number }) => void;
  [event: `playerDeath${string}`]: (data: { playerId: string; id: number }) => void;
}