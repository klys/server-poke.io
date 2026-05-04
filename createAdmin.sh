#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo ".env file not found at $ENV_FILE" >&2
    exit 1
fi

read -r -p "Admin username: " ADMIN_USERNAME
if [[ -z "${ADMIN_USERNAME// }" ]]; then
    echo "Username is required." >&2
    exit 1
fi

read -r -s -p "Admin password: " ADMIN_PASSWORD
echo
if [[ -z "$ADMIN_PASSWORD" ]]; then
    echo "Password is required." >&2
    exit 1
fi

read -r -s -p "Confirm password: " ADMIN_PASSWORD_CONFIRM
echo
if [[ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]]; then
    echo "Passwords do not match." >&2
    exit 1
fi

export REPO_ROOT="$SCRIPT_DIR"
export ADMIN_USERNAME
export ADMIN_PASSWORD

node <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

const DEFAULT_ROLE_DEFINITIONS = [
    {
        key: "admin",
        name: "Admin",
        description: "Full access to every admin, moderator, designer, and gameplay capability.",
        permissions: ["game.access", "designer.access", "moderator.access", "admin.access"]
    },
    {
        key: "designer",
        name: "Designer",
        description: "Gameplay access plus the collaborative designer workspace.",
        permissions: ["game.access", "designer.access"]
    },
    {
        key: "moderator",
        name: "Moderator",
        description: "Gameplay access plus moderator oversight tools.",
        permissions: ["game.access", "moderator.access"]
    },
    {
        key: "user",
        name: "User",
        description: "Standard player access to the game world.",
        permissions: ["game.access"]
    }
];

function readEnvFile(filePath) {
    const parsed = {};
    const content = fs.readFileSync(filePath, "utf8");

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        let value = line.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        parsed[key] = value;
    }

    return parsed;
}

function validateUsername(username) {
    if (username.length < 4 || username.length > 30) {
        return "Username must be between 4 and 30 characters.";
    }

    if (!/^[A-Za-z0-9]+$/.test(username)) {
        return "Username may contain letters and numbers only.";
    }

    return null;
}

function validatePassword(password) {
    if (password.length < 8 || password.length > 150) {
        return "Password must be between 8 and 150 characters long.";
    }

    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
        return "Password must include upper, lower, number, and symbol characters.";
    }

    return null;
}

async function main() {
    const repoRoot = process.env.REPO_ROOT;
    const envPath = path.join(repoRoot, ".env");
    const env = readEnvFile(envPath);
    const redisUrl = env.REDIS_URL || "redis://127.0.0.1:6379";
    const passwordPepper = env.AUTH_PEPPER || "";
    const username = (process.env.ADMIN_USERNAME || "").trim();
    const password = process.env.ADMIN_PASSWORD || "";

    const usernameValidationError = validateUsername(username);
    if (usernameValidationError) {
        throw new Error(usernameValidationError);
    }

    const passwordValidationError = validatePassword(password);
    if (passwordValidationError) {
        throw new Error(passwordValidationError);
    }

    const normalizedUsername = username.toLowerCase();
    const usernameKey = `auth:index:username:${normalizedUsername}`;
    const userIdSequenceKey = "auth:user:id:sequence";
    const userKeyPrefix = "auth:user:";
    const rolesKey = "auth:roles";

    const client = createClient({ url: redisUrl });
    client.on("error", (error) => {
        console.error("Redis client error:", error.message);
    });

    await client.connect();

    try {
        await client.setNX(userIdSequenceKey, "0");
        await client.setNX(rolesKey, JSON.stringify(DEFAULT_ROLE_DEFINITIONS));

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await client.watch(usernameKey);

            const existingUserId = await client.get(usernameKey);
            if (existingUserId) {
                await client.unwatch();
                throw new Error(`Username "${username}" already exists.`);
            }

            const userId = await client.incr(userIdSequenceKey);
            const passwordSalt = crypto.randomBytes(16).toString("hex");
            const passwordHash = crypto.scryptSync(password + passwordPepper, passwordSalt, 64).toString("hex");
            const createdAt = new Date().toISOString();

            const transactionResult = await client.multi()
                .hSet(`${userKeyPrefix}${userId}`, {
                    id: String(userId),
                    name: "",
                    username,
                    email: "",
                    password_hash: passwordHash,
                    password_salt: passwordSalt,
                    email_verified: "0",
                    profile_image: "",
                    description: "",
                    inventory: "[]",
                    pokemon_party: "[]",
                    trainer_gender: "",
                    money: "0",
                    battle_history: "[]",
                    role: "admin",
                    created_at: createdAt
                })
                .set(usernameKey, String(userId))
                .exec();

            if (transactionResult) {
                console.log(`Admin user created with id ${userId} and username "${username}".`);
                return;
            }
        }

        throw new Error("Unable to create the admin user after multiple Redis transaction retries.");
    } finally {
        await client.quit();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
NODE
