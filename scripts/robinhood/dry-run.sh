#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DRY_RUN=1 bash "$ROOT_DIR/scripts/robinhood/deploy.sh"
