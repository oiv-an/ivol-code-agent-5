#!/usr/bin/env bash
# Build and publish a release of IVOL Code Agent 5.
#
# One command produces every artifact of a version: the VS Code package goes to
# the Visual Studio Marketplace, and all JetBrains builds are attached to a
# GitHub release, which is where the maintainer points JetBrains users.
#
# The maintainer decides when a release happens. This script is never invoked by
# a build, a hook or an agent on its own: it must be started by hand and it asks
# for an explicit confirmation before anything leaves the machine.
#
# Authentication uses Microsoft Entra ID through the Azure CLI, not a Personal
# Access Token. Global Azure DevOps PATs are retired on 2026-12-01.
#
# Usage:
#   scripts/kilocode/release.sh 5.16.246                # build everything, then ask
#   scripts/kilocode/release.sh 5.16.246 --dry-run      # build only, never publish
#   scripts/kilocode/release.sh 5.16.246 --only phpstorm,idea
#
# Before the first run:
#   brew install azure-cli openjdk@21
#   az login --allow-no-subscriptions
#   npx vsce verify-pat ivol --azure-credential

set -euo pipefail

# A stale token in the environment silently wins over --azure-credential.
unset VSCE_PAT

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly PUBLISHER="ivol"
readonly PLATFORM_ZIP="$HOME/.ivol-build-cache/platform.zip"

# Java 25 ships with the current IDEs; the older platforms must be built with 21.
readonly JDK25="/Applications/PhpStorm.app/Contents/jbr/Contents/Home"
readonly JDK21="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"

# target|gradle properties|JDK|archive name (without the version)|human name
readonly JETBRAINS_TARGETS=(
	"phpstorm|-PplatformType=PS|$JDK25||PhpStorm 2026.2"
	"idea|-PplatformType=IU|$JDK25|-idea|IntelliJ IDEA 2026.2"
	"idea253|-PplatformType=IU -PideaTarget=2025.3|$JDK21|-idea-2025.3|IntelliJ IDEA 2025.3"
	"pycharm|-PplatformType=PY|$JDK21|-pycharm|PyCharm 2025.1"
)

VERSION=""
DRY_RUN=false
SELECTED_TARGETS=""
BUILT_ARCHIVES=()

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
	sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit 1
}

