#!/bin/sh
# Run a SQL statement against the server database.
# Usage: scripts/sql.sh "SELECT id, duplicate, locked_at FROM leadgen.orders ORDER BY id"
set -eu

HOST=${DEPLOY_HOST:-nas}
DIR=${DEPLOY_DIR:-/volume1/docker/n8n}
PROJECT=${DEPLOY_PROJECT:-n8n}
DOCKER=${DEPLOY_DOCKER:-sudo /usr/local/bin/docker}

# base64 keeps quotes in the statement intact through both shells.
SQL=$(printf '%s' "${1:?usage: scripts/sql.sh \"SQL\"}" | base64 | tr -d '\n')

# -t: sudo needs a terminal to ask for the password.
ssh -t "$HOST" "cd '$DIR' && echo '$SQL' | base64 -d | $DOCKER compose -p '$PROJECT' -f compose.yaml exec -T postgres psql -U n8n -d n8n"
