#!/bin/sh
# Import the workflows from workflows/ into the n8n instance on the server.
# Usage: scripts/import.sh [--credentials]
#   --credentials  also import credentials.json (copy credentials.example.json and fill in the secrets).
#                  Needed once on a fresh instance: workflows refer to credentials by the ids in that file.
# Imported workflows replace the server versions with the same id and come back unpublished:
# export first if the server has changes that are not in git, and publish them in the UI afterwards.
# The remote docker command must run without a password prompt (the payload goes through stdin).
set -eu

HOST=${DEPLOY_HOST:-nas}
DIR=${DEPLOY_DIR:-/volume1/docker/n8n}
PROJECT=${DEPLOY_PROJECT:-n8n}
DOCKER=${DEPLOY_DOCKER:-sudo /usr/local/bin/docker}

cd "$(dirname "$0")/.."
files=workflows
steps='n8n import:workflow --separate --input=/tmp/import/workflows'
if [ "${1:-}" = "--credentials" ]; then
    [ -f credentials.json ] || { echo "credentials.json not found" >&2; exit 1; }
    files="$files credentials.json"
    steps="n8n import:credentials --input=/tmp/import/credentials.json && $steps"
fi

# The files travel as a tar stream into the container and are removed right after the import.
# shellcheck disable=SC2086
tar -c $files | ssh "$HOST" "cd '$DIR' && $DOCKER compose -p '$PROJECT' -f compose.yaml exec -T n8n \
    sh -c 'rm -rf /tmp/import && mkdir /tmp/import && tar -x -C /tmp/import && $steps; status=\$?; rm -rf /tmp/import; exit \$status'"
