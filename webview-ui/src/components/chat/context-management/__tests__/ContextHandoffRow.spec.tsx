// kilocode_change - new file
import { render, screen } from "@testing-library/react"

import { ContextHandoffRow } from "../ContextHandoffRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../../ProgressIndicator", () => ({
	ProgressIndicator: () => <span data-testid="progress-indicator" />,
}))

describe("ContextHandoffRow", () => {
	it("shows live file preparation without pretending that compression has started", () => {
		render(<ContextHandoffRow isInProgress />)

		expect(screen.getByRole("status")).toHaveTextContent("chat:contextHandoff.inProgress")
		expect(screen.getByTestId("progress-indicator")).toBeInTheDocument()
		expect(screen.queryByText("chat:contextManagement.condensation.inProgress")).not.toBeInTheDocument()
	})

	it("shows the actual service instruction expanded in history without a stale spinner", () => {
		const prompt = "Save the task state, verified decisions and next steps before compression."
		const { container } = render(
			<ContextHandoffRow text={JSON.stringify({ phase: "preparing", path: "CONTEXT_RESTART.md", prompt })} />,
		)

		expect(screen.getByText("chat:contextHandoff.preparingTitle")).toBeInTheDocument()
		expect(screen.getByText("CONTEXT_RESTART.md")).toBeInTheDocument()
		expect(screen.getByText(prompt)).toBeVisible()
		expect(container.querySelector("details")).toHaveAttribute("open")
		expect(screen.queryByTestId("progress-indicator")).not.toBeInTheDocument()
	})

	it("keeps the complete verified file safely expandable as plain text", () => {
		const content =
			"# Continuation\n<script>alert('no')</script>\n[Open](command:dangerous)\n" + "next step\n".repeat(1000)
		const { container } = render(
			<ContextHandoffRow
				text={JSON.stringify({ phase: "saved", path: "/my/project/CONTEXT_RESTART.md", content })}
			/>,
		)

		expect(screen.getByText("chat:contextHandoff.savedTitle")).toBeInTheDocument()
		expect(screen.getByText("/my/project/CONTEXT_RESTART.md")).toBeInTheDocument()
		expect(container.querySelector("details")).not.toHaveAttribute("open")
		expect(container.querySelector("pre")?.textContent).toBe(content)
		expect(container.querySelector("script")).toBeNull()
		expect(container.querySelector("a")).toBeNull()
		expect(screen.queryByTestId("progress-indicator")).not.toBeInTheDocument()
	})

	it.each([undefined, "not JSON", '{"phase":"saved"}', '{"phase":"unexpected","path":"file"}'])(
		"handles malformed persisted details without a crash: %s",
		(text) => {
			render(<ContextHandoffRow text={text} />)
			expect(screen.getByText("chat:contextHandoff.invalidDetails")).toBeInTheDocument()
		},
	)
})
