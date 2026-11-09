// kilocode_change - new file
import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService send now", () => {
	it("takes only messages marked to send now and keeps the rest queued", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second", ["img.png"])!
		const listener = vi.fn()
		queue.on("stateChanged", listener)

		expect(queue.markSendNow(second.id)).toBe(true)
		expect(queue.messages.find((m) => m.id === second.id)?.sendNow).toBe(true)

		const taken = queue.takeSendNowMessages()
		expect(taken.map((m) => m.text)).toEqual(["second"])
		expect(taken[0].images).toEqual(["img.png"])
		expect(queue.messages.map((m) => m.id)).toEqual([first.id])
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("does nothing for unknown ids or when nothing is marked", () => {
		const queue = new MessageQueueService()
		queue.addMessage("only")
		expect(queue.markSendNow("missing")).toBe(false)
		expect(queue.takeSendNowMessages()).toEqual([])
		expect(queue.messages).toHaveLength(1)
	})
})
