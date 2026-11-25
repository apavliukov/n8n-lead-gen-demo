#!/bin/sh
# Local test stand (compose.test.yaml): a throwaway n8n with the workflows from workflows/,
# where HubSpot, Meta, TypeSafe and Telegram are replaced by tests/stub/server.mjs and mail goes to Mailpit.
# Usage: scripts/stand.sh up | test [node --test options] | down
#   up    start the stand from scratch: schema, seed, credentials, workflows, publish
#   test  run the e2e suite against the stand
#   down  remove the stand with its data
# n8n: http://localhost:5680, Mailpit: http://localhost:8026, stub log: http://localhost:8090/__requests
set -eu

cd "$(dirname "$0")/.."
dc() { docker compose -f compose.test.yaml "$@"; }
wait_n8n() {
    for _ in $(seq 60); do
        curl -sf -o /dev/null http://localhost:5680/healthz && return
        sleep 2
    done
    echo "n8n did not become ready" >&2
    exit 1
}

case "${1:-}" in
up)
    dc down -v
    dc up -d --wait postgres mailpit stub
    cat db/schema.sql db/seed.sql | dc exec -T postgres psql -q -U n8n -d n8n -v ON_ERROR_STOP=1 >/dev/null
    dc up -d n8n
    wait_n8n

    # The exports go in unchanged except for the provider hosts, which point at the stub.
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    mkdir "$tmp/workflows"
    for file in workflows/*.json; do
        sed -e 's#https://api.hubapi.com#http://stub:8080#g' \
            -e 's#https://graph.facebook.com#http://stub:8080#g' \
            -e 's#https://api.typesafe.ai#http://stub:8080#g' "$file" > "$tmp/$file"
    done
    jq 'map(.data |= with_entries(select(.value == "REPLACE_ME").value = "test"))
        | map(select(.type == "telegramApi").data.baseUrl = "http://stub:8080")' \
        credentials.example.json > "$tmp/credentials.json"
    # Everything except the manually started setup workflow gets published. n8n refuses to
    # publish a workflow before the sub-workflows it calls, so those go first, callees before callers.
    ids=$(jq -rs 'map(select(.name != "HubSpot setup"))
        | sort_by([
            (any(.nodes[]; .type == "n8n-nodes-base.executeWorkflowTrigger") | not),
            ([.nodes[] | select(.type == "n8n-nodes-base.executeWorkflow")] | length)
          ])
        | .[].id' workflows/*.json | tr '\n' ' ')

    tar -c -C "$tmp" . | dc exec -T n8n sh -c "mkdir -p /tmp/import && tar -x -C /tmp/import \
        && n8n import:credentials --input=/tmp/import/credentials.json \
        && n8n import:workflow --separate --input=/tmp/import/workflows \
        && for id in $ids; do n8n publish:workflow --id=\$id || exit 1; done"
    # Published workflows register their webhooks and schedules on start.
    dc restart n8n
    wait_n8n
    # healthz answers before the webhooks are registered: wait until the intake stops returning 404.
    until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' http://localhost:5680/webhook/orders)" != 404 ]; do
        sleep 1
    done
    echo "stand is up: http://localhost:5680"
    ;;
test)
    shift
    N8N_URL=http://localhost:5680 STUB_URL=http://localhost:8090 MAILPIT_URL=http://localhost:8026 \
        exec scripts/test.sh e2e "$@"
    ;;
down)
    dc down -v
    ;;
*)
    echo "usage: scripts/stand.sh up|test|down" >&2
    exit 1
    ;;
esac
