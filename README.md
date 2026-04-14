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
| `designer:objects:join` | `{ seedState?: DesignerObjectsSectionState }` | Join the collaborative `/designer/objects` room and hydrate the latest Redis-backed snapshot. The optional `seedState` is used only when Redis has no saved state yet. |
| `designer:objects:update` | `{ state: DesignerObjectsSectionState }` | Replace the shared `/designer/objects` editor state, persist it to Redis, and broadcast it to all watchers immediately. |
| `designer:objects:leave` | `void` | Leave the collaborative `/designer/objects` room when the client navigates away. |
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
| `designer:objects:state` | `DesignerObjectsSyncPayload` | Full authoritative `/designer/objects` snapshot sent on join and after each collaborative update. |
| `designer:objects:error` | `{ message: string }` | Non-fatal collaborative editor error for the `/designer/objects` experience. |

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

## 🗄️ Redis Database Schema

This project utilizes [Redis](https://redis.io/) as an in-memory data structure store. Below is the documentation of the key patterns, data types, and structures used across the application.

### Key Naming Convention
We follow a standard colon-separated namespace convention for our Redis keys to ensure logical grouping and easy querying: `object_type:id:sub_type`.

### 1. User/Player Profiles
Stores individual player data, settings, and current state.
* **Key Pattern:** `player:{player_id}`
* **Data Type:** `Hash`
* **Fields:**
  * `username` (String) - The display name of the player.
  * `level` (Integer) - The current level of the player.
  * `score` (Integer) - Total accumulated points.
  * `last_login` (Timestamp) - Unix timestamp of the last active session.

### 2. Global Leaderboard
Maintains the high scores of all players in real-time.
* **Key Pattern:** `leaderboard:global`
* **Data Type:** `Sorted Set (ZSET)`
* **Score:** Player's score/experience points.
* **Value:** `{player_id}`

### 3. Active Game Sessions
Keeps track of which players are currently connected and active in a specific match/room.
* **Key Pattern:** `room:{room_id}:players`
* **Data Type:** `Set`
* **Value:** `{player_id}`

### 4. Rate Limiting / API Throttling
Used to prevent API abuse and handle rate limits.
* **Key Pattern:** `ratelimit:{ip_address}:{endpoint}`
* **Data Type:** `String` (with TTL/Expiration)
* **Value:** Current request count (Integer).

### 5. Session Caching
Stores ephemeral authentication tokens and session data.
* **Key Pattern:** `session:{session_token}`
* **Data Type:** `String` (JSON stringified)
* **Value:** 
  ```json
  {
    "playerId": "12345",
    "createdAt": "2026-03-17T21:36:31Z"
  }
  ```

### 6. Designer Objects Snapshot
Stores the authoritative state for the `/designer/objects` editor so all connected designers see the same data without refreshing.
* **Key Pattern:** `designer:section:objects`
* **Data Type:** `String` (JSON stringified)
* **Value Shape:**
  ```json
  {
    "state": {
      "categories": ["Uncategorized", "Nature", "Buildings"],
      "items": [
        {
          "id": "object-ancient-oak",
          "name": "Ancient Oak",
          "category": "Nature",
          "details": [
            { "label": "Type", "value": "obstacle" },
            { "label": "Width", "value": "96 px" },
            { "label": "Height", "value": "144 px" }
          ],
          "mapObjectAsset": {
            "imageSrc": "data:image/png;base64,...",
            "width": 96,
            "height": 144,
            "objectType": "obstacle"
          }
        }
      ]
    },
    "updatedAt": "2026-04-14T16:00:00.000Z",
    "updatedByUserId": 12,
    "updatedByUsername": "designer-admin"
  }
  ```

## 🤝 Designer Objects Collaboration

The `/designer/objects` page now uses a dedicated real-time collaboration flow:

1. The authenticated client emits `designer:objects:join` when the page opens.
2. The server loads `designer:section:objects` from Redis, creating it from the provided seed state when it does not exist yet.
3. The server returns the authoritative snapshot through `designer:objects:state`.
4. Every create/edit/delete/category change emits `designer:objects:update` with the full editor state.
5. The server persists the new snapshot in Redis and rebroadcasts `designer:objects:state` to every socket in the `designer:objects` room.
6. Clients update instantly, so multiple users on `/designer/objects` stay in sync without refreshing.


## 📝 Development Notes

*   **Scale:** The world uses a movement scale factor (default: 8) defined in `World.moveScale` for the pathfinding grid.
*   **Tick Rate:**
    *   Projectile physics loop: 100ms
    *   Player logic/Reborn loop: 1000ms
    *   Movement interpolation happens on a faster interval (1ms) within the Player class.

---
