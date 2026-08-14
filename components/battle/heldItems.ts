import type { BattleStatusId } from "./events";

/**
 * The three equipment slots a venomon exposes in the Estadísticas "Equipo"
 * tab. Every equippable item belongs to exactly one slot (appearance items
 * are species-resolved: an Arceus plate is "appearance" on Arceus and a
 * plain type-boost "bonus" on anyone else).
 */
export type EquipmentSlot = "bonus" | "battle" | "appearance";

/** Stats a pinch berry can raise (mirrors the battle stage keys). */
export type PinchBerryStat =
  | "attack"
  | "defense"
  | "specialAttack"
  | "specialDefense"
  | "speed"
  | "random";

/**
 * Held item battle behaviors. A pokemon holding an item uses it on its own
 * when the trigger condition is met (classic in-battle berry/Leftovers
 * semantics). Effects resolve from the item's Essentials internal id first,
 * then from designer profile hints (effectKind / useCondition).
 */
export type HeldItemEffect =
  | { trigger: "hp-below-half"; action: "heal-amount"; amount: number; consumed: true }
  | { trigger: "hp-below-half"; action: "heal-fraction"; fraction: number; consumed: true }
  | { trigger: "status"; cures: BattleStatusId[] | "any"; curesConfusion: boolean; consumed: true }
  | { trigger: "end-of-turn"; action: "heal-fraction"; fraction: number; consumed: false }
  /** Pinch berries (Liechi...): below 1/4 max HP, raise a stat stage. */
  | { trigger: "pinch"; action: "stat-stages"; stat: PinchBerryStat; stages: number; consumed: true }
  /** Focus Sash: survive a lethal hit at 1 HP when taken from full HP. */
  | { trigger: "lethal-hit"; requiresFullHp: boolean; consumed: true }
  /** White Herb: reset every lowered stat stage right after the drop. */
  | { trigger: "stat-drop"; consumed: true }
  /** Flame Orb / Toxic Orb: inflict a status on the holder at end of turn. */
  | { trigger: "end-of-turn"; action: "self-status"; status: "burn" | "toxic"; consumed: false }
  /** Black Sludge: heals Poison-types, hurts everyone else. */
  | {
      trigger: "end-of-turn";
      action: "poison-heal-else-damage";
      healFraction: number;
      damageFraction: number;
      consumed: false;
    };

