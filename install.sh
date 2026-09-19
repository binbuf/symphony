#!/usr/bin/env bash
# Build symphony and drop it into <project>/.symphony/ (gitignored).
#   ./install.sh /path/to/project
set -euo pipefail
target="${1:?usage: install.sh <project-root>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$(cd "$target" && pwd)"
dest="$target/.symphony"

echo "building symphony in $here"
(cd "$here" && npm install --no-audit --no-fund --silent && npm run build --silent)

mkdir -p "$dest"
rm -rf "$dest/dist"
cp -R "$here/dist" "$dest/dist"
cp "$here/symphony" "$here/README.md" "$here/symphony.config.example.json" "$dest/"
chmod +x "$dest/symphony"
printf '{\n  "name": "symphony",\n  "type": "module",\n  "private": true\n}\n' > "$dest/package.json"
printf '*\n' > "$dest/.gitignore"
[ -f "$dest/symphony.config.json" ] || cp "$here/symphony.config.example.json" "$dest/symphony.config.json"

if ! grep -qxF '.symphony/' "$target/.gitignore" 2>/dev/null; then
  printf '\n# symphony harness (local tool, not tracked)\n.symphony/\n' >> "$target/.gitignore"
  echo "added .symphony/ to $target/.gitignore"
fi

echo "installed to $dest"
echo "next: cd $target && ./.symphony/symphony init && ./.symphony/symphony doctor"
