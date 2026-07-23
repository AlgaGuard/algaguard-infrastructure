#!/usr/bin/env sh
set -eu

# Compatibility entrypoint. The pre-authentication vertical slice was replaced
# by the production device credential proof.
exec sh scripts/credential-e2e.sh
