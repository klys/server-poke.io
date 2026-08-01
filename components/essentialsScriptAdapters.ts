/**
 * Version-aware recognition of Pokemon Essentials script calls found inside
 * imported RPG Maker events (Script commands and Script conditional branches).
 *
 * The event runtime stays version-neutral: it consumes the normalized
 * descriptors produced here. Each supported Essentials generation contributes
 * an adapter that knows its own spelling of the same concepts:
 *
 * - Venova Adventure ships on Essentials v3.1.1 (2009-era): `PBSpecies::X`,
 *   `PBItems::X`, `PBTrainers::X`, `Kernel.pbFoo`, `$PokemonBag`,
 *   `pbTrainerBattle(...)`.
 * - Venova Reforged targets Essentials v21.x: `:SYMBOL` species/items,
 *   `TrainerBattle.start`, `pbTrainerIntro`, `$bag`, `$player`.
 *
 * Adding a project on another Essentials version means adding an adapter (or
 * extending one) — not editing the runtime.
 *
 * Unrecognized script CONDITIONS must fail closed (the branch's else runs, or
 * nothing runs), because story gates live in these conditions; every
 * occurrence is recorded so the migration report can list what needs a
 * handler. Unrecognized script COMMANDS are skipped but likewise recorded.
 */

// Comparison operators appearing in scripted numeric checks.
export type NumericOp = ">=" | "<=" | ">" | "<" | "==" | "!=";

export function compareNumbers(op: NumericOp | string, left: number, right: number): boolean {
  switch (op) {
    case ">=": return left >= right;
    case "<=": return left <= right;
    case ">": return left > right;
    case "<": return left < right;
    case "==": return left === right;
    case "!=": return left !== right;
    default: return false;
  }
}

/** Normalized meaning of a script used as a conditional-branch test. */
export type ScriptConditionMatch =
  | { kind: "itemQuantity"; itemSymbol: string; op: NumericOp; value: number }
  | { kind: "hasItem"; itemSymbol: string; negated: boolean }
  | { kind: "canStoreItem" }
  | { kind: "boxesFull"; negated: boolean }
  | { kind: "daycareDeposited"; op: NumericOp; value: number }
  | { kind: "tempSwitch"; channel: string; on: boolean }
  | { kind: "onEvent" }
  | { kind: "gameSwitch"; id: number; negated: boolean }
  | { kind: "variableCompare"; id: number; op: NumericOp; value: number }
  // Systems the online engine does not simulate; the original condition would
  // be false for a player outside those modes, so hiding is faithful enough.
  | { kind: "alwaysFalse"; reason: string }
  // Cosmetic checks where allowing the branch cannot skip progression.
  | { kind: "alwaysTrue"; reason: string };

// ---------------------------------------------------------------------------
// Shared spellings (already tolerant of both generations where the runtime
// historically accepted either). Species/item/trainer constant prefixes:
// v3.1.1 uses `PBSpecies::` / `PBItems::` / `PBTrainers::`; v21 uses `:SYM`.
// ---------------------------------------------------------------------------

