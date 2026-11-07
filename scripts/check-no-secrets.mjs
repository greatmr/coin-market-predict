#!/usr/bin/env node
// Fails if files that would be committed or copied into an image contain credential-shaped
// strings. Prints only file paths and pattern names, never the matched values.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

const PATTERNS = {
  "claude oauth/api key": /sk-ant-[A-Za-z0-9_-]{20,}/,
  "telegram bot token": /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,
  "generic assignment": /^(CLAUDE_CODE_OAUTH_TOKEN|TELEGRAM_BOT_TOKEN|CMC_API_KEY|COINGECKO_API_KEY|MCP_READ_TOKEN|MCP_WRITE_TOKEN)=\S+/m,
};

const SKIP = /^(node_modules|dist|var|backups|secrets|coverage|\.git)(\/|$)|(^|\/)\.env(?!\.example$)[^/]*$/;

function walk(dir = ".", out = []) {
  for (const name of readdirSync(dir)) {
    const p = dir === "." ? name : `${dir}/${name}`;
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
} catch {
  // Not a git repository: scan everything that is not ignored by .gitignore / .dockerignore rules.
  files = walk();
}

let bad = 0;
for (const f of files) {
  try {
    if (statSync(f).size > 2_000_000) continue;
    const text = readFileSync(f, "utf8");
    for (const [name, re] of Object.entries(PATTERNS)) {
      if (re.test(text)) {
        process.stdout.write(`possible secret (${name}) in ${f}\n`);
        bad++;
      }
    }
  } catch {
    // unreadable/binary
  }
}
if (bad) process.exit(1);
process.stdout.write(`checked ${files.length} files: no credential-shaped strings\n`);
