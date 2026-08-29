// Socket handlers for the housing system (components/Housing.ts).
//
// Every action re-validates on the server: door adjacency, ownership, key
// codes, money, inventory. Results go back to the actor as `house:result`
// (i18n key + params); state that others must see (furniture, owner/lock
// changes) is broadcast by Housing itself.

import type { Server, Socket } from "socket.io";
import type World from "../components/world";
import type Player from "../components/player";
import type Auth from "../components/Auth";
import type { InventoryItem } from "../components/Auth";
import type BattleManager from "../components/BattleManager";
import type EventRuntime from "../components/EventRuntime";
import { isHouseInstanceMapId, isValidKeyCode, MAX_SALE_PRICE, sanitizeHouseName } from "../components/Housing";
import type { TradeMutationSource } from "../components/trade/tradeTypes";
import type ClientToServerEvents from "./ClientToServerEvents";
import type ServerToClientEvents from "./ServerToClientEvents";
import type InterServerEvents from "./InterServerEvents";
import type { SocketData } from "./registerSocketHandlers";

type HousingSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type HousingServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

type HouseAction = "enter" | "buy" | "key" | "sale" | "leave" | "place" | "pick" | "roam" | "door-info" | "name" | "music";

interface HousingHandlerContext {
  io: HousingServer;
  socket: HousingSocket;
  world: World;
  auth: Auth;
  battleManager: BattleManager;
  eventRuntime: EventRuntime;
  guardTradedAssets: (
    source: TradeMutationSource,
    target: { itemIds?: string[]; venomonIds?: string[]; currency?: boolean; anyVenomon?: boolean }
  ) => boolean;
}

function addInventory(
  inventory: InventoryItem[],
  definition: { id: string; name: string; category: InventoryItem["category"]; description: string },
  quantity: number
): InventoryItem[] {
  const existing = inventory.find((item) => item.id === definition.id);
  if (existing) {
    return inventory.map((item) =>
      item.id === definition.id ? { ...item, quantity: item.quantity + quantity } : item
    );
  }
  return [
    ...inventory,
    {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      quantity,
      description: definition.description
    }
  ];
}

function removeInventory(inventory: InventoryItem[], itemId: string, quantity: number): InventoryItem[] {
  return inventory
    .map((item) => (item.id === itemId ? { ...item, quantity: item.quantity - quantity } : item))
    .filter((item) => item.quantity > 0);
}

