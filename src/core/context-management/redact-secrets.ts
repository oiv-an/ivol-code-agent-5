// kilocode_change - new file: secret redaction shared by CURRENT_TASK.md writes
// and by any other place that shows model-produced text back to the workspace.

const REDACTED_SECRET = "[redacted]"

export function redactPotentialSecrets(content: string, knownSecrets: readonly string[] = []): string {
	let redacted = content

	// Exact values are the strongest signal. Replace longer values first so a
	// short value cannot leave a suffix of a longer credential behind.
	const exactSecrets = [...new Set(knownSecrets.filter((secret) => secret.length >= 4))].sort(
		(a, b) => b.length - a.length,
	)
	for (const secret of exactSecrets) {
		redacted = redacted.split(secret).join(REDACTED_SECRET)
	}

	return (
		redacted
			.replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi, REDACTED_SECRET)
			.replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1${REDACTED_SECRET}`)
			// Authorization credentials contain a space, so redact them before the
			// generic assignment matcher can consume only the auth-scheme prefix.
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED_SECRET}`)
			// Start once per key instead of rescanning every suffix of an
			// unbroken token; keep camelCase and underscore-prefixed keys covered.
			.replace(
				/(?<![a-z0-9_-])((?:["'`])?(?:[a-z0-9_-]*?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|password|passwd|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|private[_-]?key|session[_-]?(?:id|token)|credential|cookie))(?:["'`])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]]+)/gi,
				`$1${REDACTED_SECRET}`,
			)
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_SECRET)
			.replace(/\b(?:ivol-managed|sk-(?:ant-|proj-)?|rk-|pk-)[A-Za-z0-9_-]{12,}\b/gi, REDACTED_SECRET)
			.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, REDACTED_SECRET)
			.replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, REDACTED_SECRET)
			.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED_SECRET)
			.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, `$1${REDACTED_SECRET}@`)
	)
}
