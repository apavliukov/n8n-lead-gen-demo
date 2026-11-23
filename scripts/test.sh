#!/bin/sh
# Run a test suite: "unit" (default, offline) or "e2e" (calls the n8n instance from .env).
# Usage: scripts/test.sh [unit|e2e] [node --test options]
#   unit - Code nodes from the exported workflows, fed with canned inputs
#   e2e  - real requests to the production webhook; the workflows must be published
set -eu

cd "$(dirname "$0")/.."
suite=${1:-unit}
[ $# -gt 0 ] && shift
# --use-system-ca: trust a locally installed CA (mkcert) like curl does.
exec node --env-file-if-exists=.env --use-system-ca --test "$@" tests/"$suite"/*.test.mjs
