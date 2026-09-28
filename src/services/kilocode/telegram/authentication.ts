import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

export const telegramChallengeSchema = z
	.object({
		type: z.literal("challenge"),
		version: z.literal(1),
		nonce: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()

export const telegramProofSchema = z
	.object({
		type: z.literal("authenticate"),
		version: z.literal(1),
		nonce: z.string().regex(/^[a-f0-9]{64}$/),
		ownerId: z.number().int().positive().safe(),
		proof: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()

export function telegramNonce(): string {
	return randomBytes(32).toString("hex")
}

/** Bind both fresh nonces and direction so a server proof cannot be reflected as client authentication. */
export function telegramProof(
	token: string,
	side: "client" | "server",
	serverNonce: string,
	clientNonce: string,
	ownerId: number,
): string {
	return createHmac("sha256", token)
		.update(JSON.stringify(["ivol-telegram-v1", side, serverNonce, clientNonce, ownerId]))
		.digest("hex")
}

export function verifyTelegramProof(actual: string, expected: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false
	return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
}