const HELD_EFFECTS_BY_INTERNAL_ID: Record<string, HeldItemEffect> = {
  // Modern berry names.
  ORANBERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 10, consumed: true },
  SITRUSBERRY: { trigger: "hp-below-half", action: "heal-fraction", fraction: 0.25, consumed: true },
  CHERIBERRY: { trigger: "status", cures: ["paralysis"], curesConfusion: false, consumed: true },
  CHESTOBERRY: { trigger: "status", cures: ["sleep"], curesConfusion: false, consumed: true },
  PECHABERRY: { trigger: "status", cures: ["poison", "toxic"], curesConfusion: false, consumed: true },
  RAWSTBERRY: { trigger: "status", cures: ["burn"], curesConfusion: false, consumed: true },
  ASPEARBERRY: { trigger: "status", cures: ["freeze"], curesConfusion: false, consumed: true },
  PERSIMBERRY: { trigger: "status", cures: [], curesConfusion: true, consumed: true },
  LUMBERRY: { trigger: "status", cures: "any", curesConfusion: true, consumed: true },
  // Gen II era names kept by older Essentials projects.
  BERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 10, consumed: true },
  GOLDBERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 30, consumed: true },
  PRZCUREBERRY: { trigger: "status", cures: ["paralysis"], curesConfusion: false, consumed: true },
  MINTBERRY: { trigger: "status", cures: ["sleep"], curesConfusion: false, consumed: true },
  PSNCUREBERRY: { trigger: "status", cures: ["poison", "toxic"], curesConfusion: false, consumed: true },
  ICEBERRY: { trigger: "status", cures: ["burn"], curesConfusion: false, consumed: true },
  BURNTBERRY: { trigger: "status", cures: ["freeze"], curesConfusion: false, consumed: true },
  BITTERBERRY: { trigger: "status", cures: [], curesConfusion: true, consumed: true },
  MIRACLEBERRY: { trigger: "status", cures: "any", curesConfusion: true, consumed: true },
  LEFTOVERS: { trigger: "end-of-turn", action: "heal-fraction", fraction: 1 / 16, consumed: false },
  // Pinch berries: +1 stage (Starf: +2 to a random stat) below 1/4 max HP.
  LIECHIBERRY: { trigger: "pinch", action: "stat-stages", stat: "attack", stages: 1, consumed: true },
  GANLONBERRY: { trigger: "pinch", action: "stat-stages", stat: "defense", stages: 1, consumed: true },
  SALACBERRY: { trigger: "pinch", action: "stat-stages", stat: "speed", stages: 1, consumed: true },
  PETAYABERRY: { trigger: "pinch", action: "stat-stages", stat: "specialAttack", stages: 1, consumed: true },
  APICOTBERRY: { trigger: "pinch", action: "stat-stages", stat: "specialDefense", stages: 1, consumed: true },
  STARFBERRY: { trigger: "pinch", action: "stat-stages", stat: "random", stages: 2, consumed: true },
  FOCUSSASH: { trigger: "lethal-hit", requiresFullHp: true, consumed: true },
  WHITEHERB: { trigger: "stat-drop", consumed: true },
  FLAMEORB: { trigger: "end-of-turn", action: "self-status", status: "burn", consumed: false },
  TOXICORB: { trigger: "end-of-turn", action: "self-status", status: "toxic", consumed: false },
  BLACKSLUDGE: {
    trigger: "end-of-turn",
    action: "poison-heal-else-damage",
    healFraction: 1 / 16,
    damageFraction: 1 / 8,
    consumed: false
  }
};

/**
 * Passive bonuses granted by an equipped item while it is held (as opposed to
 * the consumable trigger effects above). Applied by BattleManager at the
 * relevant battle hook; multipliers default to "no change" when absent.
 */
export type HeldBonusEffect = {
  /** Damaging moves of this type hit harder (Charcoal, Mystic Water...). */
  boostType?: string;
  boostTypeMultiplier?: number;
  /** Damage-class-wide power multipliers (Muscle Band / Wise Glasses). */
  physicalPowerMultiplier?: number;
  specialPowerMultiplier?: number;
  /** Every damaging move (Life Orb). */
  allPowerMultiplier?: number;
  /** Fraction of the holder's max HP lost after landing a damaging move (Life Orb). */
  selfDamageFraction?: number;
  /** Raw stat multipliers (Choice trio, Eviolite, Thick Club, Light Ball). */
  attackMultiplier?: number;
  specialAttackMultiplier?: number;
  defenseMultiplier?: number;
  specialDefenseMultiplier?: number;
  speedMultiplier?: number;
  /** Choice items: the holder is locked into the first move it uses. */
  choiceLock?: boolean;
  /** Restrict the bonus to these species internal names (Thick Club...). */
  onlySpecies?: string[];
  /** Eviolite: only while the holder can still evolve. */
  onlyIfCanEvolve?: boolean;
  /** Extra critical-hit stage (Scope Lens). */
  critStageBonus?: number;
  /** Chance for the holder's damaging moves to flinch the target (King's Rock). */
  flinchChance?: number;
  /** Chance to act first within the same priority bracket (Quick Claw). */
  quickClawChance?: number;
  /** Chance to survive a lethal hit at 1 HP (Focus Band). */
  focusBandChance?: number;
  /** Incoming accuracy is multiplied by this while the holder is targeted (BrightPowder). */
  incomingAccuracyMultiplier?: number;
  /** Battle EXP multiplier for the holder (Lucky Egg). */
  expMultiplier?: number;
  /** Trainer prize-money multiplier when the holder is in the winning party (Amulet Coin). */
  moneyMultiplier?: number;
  /** Extra power on super-effective moves (Expert Belt). */
  superEffectivePowerMultiplier?: number;
  /** The holder's own moves get this accuracy multiplier (Wide Lens). */
  accuracyMultiplier?: number;
  /** Heal this fraction of damage dealt after a landed damaging move (Shell Bell). */
  healDealtFraction?: number;
};

