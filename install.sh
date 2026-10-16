#!/usr/bin/env bash
# Local desktop/WSL setup. Installs dependencies only inside this tool directory.
set -euo pipefail
notion_tool_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo 'Install Node.js 20.19 or newer (including npm), then run this script again.' >&2
    echo 'https://nodejs.org/en/download' >&2
    exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<20||(major===20&&minor<19)){console.error("Node.js 20.19 or newer is required.");process.exit(1)}'
cd -- "$notion_tool_dir"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chmod +x -- "$notion_tool_dir/notion-export.sh"
echo 'Installed. Export a page with:' >&2
echo './notion-export.sh '\''NOTION_PAGE_SHARE_LINK'\''' >&2
