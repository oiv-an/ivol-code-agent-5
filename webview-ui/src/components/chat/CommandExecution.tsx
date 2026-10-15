import { useCallback, useState, memo, useMemo } from "react"
import { useEvent } from "react-use"
import { t } from "i18next"
import { ChevronDown, OctagonX } from "lucide-react"

import { type ExtensionMessage, type CommandExecutionStatus, commandExecutionStatusSchema } from "@roo-code/types"

import { safeJsonParse } from "@roo/core"
import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { parseCommand } from "@roo/parse-command"

import { vscode } from "@src/utils/vscode"
import { extractPatternsFromCommand } from "@src/utils/command-parser"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"

import { Button, StandardTooltip } from "@src/components/ui"
import CodeBlock from "../kilocode/common/CodeBlock" // kilocode_change
import { CommandPatternSelector } from "./CommandPatternSelector"

interface CommandPattern {
	pattern: string
	description?: string
}

interface CommandExecutionProps {
	executionId: string
	text?: string
	icon?: JSX.Element | null
	title?: JSX.Element | null
}

export const CommandExecution = ({ executionId, text, icon, title }: CommandExecutionProps) => {
	const { allowedCommands = [], deniedCommands = [], setAllowedCommands, setDeniedCommands } = useExtensionState()

	const { command, output: parsedOutput } = useMemo(() => parseCommandAndOutput(text), [text])

	// kilocode_change: command rows start collapsed so a long run of commands does not flood the chat.
	const [isExpanded, setIsExpanded] = useState(false)
	const commandPreview = useMemo(() => command.trim().split("\n")[0] ?? "", [command])
	const [streamingOutput, setStreamingOutput] = useState("")
	const [status, setStatus] = useState<CommandExecutionStatus | null>(null)

	// The command's output can either come from the text associated with the
	// task message (this is the case for completed commands) or from the
	// streaming output (this is the case for running commands).
	const output = streamingOutput || parsedOutput

	// Extract command patterns from the actual command that was executed
	const commandPatterns = useMemo<CommandPattern[]>(() => {
		// First get all individual commands (including subshell commands) using parseCommand
		const allCommands = parseCommand(command)

		// Then extract patterns from each command using the existing pattern extraction logic
		const allPatterns = new Set<string>()

		// Add all individual commands first
		allCommands.forEach((cmd) => {
			if (cmd.trim()) {
				allPatterns.add(cmd.trim())
			}
		})

		// Then add extracted patterns for each command
		allCommands.forEach((cmd) => {
			const patterns = extractPatternsFromCommand(cmd)
			patterns.forEach((pattern) => allPatterns.add(pattern))
		})

		return Array.from(allPatterns).map((pattern) => ({
			pattern,
		}))
	}, [command])

	// Handle pattern changes
	const handleAllowPatternChange = (pattern: string) => {
		const isAllowed = allowedCommands.includes(pattern)
		const newAllowed = isAllowed ? allowedCommands.filter((p) => p !== pattern) : [...allowedCommands, pattern]
		const newDenied = deniedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const handleDenyPatternChange = (pattern: string) => {
		const isDenied = deniedCommands.includes(pattern)
		const newDenied = isDenied ? deniedCommands.filter((p) => p !== pattern) : [...deniedCommands, pattern]
		const newAllowed = allowedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "commandExecutionStatus") {
				const result = commandExecutionStatusSchema.safeParse(safeJsonParse(message.text, {}))

				if (result.success) {
					const data = result.data

					if (data.executionId !== executionId) {
						return
					}

					switch (data.status) {
						case "started":
							setStatus(data)
							break
						case "output":
							setStreamingOutput(data.output)
							break
						case "fallback":
							break
						default:
							setStatus(data)
							break
					}
				}
			}
		},
		[executionId],
	)

	useEvent("message", onMessage)

	return (
		<>
			<div className="flex flex-row items-center justify-between gap-2 mb-1">
				{/* kilocode_change: the whole header toggles the collapsed command details. */}
				<button
					type="button"
					aria-expanded={isExpanded}
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex flex-row items-center gap-2 min-w-0 flex-1 bg-transparent border-0 p-0 text-left cursor-pointer text-inherit">
					{icon}
					{title}
					{commandPreview && (
						<code className="truncate min-w-0 text-xs text-vscode-descriptionForeground">
							{commandPreview}
						</code>
					)}
					{status?.status === "exited" && (
						<div className="flex flex-row items-center gap-2 font-mono text-xs">
							<StandardTooltip
								content={t("chat.commandExecution.exitStatus", { exitStatus: status.exitCode })}>
								<div
									className={cn(
										"rounded-full size-2",
										status.exitCode === 0 ? "bg-green-600" : "bg-red-600",
									)}
								/>
							</StandardTooltip>
						</div>
					)}
				</button>
				<div className=" flex flex-row items-center justify-between gap-2 px-1">
					<div className="flex flex-row items-center gap-1">
						{status?.status === "started" && (
							<div className="flex flex-row items-center gap-2 font-mono text-xs">
								{status.pid && <div className="whitespace-nowrap">(PID: {status.pid})</div>}
								<StandardTooltip content={t("chat:commandExecution.abort")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() =>
											vscode.postMessage({
												type: "terminalOperation",
												terminalOperation: "abort",
											})
										}>
										<OctagonX className="size-4" />
									</Button>
								</StandardTooltip>
							</div>
						)}
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("chat:commandExecution.toggleDetails")}
							aria-expanded={isExpanded}
							onClick={() => setIsExpanded(!isExpanded)}>
							<ChevronDown
								className={cn("size-4 transition-transform duration-300", isExpanded && "rotate-180")}
							/>
						</Button>
					</div>
				</div>
			</div>

			{isExpanded && (
				<div className="bg-vscode-editor-background border border-vscode-border rounded-xs ml-6 mt-2">
					<div className="p-2">
						<CodeBlock source={command} language="shell" />
						<OutputContainer isExpanded={true} output={output} />
					</div>
					{command && command.trim() && (
						<CommandPatternSelector
							patterns={commandPatterns}
							allowedCommands={allowedCommands}
							deniedCommands={deniedCommands}
							onAllowPatternChange={handleAllowPatternChange}
							onDenyPatternChange={handleDenyPatternChange}
						/>
					)}
				</div>
			)}
		</>
	)
}

CommandExecution.displayName = "CommandExecution"

const OutputContainerInternal = ({ isExpanded, output }: { isExpanded: boolean; output: string }) => (
	<div
		className={cn("overflow-hidden", {
			"max-h-0": !isExpanded,
			"max-h-[100%] mt-1 pt-1 border-t border-border/25": isExpanded,
		})}>
		{output.length > 0 && <CodeBlock source={output} language="log" />}
	</div>
)

const OutputContainer = memo(OutputContainerInternal)

const parseCommandAndOutput = (text: string | undefined) => {
	if (!text) {
		return { command: "", output: "" }
	}

	const index = text.indexOf(COMMAND_OUTPUT_STRING)

	if (index === -1) {
		return { command: text, output: "" }
	}

	return {
		command: text.slice(0, index),
		output: text.slice(index + COMMAND_OUTPUT_STRING.length),
	}
}