const TYPE_BOOST_ITEMS: Record<string, string> = {
  CHARCOAL: "FIRE",
  MYSTICWATER: "WATER",
  MIRACLESEED: "GRASS",
  MAGNET: "ELECTRIC",
  TWISTEDSPOON: "PSYCHIC",
  SILKSCARF: "NORMAL",
  BLACKBELT: "FIGHTING",
  SHARPBEAK: "FLYING",
  POISONBARB: "POISON",
  SOFTSAND: "GROUND",
  HARDSTONE: "ROCK",
  SILVERPOWDER: "BUG",
  SPELLTAG: "GHOST",
  NEVERMELTICE: "ICE",
  DRAGONFANG: "DRAGON",
  METALCOAT: "STEEL",
  BLACKGLASSES: "DARK",
  // Arceus plates double as plain type boosters for any other holder
  // (their appearance role on Arceus itself wins in classifyEquipmentSlot).
  FLAMEPLATE: "FIRE",
  SPLASHPLATE: "WATER",
  ZAPPLATE: "ELECTRIC",
  MEADOWPLATE: "GRASS",
  ICICLEPLATE: "ICE",
  FISTPLATE: "FIGHTING",
  TOXICPLATE: "POISON",
  EARTHPLATE: "GROUND",
  SKYPLATE: "FLYING",
  MINDPLATE: "PSYCHIC",
  INSECTPLATE: "BUG",
  STONEPLATE: "ROCK",
  SPOOKYPLATE: "GHOST",
  DRACOPLATE: "DRAGON",
  DREADPLATE: "DARK",
  IRONPLATE: "STEEL",
  // Type-boosting incenses.
  SEAINCENSE: "WATER",
  WAVEINCENSE: "WATER",
  ROSEINCENSE: "GRASS",
  ODDINCENSE: "PSYCHIC",
  ROCKINCENSE: "ROCK"
};

const HELD_BONUSES_BY_INTERNAL_ID: Record<string, HeldBonusEffect> = {
  ...Object.fromEntries(
    Object.entries(TYPE_BOOST_ITEMS).map(([itemId, type]) => [
      itemId,
      { boostType: type, boostTypeMultiplier: 1.2 } satisfies HeldBonusEffect
    ])
  ),
  MUSCLEBAND: { physicalPowerMultiplier: 1.1 },
  WISEGLASSES: { specialPowerMultiplier: 1.1 },
  CHOICEBAND: { attackMultiplier: 1.5, choiceLock: true },
  CHOICESPECS: { specialAttackMultiplier: 1.5, choiceLock: true },
  CHOICESCARF: { speedMultiplier: 1.5, choiceLock: true },
  LIFEORB: { allPowerMultiplier: 1.3, selfDamageFraction: 0.1 },
  SCOPELENS: { critStageBonus: 1 },
  KINGSROCK: { flinchChance: 0.1 },
  QUICKCLAW: { quickClawChance: 0.2 },
  FOCUSBAND: { focusBandChance: 0.1 },
  BRIGHTPOWDER: { incomingAccuracyMultiplier: 0.9 },
  LUCKYEGG: { expMultiplier: 1.5 },
  AMULETCOIN: { moneyMultiplier: 2 },
  THICKCLUB: { attackMultiplier: 2, onlySpecies: ["CUBONE", "MAROWAK"] },
  LIGHTBALL: { attackMultiplier: 2, specialAttackMultiplier: 2, onlySpecies: ["PIKACHU"] },
  EVIOLITE: { defenseMultiplier: 1.5, specialDefenseMultiplier: 1.5, onlyIfCanEvolve: true },
  RAZORCLAW: { critStageBonus: 1 },
  RAZORFANG: { flinchChance: 0.1 },
  LAXINCENSE: { incomingAccuracyMultiplier: 0.9 },
  LUCKINCENSE: { moneyMultiplier: 2 },
  MACHOBRACE: { speedMultiplier: 0.5 },
  IRONBALL: { speedMultiplier: 0.5 },
  EXPERTBELT: { superEffectivePowerMultiplier: 1.2 },
  WIDELENS: { accuracyMultiplier: 1.1 },
  SHELLBELL: { healDealtFraction: 1 / 8 },
  SOULDEW: {
    specialAttackMultiplier: 1.5,
    specialDefenseMultiplier: 1.5,
    onlySpecies: ["LATIAS", "LATIOS"]
  },
  METALPOWDER: { defenseMultiplier: 2, onlySpecies: ["DITTO"] },
  QUICKPOWDER: { speedMultiplier: 2, onlySpecies: ["DITTO"] },
  DEEPSEATOOTH: { specialAttackMultiplier: 2, onlySpecies: ["CLAMPERL"] },
  DEEPSEASCALE: { specialDefenseMultiplier: 2, onlySpecies: ["CLAMPERL"] },
  STICK: { critStageBonus: 2, onlySpecies: ["FARFETCHD"] },
  LUCKYPUNCH: { critStageBonus: 2, onlySpecies: ["CHANSEY"] }
};

