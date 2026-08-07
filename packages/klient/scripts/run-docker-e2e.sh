#!/usr/bin/env bash
# kap-server was removed from the harness product line; docker e2e is no longer available.
set -euo pipefail

echo "kap-server docker e2e was removed with packages/kap-server." >&2
echo "Use: bun --filter @moonshot-ai/klient test (in-process transports)" >&2
exit 1
