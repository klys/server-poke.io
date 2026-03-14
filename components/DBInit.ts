import { createClient, type RedisClientType } from "redis";

export default class DBInit {
    private readonly redis:RedisClientType;
    private readonly redisUrl:string;

    constructor(redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379") {
        this.redisUrl = redisUrl;
        this.redis = createClient({
            url: this.redisUrl,
            socket: {
                connectTimeout: 5000,
                reconnectStrategy: false
            }
        });
    }

    public async initialize() {
        this.redis.on("error", (error) => {
            console.error("Redis auth error:", error);
        });

        try {
            if (!this.redis.isOpen) {
                await this.redis.connect();
            }

            await this.redis.setNX("auth:meta:schema-version", "1");
            await this.redis.setNX("auth:meta:initialized-at", new Date().toISOString());
            await this.redis.setNX("auth:user:id:sequence", "0");

            return this.redis;
        } catch (error) {
            console.error("Redis connection failed:", error);
            throw new Error(`Unable to connect to Redis at ${this.redisUrl}`);
        }
    }
}