export function resolveHeldBonus(essentialsId?: string): HeldBonusEffect | null {
  const internalId = (essentialsId ?? "").trim().toUpperCase();
  return HELD_BONUSES_BY_INTERNAL_ID[internalId] ?? null;
}

/**
 * Internal ids the client offers for the BONUS slot — every passive-bonus item
 * plus the non-consumed trigger items (Leftovers, Black Sludge, Flame/Toxic
 * Orb) that behave like equipment.
 * KEEP IN SYNC with client-poke.io src/components/ux/game/equipableItems.ts.
 */
export const EQUIPABLE_INTERNAL_IDS: readonly string[] = [
  ...Object.keys(HELD_BONUSES_BY_INTERNAL_ID),
  "LEFTOVERS",
  "BLACKSLUDGE",
  "FLAMEORB",
  "TOXICORB"
];

/**
 * Appearance-slot items: while equipped they change how the venomon looks
 * (sprite form variants) and — for the Venova Adventure custom forms — its
 * typing, base stats, and known moves. Ported from the game's
 * MultipleForms "getForm"/"onSetForm" handlers (Venova Scripts.rxdata,
 * section Pokemon_MultipleForms; sprite numbering follows that project).
 * Only the ITEM trigger is ported: the scripts' map-id trigger
 * (maps 49/50/51/72/73) is a copy-paste bug — those are Pokémon Centers and
 * houses, not the Distortion World. The Shiny Charm is an engine
 * adaptation: any holder swaps to its shiny (variocolor) sprites.
 */
export type AppearanceBaseStatsOverride = {
  hp?: number;
  attack?: number;
  defense?: number;
  specialAttack?: number;
  specialDefense?: number;
  speed?: number;
};

export type AppearanceEffect = {
  /** Species internal names the item works on; absent = any venomon. */
  onlySpecies?: string[];
  /** "_1"... — appended to the sprite file basename (GIRATINA_1.gif). */
  formSuffix?: string;
  /** Swap the front/back sprite directories for their -shiny variants. */
  shiny?: boolean;
  /** Display label for the UI ("Forma Origen"). */
  formName?: string;
  /** Replace the primary/secondary type while equipped (Venova forms). */
  typesOverride?: { type1?: string; type2?: string };
  /** Replace individual base stats while equipped (Venova forms). */
  baseStatsOverride?: AppearanceBaseStatsOverride;
  /** Move (Essentials internal id) the holder knows while equipped
   * (Canamate's HACKEO). Granted on equip, removed on unequip. */
  grantsMoveId?: string;
};

