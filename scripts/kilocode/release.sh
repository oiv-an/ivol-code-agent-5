#!/usr/bin/env bash
# Build and publish a release of IVOL Code Agent 5.
#
# The maintainer decides when a release happens. This script is never invoked by
# a build, a hook or an agent on its own: it must be started by hand and it asks
# for an explicit confirmation before anything leaves the machine.
#
# Authentication uses Microsoft Entra ID through the Azure CLI, not a Personal
# Access Token. Global Azure DevOps PATs are retired on 2026-12-01.
#
# Usage:
#   scripts/kilocode/release.sh 5.16.246              # build, then ask before publishing
#   scripts/kilocode/release.sh 5.16.246 --dry-run    # build only, never publish
#   scripts/kilocode/release.sh 5.16.246 --skip-jetbrains
#
# Before the first run:
#   brew install azure-cli
#   az login --allow-no-subscriptions
#   npx vsce verify-pat ivol --azure-credential

set -euo pipefail

# A stale token in the environment silently wins over --azure-credential.
unset VSCE_PAT

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly PUBLISHER="ivol"
readonly PLATFORM_ZIP="$HOME/.ivol-build-cache/platform.zip"
readonly JETBRAINS_JDK="/Applications/PhpStorm.app/Contents/jbr/Contents/Home"

VERSION=""
DRY_RUN=false
SKIP_JETBRAINS=false

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
	sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit 1
}

parse_arguments() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--dry-run) DRY_RUN=true ;;
			--skip-jetbrains) SKIP_JETBRAINS=true ;;
			-h|--help) usage ;;
			-*) fail "Unknown option: $1" ;;
			*)
				[ -z "$VERSION" ] || fail "Version given twice: $VERSION and $1"
				VERSION="$1"
				;;
		esac
		shift
	done

	[ -n "$VERSION" ] || usage
	[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Version must look like 5.16.246, got: $VERSION"
}

require_tool() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"
}

check_environment() {
	log "Checking the environment"

	require_tool pnpm "Restore it with: corepack enable pnpm --install-directory ~/.local/bin"
	require_tool az "Install it with: brew install azure-cli"
	require_tool gh "Install it with: brew install gh"

	az account show >/dev/null 2>&1 ||
		fail "Not signed in to Azure. Run: az login --allow-no-subscriptions"

	local identity
	identity="$(az account show --query 'user.name' -o tsv)"
	echo "Azure identity: $identity"

	if [ "$SKIP_JETBRAINS" = false ]; then
		[ -d "$JETBRAINS_JDK" ] || fail "No JDK at $JETBRAINS_JDK. Install PhpStorm or pass --skip-jetbrains."
		[ -f "$PLATFORM_ZIP" ] ||
			fail "Missing $PLATFORM_ZIP. Regenerate it with: cd jetbrains/plugin && ./gradlew genPlatform"
	fi

	local current_version
	current_version="$(node -p "require('$REPO_ROOT/src/package.json').version")"
	echo "Current version: $current_version"
	[ "$current_version" != "$VERSION" ] || fail "Version $VERSION is already set. Pick a new one."

	if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]; then
		echo
		git -C "$REPO_ROOT" status --short --untracked-files=no
		fail "The working tree has uncommitted changes. Commit or stash them first."
	fi
}

verify_publisher_access() {
	log "Verifying publish rights for '$PUBLISHER'"
	(cd "$REPO_ROOT/src" && npx vsce verify-pat "$PUBLISHER" --azure-credential) ||
		fail "No publish rights. Check that your Azure identity is a member of the '$PUBLISHER' publisher."
}

require_changelog_entry() {
	# The JetBrains build reads release notes from CHANGELOG.md and fails without them.
	grep -q "^## $VERSION\$" "$REPO_ROOT/CHANGELOG.md" ||
		fail "CHANGELOG.md has no '## $VERSION' section. Add the release notes first."
}

