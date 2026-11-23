#!/bin/sh
# Send a test order to the intake webhook. Every call gets a fresh idempotency key,
# email (@autotest.invalid) and phone, so nothing has to be edited by hand.
# Usage: scripts/order.sh [-t] [-r] [-f fixture] [field=value ...]
#   -t          use the test URL (/webhook-test), while "Listen for test event" is on in the editor
#   -r          replay the previous request unchanged (same idempotency key)
#   -f fixture  base payload from test-payloads/ without .json (default: valid-new)
#   field=value overrides, e.g. email=verified@example.com product_id=dsl-100 birth_date=01.01.2015
set -eu

cd "$(dirname "$0")/.."
. ./.env
: "${N8N_URL:?set N8N_URL in .env}"

path=webhook fixture=valid-new replay=
last=${TMPDIR:-/tmp}/lead-gen-last-order.json
while getopts trf: opt; do
    case $opt in
        t) path=webhook-test ;;
        r) replay=1 ;;
        f) fixture=$OPTARG ;;
        *) exit 2 ;;
    esac
done
shift $((OPTIND - 1))

if [ -n "$replay" ]; then
    payload=$(cat "$last")
else
    uuid() { cat /proc/sys/kernel/random/uuid; }
    payload=$(jq --arg key "$(uuid)" --arg email "$(uuid)@autotest.invalid" \
        --arg phone "+49151$(od -An -N4 -tu4 /dev/urandom | tr -d ' ' | cut -c1-8)" \
        '.idempotency_key = $key | .email = $email | .phone = $phone' "test-payloads/$fixture.json")
    for pair in "$@"; do
        payload=$(printf '%s' "$payload" | jq --arg k "${pair%%=*}" --arg v "${pair#*=}" '.[$k] = $v')
    done
    printf '%s' "$payload" > "$last"
fi

printf '%s' "$payload" | jq -c '{idempotency_key, email, phone, product_id}' >&2
printf '%s' "$payload" | curl -sS -X POST "${N8N_URL%/}/$path/orders" -H 'Content-Type: application/json' -d @- | jq .