const ARCEUS = ["ARCEUS"];
const GENESECT = ["GENESECT"];

/**
 * Items shared between species (plates, Griseous Orb) carry one variant per
 * species; resolveAppearanceEffect picks the one matching the holder.
 */
export const APPEARANCE_ITEMS_BY_INTERNAL_ID: Record<
  string,
  AppearanceEffect | AppearanceEffect[]
> = {
  SHINYCHARM: { shiny: true, formName: "Variocolor" },
  // "Hueso Maldito": Sayolda (HAUNTER) Forma Origen in Venova; kept working
  // for stock Giratina too (Venova's scripts dropped that handler, but the
  // sprites and lore still exist).
  GRISEOUSORB: [
    {
      onlySpecies: ["HAUNTER"],
      formSuffix: "_1",
      formName: "Forma Origen",
      typesOverride: { type2: "DARK" },
      baseStatsOverride: { hp: 80, attack: 100, defense: 90, speed: 90, specialAttack: 120, specialDefense: 95 }
    },
    { onlySpecies: ["GIRATINA"], formSuffix: "_1", formName: "Forma Origen" }
  ],
  // "Pendrive": Canamate (ARIADOS) Forma Origen — gains DARK typing and the
  // exclusive move HACKEO while the pendrive is equipped.
  PENDRIVE: {
    onlySpecies: ["ARIADOS"],
    formSuffix: "_1",
    formName: "Forma Origen",
    typesOverride: { type2: "DARK" },
    baseStatsOverride: { hp: 70, attack: 50, defense: 70, speed: 90, specialAttack: 60, specialDefense: 100 },
    grantsMoveId: "HACKEO"
  },
  // "Reliquia Dorada": Elebeon (HOOTHOOT) Forma Origen — stats only.
  ADAMANTORB: {
    onlySpecies: ["HOOTHOOT"],
    formSuffix: "_1",
    formName: "Forma Origen",
    baseStatsOverride: { hp: 120, attack: 180, defense: 100, speed: 90, specialAttack: 100, specialDefense: 125 }
  },
  // "Zafiro Corrupto": Toniptera (GOLDUCK) Forma Origen.
  ZAFIRO: {
    onlySpecies: ["GOLDUCK"],
    formSuffix: "_1",
    formName: "Forma Origen",
    typesOverride: { type2: "GHOST" },
    baseStatsOverride: { hp: 70, attack: 60, defense: 78, speed: 120, specialAttack: 120, specialDefense: 80 }
  },
  // "Caparazón Fluvial": Morroan (PARASECT) Forma Origen.
  CAPARAZON: {
    onlySpecies: ["PARASECT"],
    formSuffix: "_1",
    formName: "Forma Origen",
    typesOverride: { type2: "WATER" },
    baseStatsOverride: { hp: 70, attack: 100, defense: 120, speed: 40, specialAttack: 60, specialDefense: 110 }
  },
  // "Lápida Oscura": Yaregon (TYPHLOSION) Forma Origen. The script's move
  // grant is dead code (no LAPIDA move exists in the game) — not ported.
  LAPIDA: {
    onlySpecies: ["TYPHLOSION"],
    formSuffix: "_1",
    formName: "Forma Origen",
    typesOverride: { type1: "DRAGON", type2: "GHOST" },
    baseStatsOverride: { hp: 130, attack: 150, defense: 90, speed: 110, specialAttack: 60, specialDefense: 120 }
  },
  // Arceus plates (BW form numbering: 9 = "?" type is intentionally unused).
  // Five of them are Faidy's (MEW) "Mágica" instruments in Venova and get a
  // second variant: a secondary-type change (STONEPLATE really is NORMAL per
  // the getForm table, despite boosting Rock damage as a held bonus).
  FISTPLATE: [
    { onlySpecies: ARCEUS, formSuffix: "_1", formName: "Tipo Lucha" },
    { onlySpecies: ["MEW"], formSuffix: "_2", formName: "Tambór Mágico", typesOverride: { type2: "FIGHTING" } }
  ],
  SKYPLATE: [
    { onlySpecies: ARCEUS, formSuffix: "_2", formName: "Tipo Volador" },
    { onlySpecies: ["MEW"], formSuffix: "_1", formName: "Flauta Mágica", typesOverride: { type2: "FLYING" } }
  ],
  TOXICPLATE: { onlySpecies: ARCEUS, formSuffix: "_3", formName: "Tipo Veneno" },
  EARTHPLATE: [
    { onlySpecies: ARCEUS, formSuffix: "_4", formName: "Tipo Tierra" },
    { onlySpecies: ["MEW"], formSuffix: "_3", formName: "Maraca Mágica", typesOverride: { type2: "GROUND" } }
  ],
  STONEPLATE: [
    { onlySpecies: ARCEUS, formSuffix: "_5", formName: "Tipo Roca" },
    { onlySpecies: ["MEW"], formSuffix: "_4", formName: "Cuatro Mágico", typesOverride: { type2: "NORMAL" } }
  ],
  INSECTPLATE: { onlySpecies: ARCEUS, formSuffix: "_6", formName: "Tipo Bicho" },
  SPOOKYPLATE: { onlySpecies: ARCEUS, formSuffix: "_7", formName: "Tipo Fantasma" },
  IRONPLATE: [
    { onlySpecies: ARCEUS, formSuffix: "_8", formName: "Tipo Acero" },
    { onlySpecies: ["MEW"], formSuffix: "_5", formName: "Arpa Mágica", typesOverride: { type2: "STEEL" } }
  ],
  FLAMEPLATE: { onlySpecies: ARCEUS, formSuffix: "_10", formName: "Tipo Fuego" },
  SPLASHPLATE: { onlySpecies: ARCEUS, formSuffix: "_11", formName: "Tipo Agua" },
  MEADOWPLATE: { onlySpecies: ARCEUS, formSuffix: "_12", formName: "Tipo Planta" },
  ZAPPLATE: { onlySpecies: ARCEUS, formSuffix: "_13", formName: "Tipo Eléctrico" },
  MINDPLATE: { onlySpecies: ARCEUS, formSuffix: "_14", formName: "Tipo Psíquico" },
  ICICLEPLATE: { onlySpecies: ARCEUS, formSuffix: "_15", formName: "Tipo Hielo" },
  DRACOPLATE: { onlySpecies: ARCEUS, formSuffix: "_16", formName: "Tipo Dragón" },
  DREADPLATE: { onlySpecies: ARCEUS, formSuffix: "_17", formName: "Tipo Siniestro" }
};

