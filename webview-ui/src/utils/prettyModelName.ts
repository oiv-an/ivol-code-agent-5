export const prettyModelName = (modelId: string): string => {
	if (!modelId) {
		return ""
	}
	// kilocode_change start: keep every path segment and the full tag so ids such as
	// "#router/free/model-a" and "#router/free/model-b" stay distinguishable
	const tagIndex = modelId.indexOf(":")
	const mainId = tagIndex >= 0 ? modelId.slice(0, tagIndex) : modelId
	const tag = tagIndex >= 0 ? modelId.slice(tagIndex + 1) : ""

	const segments = mainId.split("/").filter(Boolean)
	const projectName = segments.length > 1 ? segments[0] : ""
	const modelSegments = segments.length > 1 ? segments.slice(1) : segments

	// Capitalize each word and join with spaces
	const formattedProject = projectName ? projectName.charAt(0).toUpperCase() + projectName.slice(1) : ""

	const formattedName = modelSegments
		.map((segment) =>
			segment
				.split("-")
				.filter(Boolean)
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" "),
		)
		.join(" / ")
	// kilocode_change end

	const formattedTag = tag ? `(${tag.charAt(0).toUpperCase() + tag.slice(1)})` : ""

	return [[formattedProject, formattedName].filter(Boolean).join(" / "), formattedTag].join(" ")
}
