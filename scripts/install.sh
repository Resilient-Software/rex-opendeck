#!/bin/sh
# Build the plugin bundle and install it into OpenDeck's plugins directory.
# OpenDeck runs Node.js plugins with the system Node (24+ required).
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
uuid="com.resilientsoftware.rexdeck.sdPlugin"

case "$(uname -s)" in
	Darwin) plugins_dir="$HOME/Library/Application Support/opendeck/plugins" ;;
	Linux) plugins_dir="${XDG_DATA_HOME:-$HOME/.local/share}/opendeck/plugins" ;;
	*) echo "unsupported platform" >&2; exit 1 ;;
esac

(cd "$repo" && npm install --no-audit --no-fund --silent && npm run --silent build)

target="$plugins_dir/$uuid"
mkdir -p "$target"
cp -R "$repo/plugin/manifest.json" "$repo/plugin/icons" "$repo/plugin/bin" "$repo/plugin/ui" "$target/"

# Record where rex lives, since the host may run with a minimal PATH; the
# plugin also probes the official install locations and ps on its own.
rm -f "$target/rex-path.txt"
command -v rex > "$target/rex-path.txt" 2>/dev/null || rm -f "$target/rex-path.txt"

echo "installed to $target"
echo "restart OpenDeck (or reload plugins) to pick it up"