/** Normalizes "pokemon-GIRATINA" / "Giratina" to the species internal name. */
export function toSpeciesInternalId(sourcePokemonId?: string, fallbackName?: string): string {
  const fromSource = (sourcePokemonId ?? "").replace(/^pokemon-/i, "").trim().toUpperCase();
  return fromSource || (fallbackName ?? "").trim().toUpperCase();
}

export function resolveAppearanceEffect(
  essentialsId?: string,
  speciesInternalId?: string
): AppearanceEffect | null {
  const internalId = (essentialsId ?? "").trim().toUpperCase();
  const entry = APPEARANCE_ITEMS_BY_INTERNAL_ID[internalId];
  if (!entry) {
    return null;
  }
  const species = (speciesInternalId ?? "").toUpperCase();
  const variants = Array.isArray(entry) ? entry : [entry];
  return (
    variants.find(
      (variant) => !variant.onlySpecies || variant.onlySpecies.includes(species)
    ) ?? null
  );
}

/**
 * The holder's effective typing while the appearance item is equipped:
 * type1/type2 replace the species' base slots (a Venova "Forma Origen").
 * Base types come from the species definition, never from a previously
 * overridden list — callers must pass the catalog types.
 */
export function applyAppearanceToTypes(baseTypes: string[], effect: AppearanceEffect | null): string[] {
  if (!effect?.typesOverride) {
    return [...baseTypes];
  }
  const type1 = effect.typesOverride.type1 ?? baseTypes[0];
  const type2 = effect.typesOverride.type2 ?? baseTypes[1];
  const next = [type1, type2].filter(
    (type): type is string => typeof type === "string" && type.trim().length > 0
  );
  // Collapse duplicate slots (mono-type forms) while keeping order.
  return next.filter((type, index) => next.indexOf(type) === index);
}

