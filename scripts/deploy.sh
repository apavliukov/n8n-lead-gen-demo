#!/bin/sh
# Deploy the stack: upload compose.yaml and (re)create changed containers.
# The .env file lives only on the server and is never uploaded from here.
# Usage: scripts/deploy.sh   (override with DEPLOY_HOST / DEPLOY_DIR / DEPLOY_PROJECT)
set -eu

HOST=${DEPLOY_HOST:-nas}
DIR=${DEPLOY_DIR:-/volume1/docker/n8n}
PROJECT=${DEPLOY_PROJECT:-n8n}
# Synology keeps docker outside the non-interactive PATH and requires root.
DOCKER=${DEPLOY_DOCKER:-sudo /usr/local/bin/docker}

cd "$(dirname "$0")/.."

# Container Manager expects the file to be named docker-compose.yml.
# Plain ssh instead of scp: DSM has no SFTP subsystem unless it is enabled separately.
ssh "$HOST" "cat > '$DIR/docker-compose.yml'" < compose.yaml

ssh -t "$HOST" "cd '$DIR' && $DOCKER compose -p '$PROJECT' -f docker-compose.yml up -d --remove-orphans && $DOCKER compose -p '$PROJECT' -f docker-compose.yml ps"
