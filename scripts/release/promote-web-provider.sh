#!/usr/bin/env bash
set -euo pipefail

# This boundary intentionally supports no provider until an adapter is reviewed and configured.
echo "::error::No web hosting provider adapter is configured; promotion is fail-closed."
exit 78
