// kilocode_change - new file
import type { ButtonHTMLAttributes } from "react"

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
	label: string
	icon: string
}

/** Compact native button with keyboard support and an accessible tooltip label. */
export default function HistoryIconButton({ label, icon, type = "button", className = "", ...props }: Props) {
	return (
		<button
			{...props}
			type={type}
			title={label}
			aria-label={label}
			className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded cursor-pointer hover:bg-vscode-toolbar-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder disabled:opacity-40 disabled:cursor-default ${className}`}>
			<span className={`codicon codicon-${icon}`} aria-hidden="true" />
		</button>
	)
}
