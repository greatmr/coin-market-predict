#!/usr/bin/env bash
# MCP stdio launcher for local hosts (Claude Code / Claude Desktop), used by .mcp.json.
# stdout carries the MCP protocol only, so every other message goes to stderr.
# The app needs Node >= 22.12; when nvm is installed the version comes from .nvmrc, because a
# system Node 20 cannot run it (unknown --env-file-if-exists flag, Prisma 7 engine check).
cd "$(dirname "$0")/.." || exit 1
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ -s "$NVM_SH" ]; then
  # shellcheck disable=SC1090
  . "$NVM_SH" >&2
  nvm use --silent >&2 || echo "mcp-stdio: nvm could not select the .nvmrc version; using $(node --version)" >&2
fi
if [ ! -f dist/mcp-stdio.js ]; then
  echo "mcp-stdio: dist/mcp-stdio.js is missing; run npm run build first" >&2
  exit 1
fi
exec node --env-file-if-exists=.env dist/mcp-stdio.js "$@"
