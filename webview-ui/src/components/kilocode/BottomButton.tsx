import React from "react"

interface BottomButtonProps {
	onClick: () => void
	iconClass: string
	ariaLabel?: string
	title?: string
	highlighted?: boolean
}

const BottomButton = React.forwardRef<HTMLButtonElement, BottomButtonProps>(
	({ onClick, iconClass, ariaLabel, title, highlighted = false, ...props }, ref) => {
		return (
			<button
				ref={ref}
				className={`vscode-button flex items-center gap-1.5 p-0.75 rounded-sm cursor-pointer hover:bg-vscode-list-hoverBackground ${highlighted ? "text-yellow-400 bg-yellow-500/20 ring-1 ring-yellow-400" : "text-vscode-foreground"}`}
				aria-label={ariaLabel}
				title={title}
				onClick={onClick}
				{...props}>
				<span className={`codicon ${iconClass} text-sm`}></span>
			</button>
		)
	},
)

export default BottomButton
