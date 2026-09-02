import { Package } from "../../shared/package"

export const DEFAULT_HEADERS = {
	// OpenRouter uses these values to identify the calling application.
	"HTTP-Referer": "https://github.com/oiv-an/ivol-code-agent-5",
	"X-Title": "IVOL Code",
	"X-IVOL-Code-Version": Package.version,
	"User-Agent": `IVOL-Code-Agent-5/${Package.version}`,
}
