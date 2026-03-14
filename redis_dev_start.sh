#!/bin/bash
# Script to start a local Redis instance for development using Docker

CONTAINER_NAME="redis-dev"
PORT="6379"

echo "Starting Redis Docker container ($CONTAINER_NAME) on port $PORT..."

# Remove existing container if it exists to avoid conflicts
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Removing existing container..."
    docker rm -f $CONTAINER_NAME
fi

# Run the new Redis container in detached mode
docker run -d --name $CONTAINER_NAME -p $PORT:6379 redis:alpine

echo "Redis is now running on localhost:$PORT"