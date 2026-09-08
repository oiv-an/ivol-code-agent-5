// kilocode_change - new file
import * as http from "node:http"
import * as https from "node:https"
import { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError")
}

/**
 * VS Code's fetch patch replaces caller dispatchers when adding system CAs.
 * Its HTTPS patch, in contrast, retains per-request TLS options and resolves
 * configured/environment/OS/PAC proxies when no custom Agent is supplied.
 * Keep that host-owned route and authentication logic; never replace an Agent.
 */
export function createVsCodeProviderFetch(allowedOrigin: string, timeoutMs?: number): typeof globalThis.fetch {
	const timeout =
		typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs) : 600_000
	return async (input, init) => {
		if ((init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher !== undefined) {
			throw new Error(
				"Cannot ignore the provider certificate with a custom fetch dispatcher in VS Code; the route was not bypassed.",
			)
		}
		const request = new Request(input, init)
		const signal = request.signal
		if (signal.aborted) throw abortError(signal)
		const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
		if (signal.aborted) throw abortError(signal)
		return send(new URL(request.url), request.method, new Headers(request.headers), body, 0)

		function send(
			url: URL,
			method: string,
			headers: Headers,
			payload: Buffer | undefined,
			redirects: number,
		): Promise<Response> {
			return new Promise<Response>((resolve, reject) => {
				if (signal.aborted) {
					reject(abortError(signal))
					return
				}
				if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
					reject(new Error("Unsupported provider redirect URL"))
					return
				}
				// Do not leave an insecure keep-alive socket available to another profile.
				headers.set("connection", "close")
				let response: http.IncomingMessage | undefined
				let decoded: Readable | undefined
				let headersTimer: ReturnType<typeof setTimeout> | undefined
				let bodyOwnsAbort = false
				let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
				const cleanupAbort = () => signal.removeEventListener("abort", onAbort)
				const transport = url.protocol === "https:" ? https : http
				const nodeRequest = transport.request(
					url,
					{
						method,
						headers: Object.fromEntries(headers.entries()),
						// Passing a custom Agent would suppress VS Code's 'on' proxy mode.
						rejectUnauthorized: url.origin !== allowedOrigin,
					},
					(incoming) => {
						incoming.on("error", reject)
						try {
							clearTimeout(headersTimer)
							response = incoming
							const status = incoming.statusCode ?? 0
							const location = incoming.headers.location
							if (
								location &&
								[301, 302, 303, 307, 308].includes(status) &&
								request.redirect !== "manual"
							) {
								if (request.redirect === "error" || redirects >= 20) {
									incoming.destroy()
									reject(new Error("Provider request redirect was not allowed or exceeded its limit"))
									return
								}
								let next: URL
								try {
									next = new URL(location, url)
								} catch (error) {
									incoming.destroy()
									reject(error)
									return
								}
								const nextHeaders = new Headers(headers)
								let nextMethod = method
								let nextPayload = payload
								if (
									(status === 303 && method !== "HEAD") ||
									([301, 302].includes(status) && method === "POST")
								) {
									nextMethod = "GET"
									nextPayload = undefined
									for (const name of ["content-type", "content-length", "transfer-encoding"])
										nextHeaders.delete(name)
								}
								if (next.origin !== url.origin) {
									for (const name of [
										"authorization",
										"proxy-authorization",
										"cookie",
										"cookie2",
										"host",
									])
										nextHeaders.delete(name)
									if (nextPayload?.length) {
										incoming.destroy()
										reject(
											new Error(
												"Provider redirect changed origin; the request body was not forwarded",
											),
										)
										return
									}
								}
								incoming.destroy()
								resolve(send(next, nextMethod, nextHeaders, nextPayload, redirects + 1))
								return
							}
							const responseHeaders = new Headers()
							for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
								responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
							}
							const emptyBody = method === "HEAD" || [204, 205, 304].includes(status)
							let responseBody: Readable = incoming
							if (!emptyBody) {
								for (const encoding of String(incoming.headers["content-encoding"] ?? "")
									.split(",")
									.map((value) => value.trim())
									.reverse()) {
									const decoder =
										encoding === "gzip" || encoding === "x-gzip"
											? createGunzip()
											: encoding === "deflate"
												? createInflate()
												: encoding === "br"
													? createBrotliDecompress()
													: undefined
									if (decoder) {
										const source: Readable = responseBody
										source.on("error", (error) => decoder.destroy(error))
										decoder.on("error", (error) => incoming.destroy(error))
										responseBody = source.pipe(decoder)
									}
								}
							}
							decoded = responseBody
							let streamedBody: ReadableStream<Uint8Array> | null = null
							if (!emptyBody) {
								bodyOwnsAbort = true
								const reader = (Readable.toWeb(responseBody) as ReadableStream<Uint8Array>).getReader()
								streamedBody = new ReadableStream<Uint8Array>({
									start(controller) {
										bodyController = controller
									},
									async pull(controller) {
										try {
											const chunk = await reader.read()
											if (chunk.done) {
												bodyController = undefined
												cleanupAbort()
												controller.close()
											} else controller.enqueue(chunk.value)
										} catch (error) {
											bodyController = undefined
											cleanupAbort()
											controller.error(error)
										}
									},
									async cancel(reason) {
										bodyController = undefined
										cleanupAbort()
										incoming.destroy()
										nodeRequest.destroy()
										await reader.cancel(reason)
										responseBody.destroy()
									},
								})
							}
							if (emptyBody) incoming.resume()
							const result = new Response(streamedBody, {
								status,
								statusText: incoming.statusMessage,
								headers: responseHeaders,
							})
							Object.defineProperties(result, {
								url: { value: url.href },
								redirected: { value: redirects > 0 },
							})
							responseBody.once("close", () => {
								incoming.destroy()
								nodeRequest.destroy()
							})
							resolve(result)
						} catch (error) {
							cleanupAbort()
							incoming.destroy()
							nodeRequest.destroy()
							reject(error)
						}
					},
				)
				const onAbort = () => {
					const error = abortError(signal)
					bodyController?.error(error)
					bodyController = undefined
					cleanupAbort()
					decoded?.destroy(error)
					response?.destroy(error)
					nodeRequest.destroy(error)
				}
				signal.addEventListener("abort", onAbort, { once: true })
				nodeRequest.once("close", () => {
					clearTimeout(headersTimer)
					if (!bodyOwnsAbort) cleanupAbort()
					if (!response) reject(new Error("Provider connection closed before a response was received"))
				})
				nodeRequest.once("upgrade", (incoming, socket) => {
					incoming.destroy()
					socket.destroy()
					reject(new Error("Provider HTTP protocol upgrade is not supported"))
				})
				nodeRequest.on("error", reject)
				const onTimeout = () => {
					const cause = Object.assign(new Error("Provider connection timed out"), {
						code: response ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT",
					})
					const error = new TypeError("Provider request timed out", { cause })
					decoded?.destroy(error)
					response?.destroy(error)
					nodeRequest.destroy(error)
				}
				headersTimer = setTimeout(onTimeout, timeout)
				nodeRequest.setTimeout(timeout, onTimeout)
				if (signal.aborted) onAbort()
				else nodeRequest.end(payload)
			})
		}
	}
}
