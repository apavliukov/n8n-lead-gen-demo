#!/bin/sh
# Export all workflows from n8n into workflows/, one JSON file per workflow.
# Needs N8N_URL and N8N_API_KEY in the local .env (Settings -> n8n API in the n8n UI).
# Only the definition is kept: timestamps and pinned test data would add noise or leak data.
# The workflow id stays, because sub-workflow calls refer to each other by id.
set -eu

cd "$(dirname "$0")/.."
. ./.env
: "${N8N_URL:?set N8N_URL in .env}" "${N8N_API_KEY:?set N8N_API_KEY in .env}"

mkdir -p workflows
# ponytail: single page of 250 workflows, add cursor paging if the instance ever holds more
curl -fsS -H "X-N8N-API-KEY: $N8N_API_KEY" "${N8N_URL%/}/api/v1/workflows?limit=250" |
    jq -c '.data[] | {id, name, nodes, connections, settings}' |
    while IFS= read -r workflow; do
        file="workflows/$(printf '%s' "$workflow" | jq -r '.name | ascii_downcase | gsub("[^a-z0-9]+"; "-")').json"
        printf '%s' "$workflow" | jq . > "$file"
        echo "exported $file"
    done
