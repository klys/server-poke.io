import type { RedisClientType } from "redis";
import type { DesignerSectionItem } from "./DesignerSectionStore";

export type LevelingCurveConfig = {
  startExpForNextLevel: number;
  expGainedPerBattle: number;
  bonusDefeatingHigherLevelFormula: string;
  debonusDefeatingLowerLevelFormula: string;
  percentageExpIncreaseNextLevel: number;
};

export type PokemonStatBonuses = {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
};

type FormulaVariables = {
  Alvl: number;
  Blvl: number;
};

type FormulaToken =
  | { type: "number"; value: number }
  | { type: "identifier"; value: keyof FormulaVariables }
  | { type: "operator"; value: "+" | "-" | "*" | "/" | "(" | ")" };

const LEVELING_CURVE_REDIS_KEY = "designer:section:levelingCurve";

export const DEFAULT_LEVELING_CURVE_CONFIG: LevelingCurveConfig = {
  startExpForNextLevel: 100,
  expGainedPerBattle: 50,
  bonusDefeatingHigherLevelFormula: "5% * (Blvl - Alvl)",
  debonusDefeatingLowerLevelFormula: "1% * (Alvl - Blvl)",
  percentageExpIncreaseNextLevel: 10
};

export function createEmptyPokemonStatBonuses(): PokemonStatBonuses {
  return {
    hp: 0,
    attack: 0,
    defense: 0,
    specialAttack: 0,
    specialDefense: 0,
    speed: 0
  };
}

function clampLevel(value: number) {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function sanitizeNonNegativeNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function sanitizePositiveInteger(value: unknown, fallback: number) {
  return Math.max(1, Math.round(sanitizeNonNegativeNumber(value, fallback)));
}

function sanitizeFormula(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function normalizeFormulaExpression(expression: string) {
  return expression
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/\b[xX]\b/g, "*")
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "($1 / 100)");
}

function tokenizeFormula(expression: string): FormulaToken[] | null {
  const tokens: FormulaToken[] = [];
  const normalized = normalizeFormulaExpression(expression);
  let index = 0;

  while (index < normalized.length) {
    const character = normalized[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(character)) {
      let end = index + 1;
      while (end < normalized.length && /[0-9.]/.test(normalized[end])) {
        end += 1;
      }

      const value = Number.parseFloat(normalized.slice(index, end));
      if (!Number.isFinite(value)) {
        return null;
      }

      tokens.push({ type: "number", value });
      index = end;
      continue;
    }

    if (/[A-Za-z]/.test(character)) {
      let end = index + 1;
      while (end < normalized.length && /[A-Za-z]/.test(normalized[end])) {
        end += 1;
      }

      const rawIdentifier = normalized.slice(index, end).toLowerCase();
      const identifier =
        rawIdentifier === "alvl"
          ? "Alvl"
          : rawIdentifier === "blvl"
            ? "Blvl"
            : null;

      if (!identifier) {
        return null;
      }

      tokens.push({ type: "identifier", value: identifier });
      index = end;
      continue;
    }

    if (character === "+" || character === "-" || character === "*" || character === "/" || character === "(" || character === ")") {
      tokens.push({ type: "operator", value: character });
      index += 1;
      continue;
    }

    return null;
  }

  return tokens;
}

