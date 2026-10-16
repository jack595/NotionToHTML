#!/usr/bin/env bash
# Local desktop/WSL entry point. Output paths resolve against the caller's cwd.
set -euo pipefail
notion_tool_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
    echo 'Node.js is required. Install Node.js 20.19 or newer, then run bash install.sh.' >&2
    exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<20||(major===20&&minor<19)){console.error("Node.js 20.19 or newer is required.");process.exit(1)}'
if [[ ! -f "$notion_tool_dir/node_modules/@modelcontextprotocol/sdk/package.json" || ! -f "$notion_tool_dir/node_modules/katex/package.json" ]]; then
    echo 'Dependencies are missing. Run the installer first:' >&2
    echo "bash \"$notion_tool_dir/install.sh\"" >&2
    exit 1
fi
exec node "$notion_tool_dir/Code/step4_cli/export_cli.mjs" "$@"