bump_version() {
	log "Setting the version to $VERSION"

	node -e '
		const fs = require("fs");
		const [file, version] = process.argv.slice(1);
		const text = fs.readFileSync(file, "utf8");
		const updated = text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`);
		if (updated === text) throw new Error(`Could not set the version in ${file}`);
		fs.writeFileSync(file, updated);
	' "$REPO_ROOT/src/package.json" "$VERSION"

	local gradle_properties="$REPO_ROOT/jetbrains/plugin/gradle.properties"
	if [ -f "$gradle_properties" ]; then
		# Not tracked by Git: generated from gradle.properties.template.
		perl -pi -e "s/^pluginVersion=.*/pluginVersion=$VERSION/" "$gradle_properties"
	fi

	echo "src/package.json and gradle.properties now report $VERSION"
}

build_vsix() {
	log "Building the VS Code package"
	(cd "$REPO_ROOT" && corepack pnpm vsix)

	VSIX_PATH="$REPO_ROOT/bin/ivol-code-agent-5-$VERSION.vsix"
	[ -f "$VSIX_PATH" ] || fail "Expected $VSIX_PATH, but the build did not produce it."
	echo "VSIX: $VSIX_PATH"
}

build_jetbrains() {
	log "Building the JetBrains plugin"

	export JAVA_HOME="$JETBRAINS_JDK"
	export PATH="$JAVA_HOME/bin:$PATH"

	# Refreshes jetbrains/resources/** from the current sources. It always fails at
	# prepareSandbox because it does not pass platformZipPath; by then the bundles
	# that Gradle packages are already in place, so the failure is expected.
	(cd "$REPO_ROOT" && corepack pnpm jetbrains:bundle) || true

	(cd "$REPO_ROOT/jetbrains/plugin" && ./gradlew buildPlugin \
		-PdebugMode=release -PplatformZipPath="$PLATFORM_ZIP")

	JETBRAINS_ZIP="$REPO_ROOT/jetbrains/plugin/build/distributions/IVOL Code Agent 5-$VERSION.zip"
	[ -f "$JETBRAINS_ZIP" ] || fail "Expected $JETBRAINS_ZIP, but the build did not produce it."
	echo "JetBrains plugin: $JETBRAINS_ZIP"
}

confirm_publication() {
	log "Ready to publish $VERSION"
	echo "  Marketplace : $VSIX_PATH"
	echo "  GitHub tag  : v$VERSION"
	[ -n "${JETBRAINS_ZIP:-}" ] && echo "  Attachment  : $(basename "$JETBRAINS_ZIP")"
	echo
	echo "A published version can never be replaced, only superseded."
	printf 'Type "publish" to continue: '

	local answer
	read -r answer
	[ "$answer" = "publish" ] || fail "Cancelled. Nothing was published."
}

publish_marketplace() {
	log "Publishing to the Visual Studio Marketplace"
	(cd "$REPO_ROOT/src" && npx vsce publish --azure-credential --packagePath "$VSIX_PATH")
}

publish_github_release() {
	log "Creating the GitHub release"

	local notes
	notes="$(awk -v version="## $VERSION" '
		$0 == version { collecting = 1; next }
		collecting && /^## / { exit }
		collecting { print }
	' "$REPO_ROOT/CHANGELOG.md")"

	gh release create "v$VERSION" \
		--repo "$(git -C "$REPO_ROOT" remote get-url origin)" \
		--title "IVOL Code Agent 5 $VERSION" \
		--notes "$notes" \
		"$VSIX_PATH"
}

main() {
	parse_arguments "$@"
	check_environment
	verify_publisher_access
	require_changelog_entry
	bump_version
	build_vsix
	[ "$SKIP_JETBRAINS" = false ] && build_jetbrains

	if [ "$DRY_RUN" = true ]; then
		log "Dry run finished. Nothing was published."
		echo "VSIX: $VSIX_PATH"
		[ -n "${JETBRAINS_ZIP:-}" ] && echo "JetBrains plugin: $JETBRAINS_ZIP"
		return 0
	fi

	confirm_publication
	publish_marketplace
	publish_github_release

	log "Published $VERSION"
	echo "Marketplace: https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.ivol-code-agent-5"
	[ -n "${JETBRAINS_ZIP:-}" ] && echo "Install the JetBrains plugin manually: $JETBRAINS_ZIP"
	echo
	echo "Commit the version bump when you are ready:"
	echo "  git add src/package.json CHANGELOG.md && git commit && git push origin stable-v5"
}

main "$@"