function evaluateTokens(tokens: FormulaToken[], variables: FormulaVariables) {
  let index = 0;

  const parseExpression = (): number | null => {
    let value = parseTerm();
    if (value === null) {
      return null;
    }

    while (index < tokens.length) {
      const operator = tokens[index];
      if (operator.type !== "operator" || (operator.value !== "+" && operator.value !== "-")) {
        break;
      }

      index += 1;
      const nextValue = parseTerm();
      if (nextValue === null) {
        return null;
      }

      value = operator.value === "+" ? value + nextValue : value - nextValue;
    }

    return value;
  };

  const parseTerm = (): number | null => {
    let value = parseFactor();
    if (value === null) {
      return null;
    }

    while (index < tokens.length) {
      const operator = tokens[index];
      if (operator.type !== "operator" || (operator.value !== "*" && operator.value !== "/")) {
        break;
      }

      index += 1;
      const nextValue = parseFactor();
      if (nextValue === null) {
        return null;
      }

      if (operator.value === "*") {
        value *= nextValue;
        continue;
      }

      if (nextValue === 0) {
        return null;
      }

      value /= nextValue;
    }

    return value;
  };

  const parseFactor = (): number | null => {
    const token = tokens[index];
    if (!token) {
      return null;
    }

    if (token.type === "operator" && (token.value === "+" || token.value === "-")) {
      index += 1;
      const value = parseFactor();
      if (value === null) {
        return null;
      }
      return token.value === "-" ? -value : value;
    }

    if (token.type === "number") {
      index += 1;
      return token.value;
    }

    if (token.type === "identifier") {
      index += 1;
      return variables[token.value];
    }

    if (token.type === "operator" && token.value === "(") {
      index += 1;
      const value = parseExpression();
      const closingToken = tokens[index];
      if (value === null || !closingToken || closingToken.type !== "operator" || closingToken.value !== ")") {
        return null;
      }
      index += 1;
      return value;
    }

    return null;
  };

  const value = parseExpression();
  if (value === null || index !== tokens.length || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

export function evaluateLevelingFormula(formula: string, variables: FormulaVariables) {
  const tokens = tokenizeFormula(formula);
  if (!tokens) {
    return null;
  }

  return evaluateTokens(tokens, {
    Alvl: clampLevel(variables.Alvl),
    Blvl: clampLevel(variables.Blvl)
  });
}

export function sanitizeLevelingCurveConfig(value: unknown): LevelingCurveConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_LEVELING_CURVE_CONFIG;
  }

  const candidate = value as Partial<LevelingCurveConfig>;

  return {
    startExpForNextLevel: sanitizePositiveInteger(
      candidate.startExpForNextLevel,
      DEFAULT_LEVELING_CURVE_CONFIG.startExpForNextLevel
    ),
    expGainedPerBattle: Math.round(
      sanitizeNonNegativeNumber(
        candidate.expGainedPerBattle,
        DEFAULT_LEVELING_CURVE_CONFIG.expGainedPerBattle
      )
    ),
    bonusDefeatingHigherLevelFormula: sanitizeFormula(
      candidate.bonusDefeatingHigherLevelFormula,
      DEFAULT_LEVELING_CURVE_CONFIG.bonusDefeatingHigherLevelFormula
    ),
    debonusDefeatingLowerLevelFormula: sanitizeFormula(
      candidate.debonusDefeatingLowerLevelFormula,
      DEFAULT_LEVELING_CURVE_CONFIG.debonusDefeatingLowerLevelFormula
    ),
    percentageExpIncreaseNextLevel: sanitizeNonNegativeNumber(
      candidate.percentageExpIncreaseNextLevel,
      DEFAULT_LEVELING_CURVE_CONFIG.percentageExpIncreaseNextLevel
    )
  };
}

export function getExperienceForNextLevel(level: number, config: LevelingCurveConfig) {
  const clampedLevel = clampLevel(level);
  if (clampedLevel >= 100) {
    return 0;
  }

  let required = sanitizePositiveInteger(
    config.startExpForNextLevel,
    DEFAULT_LEVELING_CURVE_CONFIG.startExpForNextLevel
  );

  for (let currentLevel = 1; currentLevel < clampedLevel; currentLevel += 1) {
    required = Math.max(
      1,
      Math.round(required * (1 + config.percentageExpIncreaseNextLevel / 100))
    );
  }

  return required;
}

export function computeBattleExperience(
  config: LevelingCurveConfig,
  attackerLevel: number,
  foeLevel: number
) {
  const Alvl = clampLevel(attackerLevel);
  const Blvl = clampLevel(foeLevel);
  let modifier = 0;

  if (Blvl > Alvl) {
    modifier += evaluateLevelingFormula(config.bonusDefeatingHigherLevelFormula, { Alvl, Blvl }) ?? 0;
  } else if (Alvl > Blvl) {
    modifier -= evaluateLevelingFormula(config.debonusDefeatingLowerLevelFormula, { Alvl, Blvl }) ?? 0;
  }

  return Math.max(0, Math.round(config.expGainedPerBattle * (1 + modifier)));
}

export function sanitizePokemonStatBonuses(value: unknown): PokemonStatBonuses {
  if (!value || typeof value !== "object") {
    return createEmptyPokemonStatBonuses();
  }

  const candidate = value as Partial<PokemonStatBonuses>;
  return {
    hp: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.hp, 0))),
    attack: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.attack, 0))),
    defense: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.defense, 0))),
    specialAttack: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.specialAttack, 0))),
    specialDefense: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.specialDefense, 0))),
    speed: Math.max(0, Math.round(sanitizeNonNegativeNumber(candidate.speed, 0)))
  };
}

function extractConfigFromItem(item: DesignerSectionItem | null | undefined) {
  return sanitizeLevelingCurveConfig(item?.levelingCurveProfile);
}

export function getLevelingCurveConfigFromItems(items: DesignerSectionItem[]) {
  return extractConfigFromItem(items[0]);
}

export async function readLevelingCurveConfigFromRedis(redis: RedisClientType) {
  const raw = await redis.get(LEVELING_CURVE_REDIS_KEY);
  if (!raw) {
    return DEFAULT_LEVELING_CURVE_CONFIG;
  }

  try {
    const parsed = JSON.parse(raw) as {
      state?: {
        items?: DesignerSectionItem[];
      };
    };

    return getLevelingCurveConfigFromItems(parsed?.state?.items ?? []);
  } catch (error) {
    console.error("Unable to parse stored leveling curve state:", error);
    return DEFAULT_LEVELING_CURVE_CONFIG;
  }
}
