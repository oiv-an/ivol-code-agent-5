// kilocode_change - new file
import { BrowserOSUnavailableError, connectBrowserOSForTask } from "../kilocode/BrowserOSConnectFlow"
import { BrowserOSAccess } from "../kilocode/BrowserOSAccess"

it("keeps explicit no-repeat consent for the host connection across chats", async () => {
	const access = new BrowserOSAccess()
	const owner = {},
		connection = {}
	await access.acquire(owner, connection, async () => true)
	expect(access.canApproveTaskAction(owner, connection)).toBe(false)
	const confirm = vi.fn().mockResolvedValue(true)
	await access.acquire(owner, connection, confirm, true)
	expect(confirm).toHaveBeenCalledOnce()
	expect(access.canApproveTaskAction(owner, connection)).toBe(true)
	expect(access.canApproveTaskAction({}, connection)).toBe(true)
	expect(access.canApproveTaskAction(owner, {})).toBe(false)
	access.pause()
	expect(access.canApproveTaskAction(owner, connection)).toBe(false)
	access.resume()
	expect(access.canApproveTaskAction(owner, connection)).toBe(true)
	access.revoke()
	await access.acquire(owner, connection, async () => true)
	expect(access.canApproveTaskAction(owner, connection)).toBe(false)
})

it("ends stale work without revoking consent or retaining observations", async () => {
	const access = new BrowserOSAccess()
	const caller = {},
		replacement = {},
		connection = {}
	await access.acquire(caller, connection, async () => true, true)
	await access.execute(caller, connection, { kind: "observation", page: 7 }, async () => ({
		content: [{ type: "text", text: "Page" }],
	}))
	let finish!: (value: unknown) => void
	const pending = access.execute(
		caller,
		connection,
		{ kind: "discovery" },
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const rejected = expect(pending).rejects.toThrow("access changed")
	await vi.waitFor(() => expect(finish).toBeDefined())
	access.endTask(caller)
	finish({ content: [{ type: "text", text: "Stale" }] })
	await rejected
	expect(access.getStatus()).toBe("active")
	expect(access.canApproveTaskAction(replacement, connection)).toBe(true)
	await expect(access.execute(replacement, connection, { kind: "interaction", page: 7 }, vi.fn())).rejects.toThrow(
		"fresh",
	)
	access.endTask(caller)
	await expect(access.execute(replacement, connection, { kind: "create" }, async () => "new page")).resolves.toBe(
		"new page",
	)
	expect(new BrowserOSAccess().canApproveTaskAction(replacement, connection)).toBe(false)
})

it("does not retain no-repeat consent after refusing an upgrade", async () => {
	const access = new BrowserOSAccess()
	const owner = {},
		connection = {}
	await access.acquire(owner, connection, async () => true)
	await expect(access.acquire(owner, connection, async () => false, true)).rejects.toThrow("declined")
	expect(access.canApproveTaskAction(owner, connection)).toBe(false)
})

describe("BrowserOS combined connection flow", () => {
	const makeOptions = () => ({
		isCurrent: vi.fn(() => true),
		connect: vi.fn().mockResolvedValue({ serverName: "browseros-neo" }),
		launch: vi.fn().mockResolvedValue(true),
		grant: vi.fn().mockResolvedValue(undefined),
		progress: vi.fn().mockResolvedValue(undefined),
	})

	it("connects before requesting permission without relaunching a running browser", async () => {
		const options = makeOptions()
		await connectBrowserOSForTask(options)
		expect(options.launch).not.toHaveBeenCalled()
		expect(options.grant).toHaveBeenCalledWith({ serverName: "browseros-neo" })
		expect(options.progress.mock.calls.map(([stage]) => stage)).toEqual(["connecting", "permission"])
	})

	it("launches only when unavailable, then reconnects and requests permission", async () => {
		const options = makeOptions()
		options.connect.mockRejectedValueOnce(new BrowserOSUnavailableError("Not running"))
		await connectBrowserOSForTask(options)
		expect(options.launch).toHaveBeenCalledOnce()
		expect(options.connect).toHaveBeenCalledTimes(2)
		expect(options.grant).toHaveBeenCalledOnce()
	})

	it("stops after cancelling the application picker", async () => {
		const options = makeOptions()
		options.connect.mockRejectedValueOnce(new BrowserOSUnavailableError("Not running"))
		options.launch.mockResolvedValue(false)
		await expect(connectBrowserOSForTask(options)).resolves.toBeUndefined()
		expect(options.connect).toHaveBeenCalledOnce()
		expect(options.grant).not.toHaveBeenCalled()
	})

	it("does not launch for a configuration error", async () => {
		const options = makeOptions()
		options.connect.mockRejectedValue(new Error("Connection disabled"))
		await expect(connectBrowserOSForTask(options)).rejects.toThrow("Connection disabled")
		expect(options.launch).not.toHaveBeenCalled()
		expect(options.grant).not.toHaveBeenCalled()
	})

	it("does not grant a replacement task after connecting", async () => {
		const options = makeOptions()
		options.connect.mockImplementation(async () => {
			options.isCurrent.mockReturnValue(false)
			return { serverName: "browseros-neo" }
		})
		await expect(connectBrowserOSForTask(options)).rejects.toThrow("expired")
		expect(options.grant).not.toHaveBeenCalled()
	})

	it("does not repeat a refused permission request", async () => {
		const options = makeOptions()
		options.grant.mockRejectedValue(new Error("Permission declined"))
		await expect(connectBrowserOSForTask(options)).rejects.toThrow("Permission declined")
		expect(options.grant).toHaveBeenCalledOnce()
		expect(options.launch).not.toHaveBeenCalled()
	})
})
