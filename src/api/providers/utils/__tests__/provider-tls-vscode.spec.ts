// kilocode_change - new file
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"

// Optional machine-specific integration. Run only a disposable Node subprocess,
// never the IDE application, extension host, user settings or user credentials.
const vscodeApp = "/Applications/Visual Studio Code.app/Contents"
const codeHelper = join(vscodeApp, "Frameworks/Code Helper.app/Contents/MacOS/Code Helper")
const vscodeModules = join(vscodeApp, "Resources/app/node_modules.asar")
const hostPatchAvailable = process.platform === "darwin" && existsSync(codeHelper) && existsSync(vscodeModules)

const program = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("http");
const https = require("https");
const tls = require("tls");
const net = require("net");
const zlib = require("node:zlib");
const patch = require("@vscode/proxy-agent");
const undici = require("undici");
const [bundle, fixtureDirectory] = process.argv.slice(1);
const key = fs.readFileSync(fixtureDirectory + "/key.pem");
const cert = fs.readFileSync(fixtureDirectory + "/cert.pem");
const sockets = new Set();
const servers = [];
const authorization = "Basic " + Buffer.from("local-fixture:only").toString("base64");
let proxyUrl = "";
let hostProxy = "DIRECT";
let proxySupport = "override";
let hostLookups = 0;
const proxyRequests = [];
const proxyErrors = [];
let cancelledResponseClosed = false;
let resolveCancelledResponse;
const cancelledResponse = new Promise(resolve => { resolveCancelledResponse = resolve; });

const params = {
  getProxyURL: () => proxyUrl,
  getProxySupport: () => proxySupport,
  getNoProxyConfig: () => [],
  isUseHostProxyEnabled: () => true,
  isAdditionalFetchSupportEnabled: () => true,
  addCertificatesV1: () => true,
  addCertificatesV2: () => false,
  loadAdditionalCertificates: async () => [],
  loadSystemCertificatesFromNode: () => false,
  resolveProxy: async () => { hostLookups++; return hostProxy; },
  lookupProxyAuthorization: async () => authorization,
  proxyResolveTelemetry: () => {},
  getLogLevel: () => patch.LogLevel.Off,
  log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  env: {},
};