export const RE_ADD_POKEMON = /(?:Kernel\.)?pbAddPokemon\(\s*(?:PBSpecies::|:)(\w+)\s*,\s*(\d+)/i;
export const RE_GENERATE_EGG = /(?:Kernel\.)?pbGenerateEgg\(\s*(?:PBSpecies::|:)(\w+)/i;
export const RE_EGG_GENERATED = /pbEggGenerated\??/i;
export const RE_DAYCARE_GENERATE_EGG = /pbDayCareGenerateEgg/i;
export const RE_PARTY_LENGTH = /\$Trainer\.party\.length\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
export const RE_POKEMON_COUNT = /\$(?:Trainer|player)\.(?:pokemonCount|partyCount|pokemon_count)\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
export const RE_RECEIVE_ITEM = /pbReceive(?:Item)?\(\s*(?:PBItems::|:)(\w+)/i;
export const RE_ITEM_BALL = /pbItemBall\(\s*(?:PBItems::|:)(\w+)/i;
export const RE_ITEM_BALL_VAR = /pbItemBall\(\s*pbGet\(\s*(\d+)\s*\)/i;
export const RE_STORE_ITEM = /pbStoreItem\(\s*(?:PBItems::|:)(\w+)/i;
export const RE_POKEDEX = /\$Trainer\.pokedex\s*=\s*true/i;
// Venova grants running via a bare flag ("Mamá" on Map014: "Zapatos Nike");
// the engine models it as the RUNNINGSHOES quest item so it shows in the bag.
export const RE_RUNNING_SHOES = /\$PokemonGlobal\.runningShoes\s*=\s*(true|false)/i;
export const RE_AWARD_BADGE = /\$(?:Trainer|player)\.badges\[\s*(\d+)\s*\]\s*=\s*true/i;
export const RE_RECEIVE_BADGE = /pbReceiveBadge\(\s*(\d+)\s*\)/i;
export const RE_NUMBADGES = /\$(?:Trainer|player)\.(?:numbadges|badge_count)\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
export const RE_HAS_BADGE = /\$(?:Trainer|player)\.badges\[\s*(\d+)\s*\]/i;
export const RE_HEAL = /pbHealAll|pbHealParty|Recover All/i;
export const RE_CHANGE_PLAYER = /pbChangePlayer\(\s*(\d)\s*\)/i;
// v3.1.1 trainer battles; v21 uses TrainerBattle.start (see adapter below).
// Both constant spellings appear in the data (PBTrainers::X and :X — the
// rival battle on the SS Ancla uses the symbol form).
export const RE_TRAINER_BATTLE = /pbTrainerBattle\(\s*(?:PBTrainers::|:)(\w+)\s*,\s*"([^"]+)"/i;
export const RE_TRAINER_BATTLE_V21 = /TrainerBattle\.start\(\s*:(\w+)\s*,\s*"([^"]+)"/i;
export const RE_WILD_BATTLE = /pbWildBattle\(\s*(?:PBSpecies::|:)(\w+)\s*,\s*(\d+)/i;
export const RE_TRAINER_NAME = /pbTrainerName/i;
export const RE_TONE_CHANGE = /pbToneChangeAll\(\s*Tone\.new\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)[^)]*\)\s*,\s*(\d+)/i;
export const RE_SET_POKECENTER = /pbSetPokemonCenter/i;
export const RE_POKEMON_MART = /pbPokemonMart\(\s*\[([^\]]*)\]/i;
export const RE_POKEMON_PC = /pbPokeCenterPC|pbTrainerPC/i;
export const RE_SE_PLAY = /pbSEPlay\(\s*"([^"]+)"/i;
export const RE_PB_WAIT = /pbWait\(\s*(\d+)\s*\)/i;
export const RE_BUTTON_SCREEN = /pbEventScreen\(\s*ButtonEventScene\s*\)/i;
export const RE_CUT = /pbCut\b/i;
export const RE_ROCKSMASH_COND = /pbRockSmash(?!Random)/i;
export const RE_ERASE_EVENT = /pbEraseThisEvent/i;
export const RE_ROCKSMASH_ENCOUNTER = /pbRockSmashRandomEncounter/i;

// Trade / item-conversion NPC family: in-game trades ("Intercambio básico"),
// the fossil reviver (Genetista), Kurt's apricorn balls, the name rater.
// Numeric item/variable values use the legacy pre-v20 item numbering
// (legacyItemNumbers.ts); species conversions keep the ITEM number in the
// variable and resolve the species through the event's own conversion pairs.
export const RE_CHOOSE_POKEMON = /(?:Kernel\.)?pbChoosePokemon\(\s*(\d+)\s*,\s*(\d+)/i;
export const RE_START_TRADE = /(?:Kernel\.)?pbStartTrade\(\s*pbGet\(\s*(\d+)\s*\)\s*,\s*(?:PBSpecies::|:)(\w+)\s*,\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?/i;
export const RE_CHOOSE_ITEM_LIST = /(?:Kernel\.)?pbChooseItemFromList\(\s*(?:_I\(\s*)?"([\s\S]*?)"\s*\)?\s*,\s*(\d+)\s*,([\s\S]*?)\)/i;
export const RE_DELETE_ITEM = /\$PokemonBag\.pbDeleteItem\(\s*(?:(?:PBItems::|:)(\w+)|pbGet\(\s*(\d+)\s*\))/i;
export const RE_RECEIVE_ITEM_VAR = /pbReceive(?:Item)?\(\s*pbGet\(\s*(\d+)\s*\)/i;
export const RE_CONVERT_ITEM_TO_ITEM = /pbConvertItemToItem\(\s*(\d+)\s*,\s*\[([\s\S]*?)\]/i;
export const RE_CONVERT_ITEM_TO_POKEMON = /pbConvertItemToPokemon\(\s*(\d+)\s*,\s*\[([\s\S]*?)\]/i;
export const RE_SET_VAR_ITEM_NAME = /(?:pbSet\(\s*(\d+)\s*,|\$game_variables\[\s*(\d+)\s*\]\s*=)\s*PBItems\.getName\(\s*pbGet\(\s*(\d+)\s*\)/i;
export const RE_SET_VAR_SPECIES_NAME = /(?:pbSet\(\s*(\d+)\s*,|\$game_variables\[\s*(\d+)\s*\]\s*=)\s*PBSpecies\.getName\(\s*pbGet\(\s*(\d+)\s*\)/i;
export const RE_ADD_TO_PARTY_VAR = /(?:Kernel\.)?pbAddToParty\(\s*pbGet\(\s*(\d+)\s*\)\s*(?:,\s*(\d+))?/i;
export const RE_PICK_BERRY = /(?:Kernel\.)?pbPickBerry\(\s*:(\w+)\s*(?:,\s*(\d+))?/i;
export const RE_TEXT_ENTRY = /pbTextEntry\(\s*"([\s\S]*?)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i;
export const RE_GET_POKEMON_EGG = /pbGetPokemon\(\s*(\d+)\s*\)\.egg\?/i;
export const RE_GET_POKEMON_SHADOW = /pbGetPokemon\(\s*(\d+)\s*\)\.isShadow\?/i;
export const RE_GET_POKEMON_FOREIGN = /pbGetPokemon\(\s*(\d+)\s*\)\.isForeign\?/i;
export const RE_CHECK_ABLE_VAR = /^(!?)\s*(?:Kernel\.)?pbCheckAble\(\s*pbGet\(\s*(\d+)\s*\)\s*\)$/i;
export const RE_RENAME_TO_SPECIES = /pkmn\s*=\s*pbGetPokemon\(\s*(\d+)\s*\)[\s\S]*pkmn\.name\s*=\s*PBSpecies\.getName\(/i;
export const RE_RENAME_TO_VAR = /pkmn\s*=\s*pbGetPokemon\(\s*(\d+)\s*\)[\s\S]*pkmn\.name\s*=\s*pbGet\(\s*(\d+)\s*\)/i;
export const RE_VAR_EQ_PKMN_NAME = /\$game_variables\[\s*(\d+)\s*\]\s*=\s*pkmn\.name/i;
export const RE_STRING_VAR_EMPTY_OR_EQ = /^\$game_variables\[\s*(\d+)\s*\]\s*==\s*""\s*\|\|\s*\$game_variables\[\s*(\d+)\s*\]\s*==\s*pbGet\(\s*(\d+)\s*\)$/i;
export const RE_PLAYER_CELL_COORD = /^\$game_player\.(x|y)\s*==\s*(\d+)$/i;

// Essentials temp switches (per-event, session-scoped) and cross-event self
// switches — the Venova door/cutscene templates depend on both.
export const RE_SET_TEMP_SWITCH = /(?:Kernel\.)?setTempSwitch(On|Off)\(\s*"(\w+)"\s*\)/i;
export const RE_SET_SELF_SWITCH_OTHER = /(?:Kernel\.)?pbSetSelfSwitch\(\s*(\d+)\s*,\s*"(\w+)"\s*,\s*(true|false)\s*\)/i;

/** Matches either generation's trainer-battle spelling. */
export function matchTrainerBattle(text: string): { trainerType: string; trainerName: string } | null {
  const v3 = text.match(RE_TRAINER_BATTLE);
  if (v3) {
    return { trainerType: v3[1], trainerName: v3[2] };
  }
  const v21 = text.match(RE_TRAINER_BATTLE_V21);
  if (v21) {
    return { trainerType: v21[1], trainerName: v21[2] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Script-condition recognizers (per version, then chained)
// ---------------------------------------------------------------------------

export type EssentialsScriptAdapter = {
  id: string;
  description: string;
  recognizeCondition: (text: string) => ScriptConditionMatch | null;
};

const OP = "(>=|<=|==|!=|>|<)";

function num(value: string): number {
  return Number(value);
}

/** Essentials v3.1.1 (Venova Adventure) condition spellings. */
export const venovaAdventureAdapter: EssentialsScriptAdapter = {
  id: "venova-adventure-v3.1.1",
  description: "Pokemon Essentials v3.1.1 script conventions (Venova Adventure)",
  recognizeCondition(text: string): ScriptConditionMatch | null {
    const trimmed = text.trim();

    let match = trimmed.match(
      new RegExp(`\\$PokemonBag\\.pbQuantity\\(\\s*(?:PBItems::|:)(\\w+)\\s*\\)\\s*${OP}\\s*(\\d+)`, "i")
    );
    if (match) {
      return { kind: "itemQuantity", itemSymbol: match[1], op: match[2] as NumericOp, value: num(match[3]) };
    }

    match = trimmed.match(/^(!?)\s*\$PokemonBag\.pbHasItem\?\(\s*(?:PBItems::|:)(\w+)/i);
    if (match) {
      return { kind: "hasItem", itemSymbol: match[2], negated: match[1] === "!" };
    }

    if (/\$PokemonBag\.pbCanStore\?\(/i.test(trimmed)) {
      return { kind: "canStoreItem" };
    }

    match = trimmed.match(/^(!?)\s*(?:Kernel\.)?pbBoxesFull\?/i);
    if (match) {
      return { kind: "boxesFull", negated: match[1] === "!" };
    }

    match = trimmed.match(new RegExp(`(?:Kernel\\.)?pbDayCareDeposited\\s*${OP}\\s*(\\d+)`, "i"));
    if (match) {
      return { kind: "daycareDeposited", op: match[1] as NumericOp, value: num(match[2]) };
    }

    match = trimmed.match(/^(?:Kernel\.)?(?:tsOn\?|isTempSwitchOn\?)\(\s*"(\w+)"\s*\)$/i);
    if (match) {
      return { kind: "tempSwitch", channel: match[1], on: true };
    }
    match = trimmed.match(/^(?:Kernel\.)?(?:tsOff\?|isTempSwitchOff\?)\(\s*"(\w+)"\s*\)$/i);
    if (match) {
      return { kind: "tempSwitch", channel: match[1], on: false };
    }

    // Line-of-sight trainer/door template: true when the player is standing
    // exactly on this event's tile.
    if (/get_character\(\s*0\s*\)\.onEvent\?/i.test(trimmed)) {
      return { kind: "onEvent" };
    }

    match = trimmed.match(/^(!?)\s*\$game_switches\[\s*(\d+)\s*\]$/i);
    if (match) {
      return { kind: "gameSwitch", id: num(match[2]), negated: match[1] === "!" };
    }

    match =
      trimmed.match(new RegExp(`^(?:Kernel\\.)?pbGet\\(\\s*(\\d+)\\s*\\)\\s*${OP}\\s*(\\d+)$`, "i")) ??
      trimmed.match(new RegExp(`^\\$game_variables\\[\\s*(\\d+)\\s*\\]\\s*${OP}\\s*(\\d+)$`, "i"));
    if (match) {
      return { kind: "variableCompare", id: num(match[1]), op: match[2] as NumericOp, value: num(match[3]) };
    }

    // Systems intentionally not simulated online. Their pages/branches should
    // behave as they do for a player who is not in those modes: hidden.
    if (/(?:Kernel\.)?pbPokerus\?/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "pokerus-not-simulated" };
    }
    if (/\$Trainer\.mysterygiftaccess|pbNextMysteryGiftID|pbReceiveMysteryGift/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "mystery-gift-not-simulated" };
    }
    if (/pbInSafari\?|pbInBugContest\?|pbBugContestUndecided\?|pbSafariState/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "mode-not-simulated" };
    }
    // Phone rematches are not simulated: the "wants a rematch" branches stay
    // hidden, leaving the trainer's ordinary post-defeat page — faithful for
    // a player who never registered anyone.
    if (/pbPhoneBattleCount|pbPhoneRegistered\?/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "phone-not-simulated" };
    }
    // Pokegear is not simulated (no gear overlay online).
    if (/^\$Trainer\.pokegear$/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "pokegear-not-simulated" };
    }
    // Every online player has the dex (CanaimaDex), so "!$Trainer.pokedex"
    // (the "you don't have a dex yet" branch) is never true.
    if (/^!\$Trainer\.pokedex$/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "pokedex-always-owned" };
    }
    // Move relearner screens are not simulated in events yet; the "has moves
    // to remember" branches stay hidden so the NPC politely declines.
    if (/pbHasRelearnableMove\?|pbRelearnMoveScreen/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "move-relearn-not-simulated" };
    }
    if (/pbDayCareGetLevelGain/i.test(trimmed)) {
      return { kind: "alwaysFalse", reason: "daycare-level-gain-not-simulated" };
    }

    return null;
  }
};

/** Essentials v21.x (Venova Reforged) condition spellings. */
export const essentialsV21Adapter: EssentialsScriptAdapter = {
  id: "essentials-v21",
  description: "Pokemon Essentials v21.x script conventions (Venova Reforged)",
  recognizeCondition(text: string): ScriptConditionMatch | null {
    const trimmed = text.trim();

    let match = trimmed.match(new RegExp(`\\$bag\\.quantity\\(\\s*:(\\w+)\\s*\\)\\s*${OP}\\s*(\\d+)`, "i"));
    if (match) {
      return { kind: "itemQuantity", itemSymbol: match[1], op: match[2] as NumericOp, value: num(match[3]) };
    }

    match = trimmed.match(/^(!?)\s*\$bag\.has\?\(\s*:(\w+)/i);
    if (match) {
      return { kind: "hasItem", itemSymbol: match[2], negated: match[1] === "!" };
    }

    if (/\$bag\.can_add\?\(/i.test(trimmed)) {
      return { kind: "canStoreItem" };
    }

    match = trimmed.match(/^(!?)\s*\$PokemonStorage\.full\?/i);
    if (match) {
      return { kind: "boxesFull", negated: match[1] === "!" };
    }

    return null;
  }
};

const ADAPTER_CHAIN: EssentialsScriptAdapter[] = [venovaAdventureAdapter, essentialsV21Adapter];

/** Tries every version adapter in order; null = no adapter understands it. */
export function recognizeScriptCondition(text: string): ScriptConditionMatch | null {
  for (const adapter of ADAPTER_CHAIN) {
    const match = adapter.recognizeCondition(text);
    if (match) {
      return match;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ignorable script commands (cosmetic / not simulated). Recognizing them
// explicitly keeps the unsupported-command log focused on real gaps.
// ---------------------------------------------------------------------------

const IGNORABLE_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /pbTrainerEnd/i, reason: "trainer-battle-epilogue" },
  { pattern: /pbTrainerIntro/i, reason: "trainer-battle-intro" },
  { pattern: /pbNoticePlayer/i, reason: "trainer-notice-animation" },
  { pattern: /pbExclaim|pbSingleExclaim/i, reason: "exclaim-bubble" },
  { pattern: /pbPokemonFollow|pbToggleFollowingPokemon/i, reason: "follower-pokemon" },
  { pattern: /pbPhoneRegisterBattle|pbPhoneRegister/i, reason: "phone-not-simulated" },
  { pattern: /pbBerryPlant/i, reason: "berry-plant-not-simulated" },
  { pattern: /pbShowMap|pbTownMap/i, reason: "town-map-overlay" },
  { pattern: /pbMoveRoute|pbTurnTowardPlayer|pbMoveTowardPlayer/i, reason: "scripted-move-route" },
  { pattern: /pbChooseNonEggPokemon|pbChoosePokemon/i, reason: "party-picker-not-simulated" },
  { pattern: /pbFadeOutIn|pbSceneStandby/i, reason: "scene-transition" },
  { pattern: /^\s*p(?:rint)?\s+/i, reason: "debug-print" },
  // Kurt's "come back tomorrow" timestamp; the online NPC finishes instantly.
  { pattern: /^pbSetEventTime$/i, reason: "event-time-cooldown" },
  { pattern: /pbPhoneIncrement|pbTrainerCheck\(/i, reason: "phone-not-simulated" },
  { pattern: /\$Trainer\.pokegear\s*=|\$Trainer\.mysterygiftaccess\s*=|pbNextMysteryGiftID/i, reason: "feature-not-simulated" },
  // Ruby local-variable staging lines that carry no effect on their own
  // (multi-line scripts that DO act are matched before classification).
  { pattern: /^\s*\w+\s*=\s*(?:\$Trainer\.lastParty|\$Trainer\.pokemonParty\[\d+\]|pbGetPokemon\(\s*\d+\s*\)|pbGet\(\s*\d+\s*\))\s*$/i, reason: "script-variable-staging" }
];

/** Reason label when the script command is safely ignorable, else null. */
export function classifyIgnorableCommand(text: string): string | null {
  for (const entry of IGNORABLE_COMMANDS) {
    if (entry.pattern.test(text)) {
      return entry.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unsupported-usage log: one entry per distinct script text, with context of
// first sighting and a counter. The migration report reads this at runtime
// (admin tooling) and the console warns once per distinct script.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Coverage predicates for the migration report: whether the event runtime has
// a real handler for a script text. Kept HERE, next to the patterns the
// runtime imports, so report and runtime cannot drift apart silently.
// ---------------------------------------------------------------------------

const HANDLED_CONDITION_PATTERNS: RegExp[] = [
  RE_WILD_BATTLE,
  RE_ADD_POKEMON,
  RE_GENERATE_EGG,
  RE_EGG_GENERATED,
  RE_PARTY_LENGTH,
  RE_POKEMON_COUNT,
  RE_ITEM_BALL_VAR,
  RE_ITEM_BALL,
  RE_RECEIVE_ITEM,
  RE_STORE_ITEM,
  RE_NUMBADGES,
  RE_HAS_BADGE,
  RE_CUT,
  RE_ROCKSMASH_COND,
  RE_RECEIVE_ITEM_VAR,
  RE_ADD_TO_PARTY_VAR,
  RE_GET_POKEMON_EGG,
  RE_GET_POKEMON_SHADOW,
  RE_GET_POKEMON_FOREIGN,
  RE_CHECK_ABLE_VAR,
  RE_STRING_VAR_EMPTY_OR_EQ,
  RE_PLAYER_CELL_COORD
];

/** True when EventRuntime.evaluate() has a real handler for this script test. */
export function isScriptConditionHandled(text: string): boolean {
  if (matchTrainerBattle(text)) {
    return true;
  }
  if (HANDLED_CONDITION_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return recognizeScriptCondition(text) !== null;
}

const HANDLED_COMMAND_PATTERNS: RegExp[] = [
  RE_SET_TEMP_SWITCH,
  RE_SET_SELF_SWITCH_OTHER,
  RE_ERASE_EVENT,
  RE_ROCKSMASH_ENCOUNTER,
  RE_ADD_POKEMON,
  RE_GENERATE_EGG,
  RE_DAYCARE_GENERATE_EGG,
  RE_POKEMON_MART,
  RE_POKEMON_PC,
  RE_ITEM_BALL_VAR,
  RE_ITEM_BALL,
  RE_RECEIVE_ITEM,
  RE_STORE_ITEM,
  RE_POKEDEX,
  RE_AWARD_BADGE,
  RE_RECEIVE_BADGE,
  RE_HEAL,
  RE_WILD_BATTLE,
  RE_CHANGE_PLAYER,
  RE_TRAINER_NAME,
  RE_TONE_CHANGE,
  RE_SET_POKECENTER,
  RE_SE_PLAY,
  RE_PB_WAIT,
  RE_BUTTON_SCREEN,
  RE_CHOOSE_POKEMON,
  RE_START_TRADE,
  RE_CHOOSE_ITEM_LIST,
  RE_DELETE_ITEM,
  RE_RECEIVE_ITEM_VAR,
  RE_CONVERT_ITEM_TO_ITEM,
  RE_CONVERT_ITEM_TO_POKEMON,
  RE_SET_VAR_ITEM_NAME,
  RE_SET_VAR_SPECIES_NAME,
  RE_PICK_BERRY,
  RE_TEXT_ENTRY,
  RE_RENAME_TO_SPECIES,
  RE_RENAME_TO_VAR
];

/** True when EventRuntime.applyScript() handles (or safely ignores) this script. */
export function isScriptCommandHandled(text: string): boolean {
  if (matchTrainerBattle(text)) {
    return true;
  }
  if (HANDLED_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return classifyIgnorableCommand(text) !== null;
}

export type UnsupportedScriptEntry = {
  usage: "condition" | "command";
  text: string;
  firstContext: string;
  count: number;
};

const unsupportedLog = new Map<string, UnsupportedScriptEntry>();

export function logUnsupportedScript(
  usage: "condition" | "command",
  text: string,
  context: string
) {
  const key = `${usage}:${text}`;
  const existing = unsupportedLog.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  unsupportedLog.set(key, { usage, text, firstContext: context, count: 1 });
  console.warn(
    `[essentials-compat] Unsupported script ${usage} (fails ${usage === "condition" ? "closed" : "as no-op"}) at ${context}: ${text.split("\n")[0].slice(0, 160)}`
  );
}

export function getUnsupportedScriptLog(): UnsupportedScriptEntry[] {
  return Array.from(unsupportedLog.values());
}
