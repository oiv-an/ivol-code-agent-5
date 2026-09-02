import React, { useState, useEffect } from "react"

const getIsLightThemeFromEditor = () =>
	document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light")

export const KiloLogo = () => {
	const [isLightTheme, setIsLightTheme] = useState(getIsLightThemeFromEditor)

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsLightTheme(getIsLightThemeFromEditor())
		})
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
		return () => observer.disconnect()
	}, [])

	const fillColor = isLightTheme ? "#172033" : "#e8ecff"

	return (
		<svg
			id="IVOL_Code_Agent_5"
			data-name="IVOL Code Agent 5"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 100 100"
			width="100%"
			height="100%"
			role="img"
			aria-label="IVOL Code Agent 5"
			style={{ display: "block" }}>
			<path
				fill={fillColor}
				d="M10 18h34v11H32.5v42H44v11H10V71h11.5V29H10V18Zm35 0h12.5L70 62.4 82.5 18H95L76 82H64L45 18Z"
			/>
		</svg>
	)
}
