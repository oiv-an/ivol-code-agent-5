import { z } from "zod"

const identifier = z.string().min(1).max(512)
const integerId = z.number().int().positive().safe()

/** Inbound media is a bounded data URI, never a host path or arbitrary URL. */
export const telegramInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("stop"), taskId: identifier, epoch: identifier, updateId: z.number().int() }).strict(),
	z
		.object({
			kind: z.literal("message"),
			text: z.string().max(100_000),
			images: z
				.array(
					z
						.string()
						.max(14_000_000)
						.regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/),
				)
				.max(1)
				.optional(),
			taskId: identifier,
			epoch: identifier,
			updateId: z.number().int(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("approval"),
			requestId: identifier,
			approved: z.boolean(),
			taskId: identifier,
			epoch: identifier,
			updateId: z.number().int(),
		})
		.strict(),
])
export type TelegramInput = z.infer<typeof telegramInputSchema>

/** Bootstrap travels only over the parent/child IPC channel, never the shared listener. */
export const telegramBootstrapSchema = z
	.object({
		token: z
			.string()
			.regex(/^\d+:[A-Za-z0-9_-]+$/)
			.max(256),
		ownerId: integerId,
	})
	.strict()

/** The coordinator accepts no operation that creates, opens or resumes an IDE task. */
export const telegramCoordinatorRequestSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("activate"),
			projectId: identifier,
			taskId: identifier,
			title: z.string().min(1).max(256),
			notice: z.string().min(1).max(2000),
			taskText: z.string().max(2_000_000).optional(),
		})
		.strict(),
	z.object({ operation: z.literal("beginTransfer"), taskId: identifier, epoch: identifier }).strict(),
	z.object({ operation: z.literal("finishTransfer"), taskId: identifier, epoch: identifier }).strict(),
	z.object({ operation: z.literal("deactivate") }).strict(),
	z.object({ operation: z.literal("heartbeat") }).strict(),
	z
		.object({
			operation: z.literal("publishImage"),
			taskId: identifier,
			epoch: identifier,
			messageId: identifier,
			image: z
				.string()
				.max(20_000_000)
				.regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
		})
		.strict(),
	z
		.object({
			operation: z.literal("publish"),
			taskId: identifier,
			epoch: identifier,
			messageId: identifier,
			text: z.string().max(2_000_000),
			partial: z.boolean(),
			markdown: z.boolean().optional(),
			approvalRevision: z.number().int().nonnegative().default(0),
			approval: z
				.object({
					requestId: identifier,
					approveLabel: z.string().min(1).max(64),
					denyLabel: z.string().min(1).max(64),
				})
				.strict()
				.optional(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("invalidateApproval"),
			approvalRevision: z.number().int().nonnegative().default(0),
			taskId: identifier,
			epoch: identifier,
		})
		.strict(),
])

export type TelegramCoordinatorRequest = z.infer<typeof telegramCoordinatorRequestSchema>

export interface TelegramConnectionState {
	configured: boolean
	ownerId?: number
	botUsername?: string
	taskId?: string
	status: "inactive" | "connecting" | "active" | "error"
	error?: string
}
