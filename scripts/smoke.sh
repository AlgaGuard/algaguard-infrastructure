#!/usr/bin/env sh
set -eu
docker compose --env-file .env.example up -d timescaledb redis minio prometheus loki tempo
docker compose --env-file .env.example ps --status running
docker compose --env-file .env.example down