parse_arguments() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--dry-run) DRY_RUN=true ;;
			--only)
				shift
				[ $# -gt 0 ] || fail "--only needs a comma separated list of targets"
				SELECTED_TARGETS="$1"
				;;
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

	if [ -n "$SELECTED_TARGETS" ]; then
		local requested
		for requested in ${SELECTED_TARGETS//,/ }; do
			[ "$requested" = "none" ] && continue
			is_known_target "$requested" || fail "Unknown target '$requested'. Known: $(known_target_names)"
		done
	fi
}

known_target_names() {
	local entry names=()
	for entry in "${JETBRAINS_TARGETS[@]}"; do names+=("${entry%%|*}"); done
	printf '%s, ' "${names[@]}" | sed 's/, $//'
}

is_known_target() {
	local entry
	for entry in "${JETBRAINS_TARGETS[@]}"; do
		[ "${entry%%|*}" = "$1" ] && return 0
	done
	return 1
}

target_is_selected() {
	[ -z "$SELECTED_TARGETS" ] && return 0
	local requested
	for requested in ${SELECTED_TARGETS//,/ }; do
		[ "$requested" = "$1" ] && return 0
	done
	return 1
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
	echo "Azure identity: $(az account show --query 'user.name' -o tsv)"

	gh auth status >/dev/null 2>&1 || fail "Not signed in to GitHub. Run: gh auth login"

	local entry name jdk
	for entry in "${JETBRAINS_TARGETS[@]}"; do
		IFS='|' read -r name _ jdk _ _ <<<"$entry"
		target_is_selected "$name" || continue
		[ -d "$jdk" ] || fail "Target '$name' needs a JDK at $jdk. Install it with: brew install openjdk@21"
	done

	if [ -z "$SELECTED_TARGETS" ] || [ "$SELECTED_TARGETS" != "none" ]; then
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

refresh_jetbrains_resources() {
	log "Refreshing the bundled extension for JetBrains"

	export JAVA_HOME="$JDK25"
	export PATH="$JAVA_HOME/bin:$PATH"

	# Always fails at prepareSandbox because it does not pass platformZipPath. By
	# then it has already copied the freshly built extension and webview bundles
	# into jetbrains/resources, which is the part Gradle needs.
	(cd "$REPO_ROOT" && corepack pnpm jetbrains:bundle) || true

	local bundled="$REPO_ROOT/jetbrains/resources/kilocode/dist/extension.js"
	[ -f "$bundled" ] || fail "Missing $bundled: the JetBrains bundle step did not produce the extension."
}

build_jetbrains_target() {
	local gradle_flags="$1" jdk="$2" suffix="$3" title="$4"

	log "Building the plugin for $title"

	(
		export JAVA_HOME="$jdk"
		export PATH="$JAVA_HOME/bin:$PATH"
		cd "$REPO_ROOT/jetbrains/plugin"
		# shellcheck disable=SC2086  # the flags are a deliberate word list
		./gradlew buildPlugin -PdebugMode=release -PplatformZipPath="$PLATFORM_ZIP" $gradle_flags
	)

	# Gradle writes each target into its own build directory; find the archive there.
	local found
	found="$(find "$REPO_ROOT/jetbrains/plugin" -type f \
		-name "IVOL Code Agent 5-$VERSION$suffix.zip" -path '*/distributions/*' -print -quit)"
	[ -n "$found" ] || fail "Could not find the archive for $title after the build."

	echo "$title: $found"
	BUILT_ARCHIVES+=("$found")
}

build_jetbrains() {
	[ "$SELECTED_TARGETS" = "none" ] && return 0

	local built_any=false entry name flags jdk suffix title
	for entry in "${JETBRAINS_TARGETS[@]}"; do
		IFS='|' read -r name flags jdk suffix title <<<"$entry"
		target_is_selected "$name" || continue
		[ "$built_any" = false ] && refresh_jetbrains_resources && built_any=true
		build_jetbrains_target "$flags" "$jdk" "$suffix" "$title"
	done
}

confirm_publication() {
	log "Ready to publish $VERSION"
	echo "  Marketplace : $(basename "$VSIX_PATH")"
	echo "  GitHub tag  : v$VERSION"

	local archive
	for archive in "${BUILT_ARCHIVES[@]}"; do
		printf '  Attachment  : %s (%s)\n' "$(basename "$archive")" \
			"$(du -h "$archive" | cut -f1 | tr -d ' ')"
	done

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

# "owner/name", which every gh command understands. A remote URL only works for
# creating a release; gh release view rejects it with "release not found".
github_repository() {
	git -C "$REPO_ROOT" remote get-url origin |
		sed -e 's#^git@github\.com:#https://github.com/#' \
			-e 's#^https://github\.com/##' -e 's#\.git$##'
}

publish_github_release() {
	log "Creating the GitHub release"

	local notes
	notes="$(awk -v version="## $VERSION" '
		$0 == version { collecting = 1; next }
		collecting && /^## / { exit }
		collecting { print }
	' "$REPO_ROOT/CHANGELOG.md")"

	notes+=$'\n\nJetBrains IDEs: download the archive for your IDE below and install it'
	notes+=$' with Settings, Plugins, Install Plugin from Disk.'

	gh release create "v$VERSION" \
		--repo "$(github_repository)" \
		--title "IVOL Code Agent 5 $VERSION" \
		--notes "$notes" \
		"$VSIX_PATH" "${BUILT_ARCHIVES[@]}"
}

main() {
	parse_arguments "$@"
	check_environment
	verify_publisher_access
	require_changelog_entry
	bump_version
	build_vsix
	build_jetbrains

	if [ "$DRY_RUN" = true ]; then
		log "Dry run finished. Nothing was published."
		echo "VSIX: $VSIX_PATH"
		printf '%s\n' "${BUILT_ARCHIVES[@]}"
		return 0
	fi

	confirm_publication
	publish_marketplace
	publish_github_release

	log "Published $VERSION"
	echo "Marketplace: https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.ivol-code-agent-5"
	echo "Release    : $(gh release view "v$VERSION" --repo "$(github_repository)" --json url --jq .url)"
	echo
	echo "Commit the version bump when you are ready:"
	echo "  git add src/package.json CHANGELOG.md && git commit && git push origin stable-v5"
}

main "$@"
