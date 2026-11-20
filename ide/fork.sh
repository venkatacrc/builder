#!/usr/bin/env bash
# Builder IDE: a Code-OSS fork with Builder built in and Copilot removed.
#
#   ide/fork.sh setup     clone the pinned VS Code tag, apply patches + branding, install deps, sync Builder
#   ide/fork.sh sync      rebuild the Builder extension and copy it into the fork as a built-in extension
#   ide/fork.sh dev       run the fork from source (first run compiles, ~10 min)
#   ide/fork.sh package   build the app: $BUILDER_IDE_HOME/VSCode-darwin-<arch>/Builder.app
#   ide/fork.sh install   copy the packaged app to /Applications
#   ide/fork.sh diff      save your edits to the checkout as ide/patches/0001-builder.patch
#
# The VS Code checkout lives outside this repo, in $BUILDER_IDE_HOME (default: ../builder-ide):
# nested inside it, TypeScript would also pick up this repo's node_modules/@types/vscode.
set -euo pipefail

IDE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$IDE")"
WORK="${BUILDER_IDE_HOME:-$(dirname "$ROOT")/builder-ide}"
VS="$WORK/vscode"
TAG="$(tr -d '[:space:]' < "$IDE/VSCODE_VERSION")"
ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
PATCH="$IDE/patches/0001-builder.patch"

say() { printf '\033[1;34m[fork]\033[0m %s\n' "$*"; }

tools() {
	local want node_dir="$IDE/.tools/node" pnpm_want
	want="$(tr -d '[:space:]v' < "$VS/.nvmrc")"
	if [[ "$("$node_dir/bin/node" -v 2>/dev/null)" != "v$want" ]]; then
		say "installing Node $want into ide/.tools"
		rm -rf "$node_dir" && mkdir -p "$IDE/.tools"
		curl -fsSL "https://nodejs.org/dist/v$want/node-v$want-darwin-$ARCH.tar.gz" | tar xz -C "$IDE/.tools"
		mv "$IDE/.tools/node-v$want-darwin-$ARCH" "$node_dir"
	fi
	export PATH="$node_dir/bin:$IDE/.tools/pnpm/bin:$PATH"
	pnpm_want="$(node -p "require('$VS/package.json').packageManager.split('@')[1]")"
	if [[ "$(pnpm -v 2>/dev/null)" != "$pnpm_want" ]]; then
		say "installing pnpm $pnpm_want into ide/.tools"
		npm install -g --prefix "$IDE/.tools/pnpm" "pnpm@$pnpm_want" >/dev/null
	fi
	export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
	export NODE_USE_ENV_PROXY=1
	# Microsoft's local-model runtime (an AI feature Builder does not use) fetches ONNX from NuGet,
	# bypassing the proxy; skip it.
	export FOUNDRY_LOCAL_SKIP_INSTALL=1
}

clone() {
	if [[ ! -d "$VS/.git" ]]; then
		say "cloning microsoft/vscode $TAG into $VS"
		mkdir -p "$WORK"
		git clone --depth 1 --branch "$TAG" https://github.com/microsoft/vscode.git "$VS"
	fi
	local have
	have="$(git -C "$VS" describe --tags --exact-match 2>/dev/null || echo unknown)"
	[[ "$have" == "$TAG" ]] || say "warning: $VS is at $have, ide/VSCODE_VERSION says $TAG"
}

patch_tree() {
	if git -C "$VS" apply --check "$PATCH" 2>/dev/null; then
		say "applying $(basename "$PATCH")"
		git -C "$VS" apply "$PATCH"
	elif git -C "$VS" apply -R --check "$PATCH" 2>/dev/null; then
		say "patch already applied"
	else
		echo "Patch does not apply cleanly to $TAG. Resolve by hand in $VS, then run: ide/fork.sh diff" >&2
		exit 1
	fi
	git -C "$VS" checkout -- product.json resources/darwin/code.icns
	node -e '
		const fs = require("fs");
		const [file, over] = process.argv.slice(1);
		const product = JSON.parse(fs.readFileSync(file, "utf8"));
		Object.assign(product, JSON.parse(fs.readFileSync(over, "utf8")));
		fs.writeFileSync(file, JSON.stringify(product, null, "\t") + "\n");
	' "$VS/product.json" "$IDE/product.overrides.json"
	if [[ -f "$IDE/branding/builder.icns" ]]; then
		cp "$IDE/branding/builder.icns" "$VS/resources/darwin/code.icns"
	fi
}

sync_ext() {
	say "building the Builder extension"
	(cd "$ROOT" && npm run build --silent)
	local dest="$VS/extensions/builder"
	rm -rf "$dest" && mkdir -p "$dest/dist"
	cp -R "$ROOT/media" "$dest/media"
	cp "$ROOT/dist/extension.js" "$ROOT/dist/webview.js" "$ROOT/dist/webview.css" "$dest/dist/"
	cp -R "$ROOT/dist/python" "$dest/dist/python"
	cp "$ROOT/README.md" "$dest/README.md"
	# Built-in extensions are packaged as-is: no scripts, no dependencies (everything is bundled).
	node -e '
		const fs = require("fs");
		const [src, dst] = process.argv.slice(1);
		const pkg = JSON.parse(fs.readFileSync(src, "utf8"));
		for (const k of ["scripts", "dependencies", "devDependencies"]) delete pkg[k];
		fs.writeFileSync(dst, JSON.stringify(pkg, null, 2) + "\n");
	' "$ROOT/package.json" "$dest/package.json"
	say "Builder synced into $dest"
}

install_deps() {
	tools
	if [[ ! -d "$VS/node_modules" || "${FORCE:-}" == 1 ]]; then
		say "installing dependencies (pnpm, 10-20 min on first run)"
		(cd "$VS" && pnpm install --frozen-lockfile)
	fi
}

case "${1:-}" in
	setup)
		clone
		patch_tree
		install_deps
		sync_ext
		say "done. Next: ide/fork.sh package   (or ide/fork.sh dev)"
		;;
	sync)
		sync_ext
		;;
	dev)
		tools
		sync_ext
		cd "$VS"
		[[ -d out ]] || pnpm run compile-client
		./scripts/code.sh --disable-extension=GitHub.copilot-chat "${@:2}"
		;;
	package)
		tools
		sync_ext
		cd "$VS"
		pnpm run gulp "vscode-darwin-$ARCH-min"
		say "built: $WORK/VSCode-darwin-$ARCH/Builder.app"
		;;
	install)
		app="$WORK/VSCode-darwin-$ARCH/Builder.app"
		[[ -d "$app" ]] || { echo "Run ide/fork.sh package first." >&2; exit 1; }
		rm -rf /Applications/Builder.app
		cp -R "$app" /Applications/Builder.app
		say "installed /Applications/Builder.app"
		;;
	diff)
		mkdir -p "$IDE/patches"
		git -C "$VS" diff -- . ':(exclude)product.json' ':(exclude)resources/darwin/code.icns' > "$PATCH"
		say "wrote $PATCH ($(grep -c '^diff --git' "$PATCH") files)"
		;;
	*)
		sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
