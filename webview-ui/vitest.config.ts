import { defineConfig, type UserConfig } from "vitest/config"
import path from "path"
import react from "@vitejs/plugin-react" // kilocode_change
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	// kilocode_change: opt-in production compiler parity for targeted regressions.
	plugins:
		process.env.IVOL_TEST_REACT_COMPILER === "1"
			? (react({
					babel: { plugins: [["babel-plugin-react-compiler", { target: "18" }]] },
				}) as unknown as UserConfig["plugins"])
			: [],
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		environment: "jsdom",
		include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
		onConsoleLog,
		retry: process.env.CI ? 2 : 0, // kilocode_change: retry tests in CI environments
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@src": path.resolve(__dirname, "./src"),
			"@roo": path.resolve(__dirname, "../src/shared"),
			// Mock the vscode module for tests since it's not available outside
			// VS Code extension context.
			vscode: path.resolve(__dirname, "./src/__mocks__/vscode.ts"),
		},
	},
})