/** The holder's effective base stats while the appearance item is equipped. */
export function applyAppearanceToBaseStats<T extends Record<string, number>>(
  baseStats: T,
  effect: AppearanceEffect | null
): T {
  if (!effect?.baseStatsOverride) {
    return baseStats;
  }
  const next = { ...baseStats } as Record<string, number>;
  for (const [stat, value] of Object.entries(effect.baseStatsOverride)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      next[stat] = value;
    }
  }
  return next as T;
}

/**
 * Rewrites a sprite path for an appearance effect. Form suffixes slot in
 * before the extension (/front/GIRATINA.gif -> /front/GIRATINA_1.gif); shiny
 * swaps the animation directory for its -shiny sibling. Icon paths are left
 * untouched — the sprite pack has no shiny icons and almost no form icons.
 */
export function applyAppearanceToSpritePath(
  src: string,
  effect: AppearanceEffect,
  kind: "front" | "back" | "icon"
): string {
  if (!src || kind === "icon") {
    return src;
  }
  let next = src;
  if (effect.shiny) {
    next = next.replace(`/${kind}/`, `/${kind}-shiny/`);
  }
  if (effect.formSuffix) {
    next = next.replace(/(\.[a-z0-9]+)$/i, `${effect.formSuffix}$1`);
  }
  return next;
}

/**
 * Which equipment slot an item belongs to for a given holder, or null when
 * it is not equippable at all. Appearance wins over bonus so form items
 * (plates on Arceus) land in the appearance slot for the species they
 * transform, while remaining ordinary boosters for everyone else.
 */
export function classifyEquipmentSlot(options: {
  essentialsId?: string;
  speciesInternalId?: string;
  heldBonus?: HeldBonusEffect | null;
  heldEffect?: HeldItemEffect | null;
}): EquipmentSlot | null {
  const internalId = (options.essentialsId ?? "").trim().toUpperCase();
  if (resolveAppearanceEffect(internalId, options.speciesInternalId)) {
    return "appearance";
  }
  const bonus = options.heldBonus !== undefined ? options.heldBonus : resolveHeldBonus(internalId);
  if (bonus) {
    return "bonus";
  }
  const effect =
    options.heldEffect !== undefined
      ? options.heldEffect
      : resolveHeldItemEffect({ essentialsId: internalId });
  if (effect) {
    return effect.consumed ? "battle" : "bonus";
  }
  return null;
}

export function resolveHeldItemEffect(options: {
  essentialsId?: string;
  effectKind?: string;
  useCondition?: string;
  healAmount?: number;
}): HeldItemEffect | null {
  const internalId = (options.essentialsId ?? "").trim().toUpperCase();
  if (internalId && HELD_EFFECTS_BY_INTERNAL_ID[internalId]) {
    return HELD_EFFECTS_BY_INTERNAL_ID[internalId];
  }

  const effectKind = (options.effectKind ?? "").trim().toLowerCase();
  const useCondition = (options.useCondition ?? "").trim().toLowerCase();

  if (effectKind === "heal" && (useCondition.includes("half") || useCondition.includes("pinch"))) {
    return {
      trigger: "hp-below-half",
      action: "heal-amount",
      amount: Math.max(1, Math.round(options.healAmount ?? 10)),
      consumed: true
    };
  }

  if (effectKind === "cure-status" || effectKind === "status-cure") {
    return { trigger: "status", cures: "any", curesConfusion: true, consumed: true };
  }

  return null;
}