function track(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}
async function listen(server) {
  servers.push(server);
  server.on("connection", track);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
function certificateError(error) {
  const codes = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.code === "string") codes.push(value.code);
    visit(value.cause);
    if (Array.isArray(value.errors)) value.errors.forEach(visit);
  };
  visit(error);
  return { error: true, codes, name: error.name, message: String(error.message) };
}
async function result(fetch, url, init) {
  try { const response = await fetch(url, init); return { status: response.status, body: await response.text() }; }
  catch (error) { return certificateError(error); }
}
function attachTunnel(proxy, targetPort, label) {
  proxy.on("connect", (request, client, head) => {
    proxyRequests.push({ label, authorization: request.headers["proxy-authorization"] });
    if (request.headers["proxy-authorization"] !== authorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="local"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!request.url.endsWith(":" + targetPort)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = track(net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    }));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
}

(async () => {
  const originalFetch = globalThis.fetch;
  await originalFetch("data:text/plain,initialize-native-dispatcher");
  const originalDispatcher = undici.getGlobalDispatcher();
  const originalTlsEnvironment = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const originals = { http: { ...http }, https: { ...https }, tls: { ...tls } };
  const resolver = patch.createProxyResolver(params);
  Object.assign(http, patch.createHttpPatch(params, originals.http, resolver.resolveProxyWithRequest));
  Object.assign(https, patch.createHttpPatch(params, originals.https, resolver.resolveProxyWithRequest));
  // PacProxyAgent deliberately wraps connection failures. Observe its public
  // event to prove an HTTPS-proxy failure is certificate validation, not DNS.
  const patchedHttpsRequest = https.request;
  https.request = (...args) => {
    const request = patchedHttpsRequest(...args);
    request.on("proxy", event => { if (event.error) proxyErrors.push(certificateError(event.error)); });
    return request;
  };
  Object.assign(tls, patch.createTlsPatch(params, originals.tls));
  globalThis.__vscodeOriginalFetch = originalFetch;
  globalThis.fetch = patch.createFetchPatch(params, originalFetch, resolver.resolveProxyURL);
  const { createProviderFetch } = require(bundle);

  const targetPort = await listen(https.createServer({ key, cert }, (request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip" }).end(zlib.gzipSync("fixture-ok"));
    } else if (request.url === "/idle" || request.url === "/cancel") {
      if (request.url === "/cancel") response.once("close", () => { cancelledResponseClosed = true; resolveCancelledResponse(); });
      response.writeHead(200);
      response.flushHeaders();
    } else response.end("fixture-ok");
  }));
  const origin = "https://127.0.0.1:" + targetPort;
  const strict = createProviderFetch({ baseUrl: origin, timeoutMs: 2000 });
  const insecure = createProviderFetch({ baseUrl: origin, allowInsecureTls: true, timeoutMs: 2000 });
  const output = { hostPatchVersion: require("@vscode/proxy-agent/package.json").version, results: {} };
  output.results.strictBefore = await result(strict, origin);
  output.results.optedIn = await result(insecure, origin);
  output.results.strictAfter = await result(strict, origin);
  output.results.compressedBody = await result(insecure, origin + "/gzip");
  output.results.bodyTimeout = await result(createProviderFetch({ baseUrl: origin, allowInsecureTls: true, timeoutMs: 100 }), origin + "/idle");
  const controller = new AbortController();
  const cancelResponse = await insecure(origin + "/cancel", { signal: controller.signal });
  const cancelBody = cancelResponse.text();
  controller.abort();
  output.results.cancelledBody = await cancelBody.then(body => ({ body }), certificateError);
  await Promise.race([cancelledResponse, new Promise((_, reject) => setTimeout(() => reject(new Error("Cancelled server response did not close")), 1000))]);
  output.cancelledResponseClosed = cancelledResponseClosed;

  const otherPort = await listen(https.createServer({ key, cert }, (_request, response) => response.end("must-not-read")));
  const other = "https://127.0.0.1:" + otherPort;
  const redirectPort = await listen(https.createServer({ key, cert }, (_request, response) => response.writeHead(302, { location: other }).end()));
  const redirect = "https://127.0.0.1:" + redirectPort;
  output.results.foreignOrigin = await result(insecure, other);
  output.results.foreignRedirect = await result(createProviderFetch({ baseUrl: redirect, allowInsecureTls: true, timeoutMs: 2000 }), redirect);

  const httpProxy = http.createServer();
  attachTunnel(httpProxy, targetPort, "http");
  const httpProxyPort = await listen(httpProxy);
  hostProxy = "PROXY 127.0.0.1:" + httpProxyPort;
  const routedOrigin = "https://provider-fixture.invalid:" + targetPort;
  output.results.routedStrictBefore = await result(createProviderFetch({ baseUrl: routedOrigin, timeoutMs: 2000 }), routedOrigin);
  proxySupport = "on"; // A custom agent would incorrectly bypass the host proxy in this mode.
  output.results.authenticatedHostProxy = await result(createProviderFetch({ baseUrl: routedOrigin, allowInsecureTls: true, timeoutMs: 2000 }), routedOrigin);
  proxySupport = "override";
  output.results.routedStrictAfter = await result(createProviderFetch({ baseUrl: routedOrigin, timeoutMs: 2000 }), routedOrigin);
  output.hostProxyLookups = hostLookups;

  const httpsProxy = https.createServer({ key, cert });
  attachTunnel(httpsProxy, targetPort, "https");
  const httpsProxyPort = await listen(httpsProxy);
  proxySupport = "override";
  proxyUrl = "https://127.0.0.1:" + httpsProxyPort;
  const secureProxyOrigin = "https://second-fixture.invalid:" + targetPort;
  output.results.untrustedHttpsProxy = await result(createProviderFetch({ baseUrl: secureProxyOrigin, allowInsecureTls: true, timeoutMs: 2000 }), secureProxyOrigin);
  output.proxyRequests = proxyRequests;
  output.proxyErrors = proxyErrors;
  output.expectedAuthorization = authorization;
  output.globalDispatcherUnchanged = undici.getGlobalDispatcher() === originalDispatcher;
  output.tlsEnvironmentUnchanged = process.env.NODE_TLS_REJECT_UNAUTHORIZED === originalTlsEnvironment;
  assert(output.globalDispatcherUnchanged && output.tlsEnvironmentUnchanged);
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  process.stdout.write(JSON.stringify(output), () => process.exit(0)); // Host proxy telemetry owns a long timer.
})().catch(error => {
  console.error(error);
  for (const socket of sockets) socket.destroy();
  process.exit(1);
});
`

describe.skipIf(!hostPatchAvailable)("provider TLS with the installed VS Code HTTP/fetch patches", () => {
	it("honors profile opt-out without bypassing host proxy routing or relaxing other origins/proxy certificates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ivol-provider-tls-vscode-"))
		try {
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-sha256",
					"-days",
					"1",
					"-subj",
					"/CN=localhost",
					"-keyout",
					join(directory, "key.pem"),
					"-out",
					join(directory, "cert.pem"),
				],
				{ stdio: "ignore" },
			)
			const bundle = join(directory, "provider-tls.cjs")
			await build({
				entryPoints: [join(__dirname, "../provider-tls.ts")],
				outfile: bundle,
				bundle: true,
				minify: true,
				platform: "node",
				format: "cjs",
				logLevel: "silent",
			})
			const environment: NodeJS.ProcessEnv = {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				NODE_PATH: vscodeModules,
			}
			// Isolate fixtures from real routing/TLS overrides inherited by the test runner.
			for (const key of [
				"HTTP_PROXY",
				"HTTPS_PROXY",
				"ALL_PROXY",
				"NO_PROXY",
				"http_proxy",
				"https_proxy",
				"all_proxy",
				"no_proxy",
				"GLOBAL_AGENT_HTTP_PROXY",
				"GLOBAL_AGENT_HTTPS_PROXY",
				"NODE_TLS_REJECT_UNAUTHORIZED",
				"NODE_EXTRA_CA_CERTS",
			])
				delete environment[key]
			const { stdout } = await promisify(execFile)(codeHelper, ["-e", program, bundle, directory], {
				env: environment,
				timeout: 25000,
			})
			const output = JSON.parse(stdout)
			for (const name of [
				"strictBefore",
				"strictAfter",
				"foreignOrigin",
				"foreignRedirect",
				"routedStrictBefore",
				"routedStrictAfter",
			]) {
				expect(output.results[name], `${name}: ${JSON.stringify(output.results)}`).toMatchObject({
					error: true,
					codes: expect.arrayContaining(["DEPTH_ZERO_SELF_SIGNED_CERT"]),
				})
			}
			expect(output.results.optedIn).toEqual({ status: 200, body: "fixture-ok" })
			expect(output.results.compressedBody).toEqual({ status: 200, body: "fixture-ok" })
			expect(output.results.bodyTimeout).toMatchObject({
				error: true,
				codes: expect.arrayContaining(["UND_ERR_BODY_TIMEOUT"]),
			})
			expect(output.results.cancelledBody).toMatchObject({ error: true, name: "AbortError" })
			expect(output.cancelledResponseClosed).toBe(true)
			expect(output.results.authenticatedHostProxy).toEqual({ status: 200, body: "fixture-ok" })
			expect(output.hostProxyLookups).toBeGreaterThan(0)
			expect(output.proxyRequests).toEqual(
				expect.arrayContaining([{ label: "http", authorization: output.expectedAuthorization }]),
			)
			expect(output.proxyRequests.some((request: { label: string }) => request.label === "https")).toBe(false)
			expect(output.results.untrustedHttpsProxy).toMatchObject({ error: true })
			expect(output.proxyErrors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ codes: expect.arrayContaining(["DEPTH_ZERO_SELF_SIGNED_CERT"]) }),
				]),
			)
			expect(output.globalDispatcherUnchanged).toBe(true)
			expect(output.tlsEnvironmentUnchanged).toBe(true)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}, 35000)
})
