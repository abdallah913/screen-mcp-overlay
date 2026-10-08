import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerTools } from './tools/index.js';
import { listWindows } from '../uia.js';
import { windowLine } from '../../shared/windows.js';
import { store } from '../store.js';
import { settings } from '../settings.js';
import { noteRequest } from '../idle.js';

/**
 * The MCP surface is served over streamable HTTP on loopback rather than stdio.
 *
 * stdio would tie the overlay's lifetime to a single Claude Code session and
 * spawn a second copy of the app per client. Over HTTP the overlay is a
 * long-lived process that many clients share at once -- the Claude Code CLI,
 * the Claude Code VS Code extension, Cursor, Codex -- all pointing at the same
 * URL and driving the same screen.
 *
 * Each request gets a fresh McpServer in stateless mode. That is cheap because
 * no session state lives here: annotations, captures and pending clicks all
 * live in `store`, which is shared by every client.
 */

let boundUrl = '';
let boundPort = 0;
let portWasTaken = 0;
let activeRequests = 0;

/**
 * Sent once per connection and typically placed in the agent's system prompt,
 * so it carries the strategy the individual tool descriptions cannot: which
 * tool to reach for first, and the shape of a walkthrough.
 */
const INSTRUCTIONS =
    "See the user's screen and draw guidance on it; drawings are click-through. Any window parameter takes " +
    'a ref, a title substring or "foreground".\n' +
    'Read cheapest first: describe_window (text tree; since= for changes) > read_text (OCR, when the tree is ' +
    'empty) > capture_screen (only to see visuals).\n' +
    'Point by anchoring to the control, e.g. annotate anchor {window:"Notepad", name:"Save"}: drawings follow ' +
    'it. A miss lists the closest names.\n' +
    'Walkthroughs: for more than one step, say how many first. Then one highlight_and_wait per step (then: for ' +
    'a known path): prompt = one action in the app\'s own words, prefixed n/N ("2/5 Click Export"); until = a ' +
    'state only the user\'s action makes true, like the dialog it opens. Read its After block instead of ' +
    're-describing.\n' +
    'Results lead with a status word. Met: go on. NOT met / NOT started: re-read and rephrase, never repeat ' +
    'as is. STUCK: show them where. DONE, SKIPPED, REPLIED (their words): act on it. CANCELLED, NO RESPONSE: ' +
    'ask before drawing again.\n' +
    'The user is watching the app, not your chat: keep chat to a line, and clear drawings when done. ' +
    'wait_for_user_click when you cannot tell what they mean; show_message options for a quick question.';

export function buildServer(): McpServer {
    const server = new McpServer({ name: 'screen-mcp-overlay', version: '0.1.0' }, { instructions: INSTRUCTIONS });
    registerTools(server);
    compactToolList(server);
    registerResources(server);
    registerPrompts(server);
    return server;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: unknown[] }>;
let compactedList: { tools: unknown[] } | undefined;

/**
 * Strip schema noise from tools/list.
 *
 * The tool list is resent on every turn of every conversation, so anything in
 * it that tells the model nothing is paid for over and over. The SDK's zod
 * conversion adds two such things: a `$schema` URI on every tool, and
 * `+-9007199254740991` bounds on every integer without an explicit limit. Over
 * thirteen tools that is about 700 characters a turn.
 *
 * The list is also static, so it is built once rather than per request: every
 * request gets a fresh McpServer in stateless mode, and would otherwise redo the
 * zod-to-JSON-Schema conversion for every tool on every tools/list.
 *
 * This reaches into the SDK's handler map, which is not public API. If that ever
 * moves, the guard below falls back to the SDK's own (uncompacted) list, and the
 * token-budget test fails loudly.
 */
function compactToolList(server: McpServer): void {
    const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
    const original = handlers?.get('tools/list');
    if (!handlers || !original) return;
    handlers.set('tools/list', async (request, extra) => {
        if (!compactedList) {
            const listed = await original(request, extra);
            compactedList = { ...listed, tools: listed.tools.map(stripSchemaNoise) };
        }
        return compactedList;
    });
}

export function stripSchemaNoise(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(stripSchemaNoise);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === '$schema') continue;
        if ((k === 'maximum' || k === 'minimum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
        out[k] = stripSchemaNoise(v);
    }
    return out;
}

/**
 * The window list as a resource as well as a tool.
 *
 * A client that supports resources can keep it as ambient context and skip the
 * list_windows round trip entirely; one that does not simply ignores it. Same
 * data either way, so there is nothing to keep in sync.
 */
function registerResources(server: McpServer): void {
    server.registerResource(
        'windows',
        'screen://windows',
        {
            title: 'Open windows',
            description: 'Visible top-level windows: ref WxH@x,y title.',
            mimeType: 'text/plain'
        },
        async uri => {
            const body = (await listWindows()).map(windowLine).join('\n');
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'text/plain',
                        text: body || 'no visible windows'
                    }
                ]
            };
        }
    );
}

