export default interface ClientToServerEvents {
  addPlayer: () => void;
  move: (data: { x: number; y: number }) => void;
  shotProjectil: (data: { mouse_x: number; mouse_y: number }) => void;
}