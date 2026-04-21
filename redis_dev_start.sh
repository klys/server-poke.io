#!/bin/bash
# Script to start a local Redis instance for development using Docker with persistence

CONTAINER_NAME="redis-dev"
PORT="6379"

# Resolve script directory (so it's always relative to this file)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"

echo "Starting Redis Docker container ($CONTAINER_NAME) on port $PORT..."

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Remove existing container if it exists to avoid conflicts
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Removing existing container..."
    docker rm -f $CONTAINER_NAME
fi

# Run Redis with persistence (AOF enabled) and mounted volume
docker run -d \
    --name $CONTAINER_NAME \
    -p $PORT:6379 \
    -v "$DATA_DIR:/data" \
    redis:alpine \
    redis-server --appendonly yes

echo "Redis is now running on localhost:$PORT"
echo "Data is persisted in: $DATA_DIR"