/** A starting prompt so the guidance loop does not have to be rediscovered. */
function registerPrompts(server: McpServer): void {
    server.registerPrompt(
        'guide_me_through',
        {
            title: 'Guide me through a task',
            description: 'Walk the user through a task on screen, drawing each step.',
            argsSchema: { task: z.string().describe('What the user is trying to do') }
        },
        ({ task }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text:
                            `Guide me through: ${task}\n\n` +
                            'Look first with describe_window, not a screenshot unless something visual matters, ' +
                            'and tell me in one line how many steps it will take. Then give one highlight_and_wait ' +
                            'per step: the control as the target, one action using its exact on-screen label as ' +
                            'the prompt, prefixed "n/N ", and until set to what proves I did it, never something ' +
                            'already true. Move on only when it is Met; otherwise look again and say it ' +
                            'differently. If I am STUCK, show me where it is. At the end, say what changed and ' +
                            'clear the screen.'
                    }
                }
            ]
        })
    );
}

/**
 * This endpoint can read the user's screen, so it is deliberately hostile to
 * browsers.
 *
 * There is no `Access-Control-Allow-Origin` header at all. An earlier version
 * sent `*`, which meant any web page the user visited could `fetch()` this
 * endpoint and read their screen. Browsers are rolling out Private Network
 * Access restrictions that would mitigate that, but they are not universally
 * enforced, and a wildcard ACAO is exactly the footgun those protections exist
 * to cover. Local MCP clients are not browsers: they never send `Origin` and
 * never need CORS, so omitting the header costs nothing and closes the hole.
 */
function isBrowserRequest(req: IncomingMessage): boolean {
    // Any real browser fetch carries one of these. Native agents carry neither.
    return Boolean(req.headers.origin || req.headers.referer);
}

/** Constant-time-ish comparison so a wrong token cannot be guessed byte by byte. */
function tokenMatches(supplied: string | undefined, expected: string): boolean {
    if (!supplied || supplied.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

function suppliedToken(req: IncomingMessage, url: URL): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    // Query form, because many MCP clients accept only a URL and no headers.
    return url.searchParams.get('key') ?? undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
        // Stateless: no session id, no per-session bookkeeping. All real state
        // is in `store`, so any request from any client sees the same screen.
        sessionIdGenerator: undefined,
        // Second line of defence: even with a valid token, only requests whose
        // Host header names loopback are accepted, so a rebound DNS name that
        // resolves to 127.0.0.1 cannot be used to reach this server.
        enableDnsRebindingProtection: true,
        allowedHosts: allowedHosts()
    });

    res.on('close', () => {
        void transport.close();
        void server.close();
        activeRequests = Math.max(0, activeRequests - 1);
    });

    activeRequests += 1;
    try {
        await server.connect(transport);
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req as IncomingMessage & { auth?: never }, res, body);
    } catch (err) {
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!res.writableEnded) {
            res.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: `internal error: ${(err as Error).message}` },
                    id: null
                })
            );
        }
    }
}

export interface McpServerHandle {
    url: string;
    port: number;
    close(): Promise<void>;
}

export function startMcpServer(preferredPort: number, host = '127.0.0.1'): Promise<McpServerHandle> {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

            // No CORS headers are ever sent, so a browser cannot read a response
            // even if it manages to make the request. Refusing outright is
            // clearer than letting it through and relying on that.
            if (isBrowserRequest(req)) {
                res.writeHead(403, { 'content-type': 'text/plain' });
                res.end('this endpoint does not serve browser requests');
                return;
            }

            if (req.method === 'OPTIONS') {
                // Only a browser preflights, and browsers are not welcome here.
                res.writeHead(405).end();
                return;
            }

            if (url.pathname === '/health') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ok: true,
                        name: 'screen-mcp-overlay',
                        mcpUrl: boundUrl,
                        // Deliberately no token and no screen contents here: this
                        // endpoint exists so tooling can check the app is alive.
                        annotations: store.list().length,
                        activeRequests
                    })
                );
                return;
            }

            if (url.pathname === '/mcp') {
                if (!tokenMatches(suppliedToken(req, url), settings().token)) {
                    res.writeHead(401, { 'content-type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            error: {
                                code: -32001,
                                message:
                                    'unauthorized: append ?key=<token> to the URL or send an ' +
                                    'Authorization: Bearer header. Run "npm run connect" or use the ' +
                                    'tray menu to copy the correct URL.'
                            },
                            id: null
                        })
                    );
                    return;
                }
                noteRequest();
                void handleMcp(req, res);
                return;
            }

            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found. MCP endpoint is /mcp');
        });

        // A foreign process on the preferred port used to leave the app running
        // with nothing working. Fall back to an ephemeral port and say so; the
        // registered config then needs updating, which the panel message covers.
        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
                portWasTaken = preferredPort;
                server.listen(0, host);
                return;
            }
            reject(err);
        });
        server.listen(preferredPort, host, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
            boundPort = port;
            boundUrl = `http://${host}:${port}/mcp`;
            resolve({
                url: boundUrl,
                port,
                close: () =>
                    new Promise<void>(done => {
                        server.close(() => done());
                    })
            });
        });
    });
}

function allowedHosts(): string[] {
    const port = boundPort || 7777;
    return [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'];
}

/** The bare endpoint, without credentials. */
export function mcpUrl(): string {
    return boundUrl;
}

/** The URL to hand to an agent: endpoint plus the token it must present. */
export function mcpAuthedUrl(): string {
    if (!boundUrl) return '';
    return `${boundUrl}?key=${settings().token}`;
}

export function mcpActiveRequests(): number {
    return activeRequests;
}

/** The port that was unavailable, when the server had to move. 0 otherwise. */
export function displacedPort(): number {
    return portWasTaken;
}

