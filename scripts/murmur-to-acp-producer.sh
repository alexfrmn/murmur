#!/usr/bin/env bash
set -euo pipefail

exec /usr/bin/env python3 "${MURMUR_HOME:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/murmur-to-acp-producer.py" "$@"
