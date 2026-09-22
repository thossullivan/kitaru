#!/usr/bin/env bash

set -euo pipefail

example_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_args=()
if [[ -f "${example_dir}/.env" ]]; then
  env_args=(--env-file "${example_dir}/.env")
fi

cd "${example_dir}"
uv run --project "${example_dir}" "${env_args[@]}" \
  python -m returns_operations_agent.generate_traces "$@"
