import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerTools } from './tools.js';
import { listWindows } from '../uia.js';
import { store } from '../store.js';
import { settings } from '../settings.js';

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

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'screen-mcp-overlay', version: '0.1.0' },
        {
            instructions:
                "Inspect the user's screen and draw guidance onto it. Click-through, so drawings never block them.\n" +
                'Loop: list_windows -> describe_window -> annotate with anchor {kind:"name"} -> wait_for_element.\n' +
                'describe_window before capture_screen: text beats a ~1.8k-token image and yields anchorable refs. ' +
                'Capture only for visual questions or an empty tree (canvas, games, browser page content).\n' +
                'Anchor rather than using fixed coordinates; fixed ones go stale as soon as a window moves.\n' +
                'wait_for_element to sequence steps, timeoutMs:0 to assert state. wait_for_user_click when you ' +
                'cannot tell which element they mean.'
        }
    );
    registerTools(server);
    registerResources(server);
    registerPrompts(server);
    return server;
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
            description: 'Visible top-level windows with refs and rectangles.',
            mimeType: 'text/plain'
        },
        async uri => {
            const windows = await listWindows();
            const body = windows
                .map(w => `${w.ref}\t${w.rect.width}x${w.rect.height} @${w.rect.x},${w.rect.y}\t${w.title}`)
                .join('\n');
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
                            'Work one step at a time. For each step: find the control with describe_window or ' +
                            'find_ui_elements, draw it with annotate using anchor {kind:"name"} so the drawing ' +
                            'follows the window, tell me what to do in one sentence, then call wait_for_element ' +
                            'to wait until I have done it before moving on. Read the screen with describe_window ' +
                            'rather than screenshots unless you need to see something visual.'
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