export function registerHousingHandlers({
  io,
  socket,
  world,
  auth,
  battleManager,
  eventRuntime,
  guardTradedAssets
}: HousingHandlerContext) {
  const housing = world.housing;

  const emitResult = (
    action: HouseAction,
    ok: boolean,
    messageKey: string,
    params?: Record<string, string>,
    mapId?: string
  ) => {
    socket.emit("house:result", { action, ok, messageKey, params, mapId });
  };

  type Actor = { player: Player; userId: number; characterId: number };
  const resolveActor = (action: HouseAction): Actor | null => {
    const player = world.getPlayerBySocket(socket.id);
    if (!player || typeof socket.data.userId !== "number" || player.characterId === null) {
      emitResult(action, false, "house.reason.notInWorld");
      return null;
    }
    if (player.inBattle || eventRuntime.isRunning(socket.data.userId)) {
      emitResult(action, false, "house.reason.busy");
      return null;
    }
    return { player, userId: socket.data.userId, characterId: player.characterId };
  };

  /** The player must stand on or next to the door cell (like berry plots). */
  const nearDoor = (player: Player, door: { mapId: string; x: number; y: number }) => {
    if (player.currentMapId !== door.mapId) return false;
    const cellSize = world.getMapCellSize(player.currentMapId);
    const current = player.getCurrentCell(cellSize);
    return Math.abs(current.x - door.x) + Math.abs(current.y - door.y) <= 1;
  };

  /** The canonical map transfer sequence (portals, Fly, events all repeat it). */
  const transfer = (player: Player, mapId: string, x: number, y: number) => {
    player.stopMovement();
    player.teleport(mapId, x, y);
    world.players.set(player.socketId, player);
    world.presentPlayerToMap(player);
    player.socketConnections.forEach((socketId) => {
      world.presentPlayersOnMapTo(socketId, player.currentMapId);
      io.to(socketId).emit("portal:used", { mapId: player.currentMapId });
    });
    if (typeof player.userId === "number") {
      void eventRuntime.runAutorunForMap(player.userId);
    }
  };

  const refreshSession = async (userId: number) => {
    const user = await auth.getUserForBattle(userId);
    if (user) {
      socket.emit("auth:session", { authenticated: true, user });
    }
  };

  socket.on("house:door-info", (data) => {
    const actor = resolveActor("door-info");
    if (!actor) return;
    const doorId = typeof data?.doorId === "string" ? data.doorId : "";
    const door = housing.getDoor(doorId);
    if (!door) {
      emitResult("door-info", false, "house.reason.noDoor");
      return;
    }
    if (!nearDoor(actor.player, door)) {
      emitResult("door-info", false, "house.reason.tooFar");
      return;
    }
    const cellSize = world.getMapCellSize(actor.player.currentMapId);
    actor.player.faceCell(door, cellSize);
    const summary = housing.doorSummary(doorId, actor.characterId);
    if (!summary) {
      emitResult("door-info", false, "house.reason.noDoor");
      return;
    }
    socket.emit("house:door-info", { t: Date.now(), door: summary });
  });

  socket.on("house:enter", (data) => {
    const actor = resolveActor("enter");
    if (!actor) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    const door = housing.doorOfApartment(apartmentId);
    if (!door) {
      emitResult("enter", false, "house.reason.unavailable");
      return;
    }
    if (!nearDoor(actor.player, door)) {
      emitResult("enter", false, "house.reason.tooFar");
      return;
    }
    const entry = housing.resolveEntry(apartmentId, actor.characterId, data?.keyCode);
    if (!entry.ok) {
      emitResult("enter", false, entry.error);
      return;
    }
    transfer(actor.player, entry.mapId, entry.x, entry.y);
    emitResult("enter", true, "house.msg.entered", undefined, entry.mapId);
  });

  socket.on("house:buy", async (data) => {
    const actor = resolveActor("buy");
    if (!actor) return;
    if (!guardTradedAssets("house:buy", { currency: true })) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    const door = housing.doorOfApartment(apartmentId);
    if (!door) {
      emitResult("buy", false, "house.reason.unavailable");
      return;
    }
    if (!nearDoor(actor.player, door)) {
      emitResult("buy", false, "house.reason.tooFar");
      return;
    }
    const quote = housing.purchasePrice(apartmentId, actor.characterId);
    if (!quote) {
      emitResult("buy", false, housing.isOwnerOf(apartmentId, actor.characterId) ? "house.reason.alreadyOwner" : "house.reason.notForSale");
      return;
    }
    try {
      const user = await auth.getUserForBattle(actor.userId);
      if (!user) {
        emitResult("buy", false, "house.reason.notInWorld");
        return;
      }
      if (user.money < quote.price) {
        emitResult("buy", false, "house.reason.notEnoughMoney", { price: String(quote.price) });
        return;
      }
      // Re-check the quote right before paying: another buyer may have won
      // the apartment while we read the wallet.
      const fresh = housing.purchasePrice(apartmentId, actor.characterId);
      if (!fresh || fresh.price !== quote.price || fresh.sellerCharacterId !== quote.sellerCharacterId) {
        emitResult("buy", false, "house.reason.notForSale");
        return;
      }
      await auth.saveBattleState(actor.userId, { money: user.money - quote.price });
      if (quote.sellerCharacterId !== null) {
        // The seller is paid on their character hash even while offline; an
        // online seller sees the money on their next session refresh.
        await auth.adjustCharacterMoney(quote.sellerCharacterId, quote.price);
        for (const other of world.players.values()) {
          if (other.characterId === quote.sellerCharacterId && typeof other.userId === "number") {
            const sellerUser = await auth.getUserForBattle(other.userId);
            other.socketConnections.forEach((socketId) => {
              if (sellerUser) io.to(socketId).emit("auth:session", { authenticated: true, user: sellerUser });
              io.to(socketId).emit("auth:info", { message: `Vendiste tu casa por $${quote.price}.` });
            });
          }
        }
      }
      housing.assignOwner(apartmentId, actor.characterId, actor.player.name || actor.player.username || "Trainer", quote.sellerCharacterId !== null);
      await refreshSession(actor.userId);
      emitResult("buy", true, quote.sellerCharacterId === null ? "house.msg.bought" : "house.msg.boughtFromPlayer", {
        price: String(quote.price)
      });
    } catch (error) {
      console.error("house:buy failed:", error);
      emitResult("buy", false, "house.reason.failed");
    }
  });

  socket.on("house:set-key", (data) => {
    const actor = resolveActor("key");
    if (!actor) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("key", false, "house.reason.notOwner");
      return;
    }
    const keyCode = data?.keyCode === null || data?.keyCode === undefined || data?.keyCode === "" ? null : data.keyCode;
    if (keyCode !== null && !isValidKeyCode(keyCode)) {
      emitResult("key", false, "house.reason.badKey");
      return;
    }
    if (!housing.setKeyCode(apartmentId, keyCode)) {
      emitResult("key", false, "house.reason.failed");
      return;
    }
    emitResult("key", true, keyCode === null ? "house.msg.keyCleared" : "house.msg.keySet");
  });

  socket.on("house:set-sale", (data) => {
    const actor = resolveActor("sale");
    if (!actor) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("sale", false, "house.reason.notOwner");
      return;
    }
    const raw = data?.price;
    const price =
      raw === null || raw === undefined
        ? null
        : typeof raw === "number" && Number.isFinite(raw) && raw > 0
          ? Math.min(MAX_SALE_PRICE, Math.round(raw))
          : NaN;
    if (Number.isNaN(price)) {
      emitResult("sale", false, "house.reason.badPrice");
      return;
    }
    if (!housing.setSalePrice(apartmentId, price)) {
      emitResult("sale", false, "house.reason.failed");
      return;
    }
    emitResult("sale", true, price === null ? "house.msg.saleCancelled" : "house.msg.saleListed", {
      price: String(price ?? 0)
    });
  });

  socket.on("house:leave", () => {
    const actor = resolveActor("leave");
    if (!actor) return;
    if (!isHouseInstanceMapId(actor.player.currentMapId)) {
      emitResult("leave", false, "house.reason.notInHouse");
      return;
    }
    const exit = housing.exitDestination(actor.player.currentMapId);
    if (!exit) {
      // The door vanished (map edited): fall back to the shared spawn.
      const snapshot = world.getPlayableMapsState();
      const initial = snapshot?.items.find((item) => item.playableMapConfig?.isInitialMap === true);
      if (!initial) {
        emitResult("leave", false, "house.reason.failed");
        return;
      }
      const placement = world.resolveAutomaticPlacement(initial.id, 32, 32);
      transfer(actor.player, initial.id, placement.x, placement.y);
      emitResult("leave", true, "house.msg.left", undefined, initial.id);
      return;
    }
    transfer(actor.player, exit.mapId, exit.x, exit.y);
    emitResult("leave", true, "house.msg.left", undefined, exit.mapId);
  });

  socket.on("house:furniture-place", async (data) => {
    const actor = resolveActor("place");
    if (!actor) return;
    const itemId = typeof data?.itemId === "string" ? data.itemId : "";
    if (!guardTradedAssets("house:furniture-place", { itemIds: [itemId] })) return;
    const mapId = actor.player.currentMapId;
    const apartmentId = housing.apartmentOfInstance(mapId);
    if (!apartmentId) {
      emitResult("place", false, "house.reason.notInHouse");
      return;
    }
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("place", false, "house.reason.notOwner");
      return;
    }
    const x = typeof data?.x === "number" && Number.isFinite(data.x) ? Math.round(data.x) : -1;
    const y = typeof data?.y === "number" && Number.isFinite(data.y) ? Math.round(data.y) : -1;
    try {
      const user = await auth.getUserForBattle(actor.userId);
      const stack = user?.inventory.find((item) => item.id === itemId);
      if (!user || !stack || stack.quantity <= 0) {
        emitResult("place", false, "house.reason.noItem");
        return;
      }
      const definition = await battleManager.findItemDefinitionById(itemId, stack.name);
      const isFurniture = stack.category === "furniture" || definition?.type === "furniture";
      if (!isFurniture) {
        emitResult("place", false, "house.reason.notFurniture");
        return;
      }
      // A furniture item may be linked to a designer map object; that is what
      // gets drawn (and collides) in the house. No link = the icon on a tile.
      const asset = definition?.furnitureObjectId
        ? await battleManager.findMapObjectAssetById(definition.furnitureObjectId)
        : null;
      // Take the item first so a failed placement can never duplicate it.
      await auth.saveInventory(actor.userId, removeInventory(user.inventory, itemId, 1));
      const placed = housing.placeFurniture(
        mapId,
        {
          itemId,
          itemName: definition?.name ?? stack.name,
          iconSrc: definition?.iconSrc ?? "",
          object: asset
            ? { objectId: asset.id, imageSrc: asset.imageSrc, width: asset.width, height: asset.height, objectType: asset.objectType }
            : null
        },
        x,
        y
      );
      if (!placed.ok) {
        // Give it back.
        const current = await auth.getUserForBattle(actor.userId);
        if (current) {
          await auth.saveInventory(
            actor.userId,
            addInventory(current.inventory, { id: stack.id, name: stack.name, category: "furniture", description: stack.description }, 1)
          );
        }
        await refreshSession(actor.userId);
        emitResult("place", false, placed.error);
        return;
      }
      await refreshSession(actor.userId);
      emitResult("place", true, "house.msg.placed", { name: placed.furniture.itemName });
    } catch (error) {
      console.error("house:furniture-place failed:", error);
      emitResult("place", false, "house.reason.failed");
    }
  });

  socket.on("house:furniture-pick", async (data) => {
    const actor = resolveActor("pick");
    if (!actor) return;
    if (!guardTradedAssets("house:furniture-pick", {})) return;
    const mapId = actor.player.currentMapId;
    const apartmentId = housing.apartmentOfInstance(mapId);
    if (!apartmentId) {
      emitResult("pick", false, "house.reason.notInHouse");
      return;
    }
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("pick", false, "house.reason.notOwner");
      return;
    }
    const furnitureId = typeof data?.furnitureId === "string" ? data.furnitureId : "";
    const removed = housing.pickFurniture(mapId, furnitureId);
    if (!removed) {
      emitResult("pick", false, "house.reason.noFurniture");
      return;
    }
    try {
      const user = await auth.getUserForBattle(actor.userId);
      if (user) {
        const definition = await battleManager.findItemDefinitionById(removed.itemId, removed.itemName);
        await auth.saveInventory(
          actor.userId,
          addInventory(
            user.inventory,
            {
              id: removed.itemId,
              name: definition?.name ?? removed.itemName,
              category: "furniture",
              description: definition?.description ?? ""
            },
            1
          )
        );
      }
      await refreshSession(actor.userId);
      emitResult("pick", true, "house.msg.picked", { name: removed.itemName });
    } catch (error) {
      console.error("house:furniture-pick failed:", error);
      emitResult("pick", false, "house.reason.failed");
    }
  });

  socket.on("house:music-list", () => {
    socket.emit("house:music-list", { bgms: housing.availableMusic() });
  });

  socket.on("house:set-name", (data) => {
    const actor = resolveActor("name");
    if (!actor) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("name", false, "house.reason.notOwner");
      return;
    }
    const name = data?.name === null || data?.name === undefined ? null : sanitizeHouseName(data.name);
    if (data?.name !== null && data?.name !== undefined && name === null) {
      emitResult("name", false, "house.reason.badName");
      return;
    }
    if (!housing.setName(apartmentId, name)) {
      emitResult("name", false, "house.reason.failed");
      return;
    }
    emitResult("name", true, name === null ? "house.msg.nameCleared" : "house.msg.nameSet", { name: name ?? "" });
  });

  socket.on("house:set-music", (data) => {
    const actor = resolveActor("music");
    if (!actor) return;
    const apartmentId = typeof data?.apartmentId === "string" ? data.apartmentId : "";
    if (!housing.isOwnerOf(apartmentId, actor.characterId)) {
      emitResult("music", false, "house.reason.notOwner");
      return;
    }
    const bgm = data?.bgm === null || data?.bgm === undefined || data?.bgm === "" ? null : typeof data.bgm === "string" ? data.bgm.trim() : "";
    if (bgm !== null && (!bgm || !housing.availableMusic().includes(bgm))) {
      emitResult("music", false, "house.reason.badMusic");
      return;
    }
    if (!housing.setMusic(apartmentId, bgm)) {
      emitResult("music", false, "house.reason.failed");
      return;
    }
    emitResult("music", true, bgm === null ? "house.msg.musicCleared" : "house.msg.musicSet", { name: bgm ?? "" });
  });

  socket.on("house:set-roam", async (data) => {
    // Sent from the party window over the shared auth socket (authContext),
    // which never joined the world — resolve the player by account instead
    // of by socket id like the other handlers do.
    const userId = socket.data.userId;
    const player = typeof userId === "number" ? world.getPlayerByUserId(userId) : null;
    if (!player || typeof userId !== "number" || player.characterId === null) {
      emitResult("roam", false, "house.reason.notInWorld");
      return;
    }
    const actor: Actor = { player, userId, characterId: player.characterId };
    const requested = Array.isArray(data?.pokemonIds)
      ? data.pokemonIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    try {
      const user = await auth.getUserForBattle(actor.userId);
      const partyIds = new Set((user?.pokemonParty ?? []).filter((mon) => !mon.isEgg).map((mon) => mon.id));
      const ids = Array.from(new Set(requested.filter((id) => partyIds.has(id)))).slice(0, 6);
      await auth.saveHouseRoamIds(actor.userId, ids);
      await refreshSession(actor.userId);
      await world.houseRoamers.refreshFor(actor.player);
      emitResult("roam", true, ids.length > 0 ? "house.msg.roamSet" : "house.msg.roamCleared", {
        count: String(ids.length)
      });
    } catch (error) {
      console.error("house:set-roam failed:", error);
      emitResult("roam", false, "house.reason.failed");
    }
  });
}
