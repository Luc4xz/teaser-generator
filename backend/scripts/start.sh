#!/usr/bin/env sh
set -eu
# Run from the repository root, regardless of the hosting service's working directory.
cd "$(dirname "$0")/../.."
# Jobs are held in process memory; all polling requests must reach this worker.
exec python -m uvicorn backend.app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
