#!/bin/sh
# Deploy the stack: upload compose.yaml, (re)create changed containers, apply the DB schema.
# The .env file lives only on the server and is never uploaded from here.
# Usage: scripts/deploy.sh [--seed]   (override with DEPLOY_HOST / DEPLOY_DIR / DEPLOY_PROJECT)
#   --seed  also load demo data from db/seed.sql
set -eu

HOST=${DEPLOY_HOST:-nas}
DIR=${DEPLOY_DIR:-/volume1/docker/n8n}
PROJECT=${DEPLOY_PROJECT:-n8n}
# Synology keeps docker outside the non-interactive PATH and requires root.
DOCKER=${DEPLOY_DOCKER:-sudo /usr/local/bin/docker}

SQL_FILES="db/schema.sql"
[ "${1:-}" = "--seed" ] && SQL_FILES="$SQL_FILES db/seed.sql"

cd "$(dirname "$0")/.."

# Container Manager keeps the uploaded file under its original name, compose.yaml.
# Plain ssh instead of scp: DSM has no SFTP subsystem unless it is enabled separately.
ssh "$HOST" "cat > '$DIR/compose.yaml'" < compose.yaml
ssh "$HOST" "mkdir -p '$DIR/db'"
for f in $SQL_FILES; do
    ssh "$HOST" "cat > '$DIR/$f'" < "$f"
done

COMPOSE="$DOCKER compose -p '$PROJECT' -f compose.yaml"
PSQL="$COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -q -U n8n -d n8n"

REMOTE="cd '$DIR' && $COMPOSE up -d --remove-orphans"
REMOTE="$REMOTE && $COMPOSE exec -T postgres sh -c 'until pg_isready -q -U n8n -d n8n; do sleep 1; done'"
for f in $SQL_FILES; do
    REMOTE="$REMOTE && $PSQL < '$f'"
done
REMOTE="$REMOTE && $COMPOSE ps"

# -t: sudo needs a terminal to ask for the password.
ssh -t "$HOST" "$REMOTE"
