/**
 * Utilities for handling path-related operations in mentions
 */

/**
 * Escapes spaces in a path with backslashes
 *
 * @param path The path to escape
 * @returns A path with spaces escaped
 */
export function escapeSpaces(path: string): string {
	return path.replace(/ /g, "\\ ")
}

/**
 * Converts an absolute path to a mention-friendly path
 * If the provided path starts with the current working directory,
 * it's converted to a relative path prefixed with @
 * Spaces in the path are escaped with backslashes
 *
 * @param path The path to convert
 * @param cwd The current working directory
 * @param allowOutsideWorkspace kilocode_change: when true, absolute paths outside
 *        the workspace are also turned into `@` mentions instead of plain text
 * @returns A mention-friendly path
 */
export function convertToMentionPath(path: string, cwd?: string, allowOutsideWorkspace = false): string {
	// Strip file:// or vscode-remote:// protocol if present
	let pathWithoutProtocol = path

	if (path.startsWith("file://")) {
		pathWithoutProtocol = path.substring(7)
	} else if (path.startsWith("vscode-remote://")) {
		const protocolStripped = path.substring("vscode-remote://".length)
		const firstSlashIndex = protocolStripped.indexOf("/")
		if (firstSlashIndex !== -1) {
			pathWithoutProtocol = protocolStripped.substring(firstSlashIndex + 1)
		} else {
			pathWithoutProtocol = ""
		}
	}

	try {
		pathWithoutProtocol = decodeURIComponent(pathWithoutProtocol)
		// Fix: Remove leading slash for Windows paths like /d:/...
		if (pathWithoutProtocol.startsWith("/") && pathWithoutProtocol[2] === ":") {
			pathWithoutProtocol = pathWithoutProtocol.substring(1)
		}
	} catch (e) {
		// Log error if decoding fails, but continue with the potentially problematic path
		console.error("Error decoding URI component in convertToMentionPath:", e, pathWithoutProtocol)
	}

	const normalizedPath = pathWithoutProtocol.replace(/\\/g, "/")
	let normalizedCwd = cwd ? cwd.replace(/\\/g, "/") : ""

	// kilocode_change start: allow mentioning absolute paths outside the workspace
	const isAbsolute = normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath)

	const toOutsideMention = (): string => {
		// Windows drive paths (C:/foo) need a leading slash so the mention regex matches
		const withLeadingSlash = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`
		return "@" + escapeSpaces(withLeadingSlash)
	}
	// kilocode_change end

	if (!normalizedCwd) {
		// kilocode_change start
		if (allowOutsideWorkspace && isAbsolute) {
			return toOutsideMention()
		}
		// kilocode_change end
		return pathWithoutProtocol
	}

	// Remove trailing slash from cwd if it exists
	if (normalizedCwd.endsWith("/")) {
		normalizedCwd = normalizedCwd.slice(0, -1)
	}

	// Always use case-insensitive comparison for path matching
	const lowerPath = normalizedPath.toLowerCase()
	const lowerCwd = normalizedCwd.toLowerCase()

	if (lowerPath.startsWith(lowerCwd)) {
		let relativePath = normalizedPath.substring(normalizedCwd.length)
		// Ensure there's a slash after the @ symbol when we create the mention path
		relativePath = relativePath.startsWith("/") ? relativePath : "/" + relativePath

		// Escape any spaces in the path with backslashes
		const escapedRelativePath = escapeSpaces(relativePath)

		return "@" + escapedRelativePath
	}

	// kilocode_change start: outside-workspace absolute paths become mentions too
	if (allowOutsideWorkspace && isAbsolute) {
		return toOutsideMention()
	}
	// kilocode_change end

	return pathWithoutProtocol
}
