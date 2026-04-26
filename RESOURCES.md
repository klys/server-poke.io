# Server Resource Requirements

This document records the local resource measurements for the Socket.IO backend and gives practical sizing guidance for development and small production deployments.

Measurements were taken on 2026-04-18 from this repository on:

- OS: Linux 6.17.0-20-generic x86_64
- CPU threads visible: 16
- RAM: 38 GiB total
- Node.js: v22.15.1
- Redis: local Redis at `redis://127.0.0.1:6379`

These numbers are a baseline, not a full load test.

## Measured Footprint

| Area | Measurement |
| --- | ---: |
| Repository working tree | 59 MB |
| `node_modules` | 58 MB |
| Compiled `dist/` output | 176 KB |
| TypeScript backend source | 3,585 lines across `index.ts`, `components/`, and `Server/` |
| TypeScript build time | 6.14 seconds wall time |
| TypeScript build peak RSS | 437,708 KB, about 428 MB |
| Redis memory currently used | 1.68 MB logical, 21.48 MB RSS |

## Runtime Measurements

Measured by running the built server with:

```bash
PORT=3901 node dist/index.js
```

The production port `3001` was already in use locally, so the sample used `3901`.

| Scenario | Server RSS | Notes |
| --- | ---: | --- |
| Existing local server after several minutes | about 83 MB | `node dist/index.js` on port `3001` |
| Fresh built server after startup | about 114 MB | Redis connected, mail initialized from `.env` |
| 100 synthetic websocket clients after `addPlayer` | about 127 MB | Clients connected with `socket.io-client`, emitted `addPlayer`, then idled |

The 100-client sample increased RSS by about 13 MB over the fresh process, or roughly 130 KB per connected client in this specific run. Treat that as a rough lower-bound indicator only; V8 allocation, map state size, player count, movement traffic, and logging can change it.

## Recommended Sizing

### Local Development

- Node process: 1 CPU core, 512 MB RAM
- Redis: 128 MB RAM is enough for normal local auth/session/map data
- Disk: 250 MB free for this repo, dependencies, and compiled output
- Better developer comfort: 2 CPU cores and 1 GB RAM available to the backend while building

### Small Production / Private Testing

For a small multiplayer test server:

- App container/VM: 1 vCPU, 512 MB RAM minimum
- Safer app allocation: 1 vCPU, 1 GB RAM
- Redis: 256 MB RAM minimum
- Disk: 1 GB minimum for app files, logs, and Redis persistence

### More Comfortable Shared Deployment

For join bursts, map editing, auth email flows, and gameplay at the same time:

- App container/VM: 2 vCPU, 2 GB RAM
- Redis: 512 MB RAM
- Disk: 5 GB, mostly for logs and Redis persistence

## Scaling Notes

- The server is single-process Node.js. One CPU core executes JavaScript at a time, although Redis, networking, and some Node internals use the OS efficiently.
- Socket.IO connection count primarily consumes memory and network bandwidth.
- Player movement and projectile updates increase CPU and outbound socket traffic.
- Projectiles are processed every 100 ms in `components/world.ts`.
- Respawn waiting is processed every 1 second in `components/world.ts`.
- Pathfinding cost depends on map dimensions, obstacle density, and move frequency.
- Map, object, auth session, and token state live in Redis; active players and projectiles live in process memory.

## Current Hot Spots

- `presentPlayersTo` sends each joining player all existing players. For a burst of `N` players joining the same map, this creates roughly `N * (N - 1) / 2` player presentation events.
- The 100-client synthetic join produced a large amount of console output because connection, add-player, and player presentation paths are verbose.
- Production deployments should reduce noisy `console.log` calls before serious load testing, because logging can become a CPU and I/O bottleneck.

## Practical Capacity Estimate

With the current code and verbose logging still enabled:

- 10-50 connected players should fit comfortably in a 512 MB app allocation.
- 50-150 connected players should use at least 1 GB app RAM, especially if players join in bursts.
- Above 150 players, run a real load test with representative movement, projectiles, map transitions, and Redis persistence before choosing capacity.

For production, monitor at least:

- App RSS memory
- Event loop delay
- CPU percent
- Socket.IO connected clients
- Outbound network bandwidth
- Redis used memory and operation latency
- Log volume

## Re-Measurement Commands

```bash
npm run build
/usr/bin/time -v npm run build
du -sh . node_modules dist components Server emails
PORT=3901 node dist/index.js
ps -o pid,rss,vsz,pcpu,pmem,etime,cmd -p <server-pid>
```

Redis memory can be checked through the Node dependency:

```bash
node -e "const {createClient}=require('redis'); const client=createClient({url:process.env.REDIS_URL||'redis://127.0.0.1:6379'}); client.connect().then(()=>client.info('memory')).then(info=>{console.log(info.split('\n').filter(l=>/^used_memory_human:|^used_memory_rss_human:|^maxmemory_human:/.test(l)).join('\n')); return client.quit();}).catch(e=>{console.error(e.message); process.exitCode=1;});"
```
