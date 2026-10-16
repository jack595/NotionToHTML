# NotionToHTML

Export a Notion page share link to one interactive, self-contained HTML file.
Recipients open that file in a browser without a network connection, Node.js,
or a Notion account. The reader supports page navigation, full-text search,
saved table views, combined filters, sorting, column visibility, page previews,
formula rendering, and image zoom. It is a read-only snapshot.

## Install once

Use a local **macOS, Windows (WSL), or Linux desktop** with Bash, a browser, and
[Node.js 20.19 or newer with npm](https://nodejs.org/en/download).
SSH-only and headless sign-in are not supported. On Windows, install Node.js
inside WSL and run these commands in a WSL terminal.

Clone this repository, then install its dependencies:

```bash
git clone https://github.com/jack595/NotionToHTML.git
cd NotionToHTML
bash install.sh
```

If you already have a release ZIP, unzip it and run `bash install.sh` inside the
extracted directory instead.

The installer uses the pinned lockfile and installs dependencies in this tool's
directory. Installation and export require an internet connection. Reading the
resulting HTML does not.

### macOS Terminal

The current scripts and production dependencies are expected to work on macOS
based on code and dependency review. Browser sign-in uses the
[`open` package](https://github.com/sindresorhus/open#api), which supports macOS
through its system `open` command. **This project has not yet been tested on a
Mac.**

Install [Node.js 20.19 or newer with npm](https://nodejs.org/en/download), then
run the following in Terminal, replacing `NOTION_PAGE_SHARE_LINK` with your page
link:

```bash
git clone https://github.com/jack595/NotionToHTML.git
cd NotionToHTML
bash install.sh
bash notion-export.sh 'NOTION_PAGE_SHARE_LINK' --output "$HOME/Downloads/notion.html"
```

Invoke the scripts with `bash` as shown, including when your Terminal uses zsh.
The first export opens your default browser for Notion authorization. Later
exports reuse the saved login. Open the generated HTML in a browser to read and
share it offline.

## Export

Copy a page link using Notion's **Copy link** action and keep it quoted:

```bash
./notion-export.sh 'https://www.notion.so/Your-page-0123456789abcdef0123456789abcdef'
```

The first export opens Notion in your browser. Sign into your own account and
select the workspace containing the page. The exporter uses the official remote
Notion MCP service and browser OAuth; it does not require ChatGPT, Codex, an
integration token, or another person's login. Private pages must be readable by
the account you authorize. A share link alone does not grant access.

The command prints the absolute HTML filename to standard output. Progress and
diagnostics go to standard error. By default, the output is placed in the current
working directory with a title and timestamp. To choose a destination:

```bash
./notion-export.sh 'NOTION_PAGE_SHARE_LINK' --output "$HOME/Exports/研究报告.html"
```

Parent directories are created as needed. Existing HTML or report files are
never overwritten. The tool also creates an adjacent `.report.json` file with
content counts, a SHA-256 checksum, missing-content details, and a completeness
flag. **Share only the HTML**; the report is optional.

Other commands:

```bash
./notion-export.sh --login     # Authorize again, or switch accounts/workspaces
./notion-export.sh --logout    # Remove this local user's saved login
./notion-export.sh --help
```

## Export scope

- Follows child pages, embedded/linked databases, and record pages underneath the
  supplied root page. Ordinary hyperlinks and page mentions do not expand scope.
- Captures every existing saved view and all rows returned by that view, including
  pagination beyond 100 rows. Rows hidden from every saved view are excluded.
  Shared data sources are deduplicated while each view keeps its own row order.
- Preserves text, task states, properties, formulas, and the bytes of downloadable
  images and attachments. URLs for uploaded files are refreshed when needed.
  Files mentioned only as text paths are not downloaded.
- Table views are supported. Other view layouts are presented as tables and
  flagged in the report. Unsupported blocks, unavailable pages, missing media,
  and truncated responses make the result incomplete.
- Supply a root **page** containing any databases; standalone database links are
  not supported. Comments, database templates, edit controls, collaboration, and
  live external embeds are outside this page-content snapshot.

Exit status is `0` for a complete export, `1` for a failed or incomplete export,
`2` for invalid arguments, and `130` for cancellation. An incomplete export may
still produce a useful HTML file; inspect **About this copy** and its report
before sharing. Updated Notion content requires another export.

## Login and local data

Each local user has a separate login under
`${XDG_CONFIG_HOME:-$HOME/.config}/notion-offline-exporter/`. The directory is
created with mode `0700`, and the credential file with mode `0600`. Keep this
directory private. One process at a time may use it so rotating refresh tokens
cannot race. `--logout` removes the saved local credentials; it does not revoke
the connection in Notion.

Temporary page captures and media caches are removed after export or handled
cancellation. OAuth tokens and temporary attachment download URLs are excluded
from the generated HTML. The release ZIP contains code and installation files;
it contains no account credentials, captures, or exported documents.

The HTML embeds CSS, JavaScript, data, fonts, and downloaded media. It makes no
network requests when opened. Content is sanitized and a Content Security Policy
blocks network connections. Original Notion links remain available for deliberate
online navigation. KaTeX/font license notices are retained in the HTML; build
dependency licenses remain in their installed packages.

## Troubleshooting

- **No browser opens:** copy the printed authorization URL into a browser on the
  same computer. Keep the terminal running until the callback completes. Sign-in
  times out after ten minutes; retry with `--login`.
- **Login or workspace changed:** run `--login` and select the intended workspace.
  Use `--logout` first if a saved registration cannot be recovered.
- **Permission error:** confirm the selected account can open the supplied page
  and its child pages in Notion.
- **Network or rate-limit error:** retry later. Standard `HTTP_PROXY`,
  `HTTPS_PROXY`, and `NO_PROXY` environment variables are supported. Read requests
  have bounded retries; OAuth refresh-token POSTs are never blindly replayed.
- **Another exporter is running:** wait for it to finish. The lock is per local
  login, not a restriction on sharing the software with other users.

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run package
```

Tests use synthetic content and isolated loopback servers. They cover PKCE,
token reuse/rotation, cancelled authorization, per-user storage, 205-row
pagination, shared sources, URL refresh, output conflicts, and incomplete copies.
The packaging command writes an explicitly allowlisted ZIP under `dist/`.

`Code/step1_capture/` captures content and media, `Code/step2_build/` contains the
offline reader, `Code/step4_cli/` implements OAuth and the CLI, and
`Code/step5_package/` builds releases. Private snapshots, generated HTML, browser
caches, validation products, credentials, and dependency directories are ignored
by Git and excluded from release packages.

For the existing study regression fixture, the browser validator accepts a local
HTML path: `npm run validate -- /path/to/regression.html`. It exercises navigation,
view order, filters, sorting, search, previews, zoom, and a mobile viewport in
Chromium and Firefox with network access disabled. Set `CHROMIUM_PATH` and/or
`FIREFOX_PATH` to reuse installed compatible browsers.
