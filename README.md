# Server Poke.io

This project is a backend server for a multiplayer real-time game built with **Node.js**, **Express**, and **Socket.IO**. It handles game state synchronization, pathfinding movement, collision detection, and combat mechanics for connected clients.

## 🚀 Features

*   **Real-time Multiplayer:** Uses WebSockets for low-latency communication between server and clients.
*   **Pathfinding:** Implements A* pathfinding (via `pathfinding` library) for server-side player movement validation and navigation.
*   **Combat System:**
    *   Projectile shooting mechanics with range and speed calculations.
    *   Collision detection between projectiles and players.
    *   Health, death, and respawn logic.
*   **Game Loop:** Server-side interval loops for managing projectile movement and player state.
*   **Static Objects:** Support for static map objects (eOBjects) with collision boundaries.

## 🛠️ Tech Stack

*   **Language:** TypeScript
*   **Server:** Express & Node.js
*   **WebSockets:** Socket.IO
*   **Pathfinding:** Pathfinding.js

## 📦 Installation

1.  **Clone the repository**
    ```bash
    git clone <repository-url>
    cd server-poke.io
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Run the server**
    You can run the server using `ts-node` directly or via npm scripts if configured.
    ```bash
    # Using ts-node directly
    npx ts-node index.ts
    ```

The server listens on port **3001** by default.

## wb Project Structure

*   **`index.ts`**: Entry point. Initializes the Express server, Socket.IO instance, and the Game World.
*   **`components/`**
    *   **`world.ts`**: The main game container. Manages the grid, list of players, projectiles, and runs the game loops.
    *   **`player.ts`**: Represents a connected user. Handles pathfinding calculation (`findPath`), movement interpolation, health, and state data.
    *   **`projectil.ts`**: Represents a fired shot. Calculates trajectory, updates position per tick, and handles expiration.
    *   **`gameMath.ts`**: Utility functions for geometry (angle calculation, distance, collision detection).
*   **`Server/`**: Contains TypeScript interfaces for Socket.IO events.

## 🔌 Socket.IO API

### Client -> Server Events

| Event Name | Payload | Description |
| :--- | :--- | :--- |
| `addPlayer` | `void` | Request to join the game world. |
| `move` | `{ x: number, y: number }` | Request to move to specific coordinates. Triggers server-side pathfinding. |
| `shotProjectil` | `{ mouse_x: number, mouse_y: number }` | Fire a projectile towards the mouse coordinates. |
| `disconnect` | `void` | Standard socket event when a client drops connection. |

### Server -> Client Events

| Event Name | Payload | Description |
| :--- | :--- | :--- |
| `addPlayer` | `PlayerData` | Sent when a new player joins (broadcasted to others). |
| `addObject` | `ObjectData` | Sent to a new client to render static map objects (rocks, etc). |
| `removePlayer` | `{ playerId: string, id: number }` | Sent when a player disconnects. |
| `move[socketId]` | `{ x, y, angle, playerId, id }` | Emitted frequently to update a specific player's position. |
| `shotProjectil` | `ProjectileData` | Sent when a projectile is created. |
| `moveProjectil[id]`| `ProjectileData` | Emitted frequently to update a specific projectile's position. |
| `explodeProjectil` | `ProjectileData` | Sent when a projectile hits a target or reaches max range. |
| `playerHurt` | `{ playerId, life, id }` | Sent when a player takes damage. |
| `playerDeath` | `{ playerId, id }` | Sent when a player's life reaches 0. |
| `playerReborn` | `{ playerId, id }` | Sent when a player respawns after the wait time. |

## ⚙️ Game Logic Details

### Movement
Movement is not direct. When a client requests a `move` to (x, y):
1.  The server calculates a path using `Pathfinding.AStarFinder`.
2.  The `Player` object stores this path.
3.  A server interval moves the player along this path step-by-step.
4.  Updates are broadcasted to clients via `move[socketId]`.

### Collision
*   **Environment:** Players check collision against static objects (defined in `World.objects`) before moving.
*   **Combat:** Projectiles check for collision with players every tick using a bounding box check (`collision_square`).

## 📝 Development Notes

*   **Scale:** The world uses a movement scale factor (default: 8) defined in `World.moveScale` for the pathfinding grid.
*   **Tick Rate:**
    *   Projectile physics loop: 100ms
    *   Player logic/Reborn loop: 1000ms
    *   Movement interpolation happens on a faster interval (1ms) within the Player class.

---

