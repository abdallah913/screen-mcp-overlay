/**
 * Loads the Claude Agent SDK, which is optional.
 *
 * It is deliberately excluded from the packaged app: the package is proprietary
 * ("(c) Anthropic PBC. All rights reserved"), so shipping it would put the
 * download under Anthropic's terms rather than this project's Apache-2.0
 * licence. A source build installs it from npm and the chat panel works; a
 * release build does not have it, and the panel has to say so in words a user
 * can act on rather than surfacing "Cannot find module".
 *
 * Nothing else depends on it. The MCP server, the tools, and every agent that
 * connects over HTTP behave identically either way.
 */

// ESM-only module imported from CJS, so the type query needs a resolution mode.
export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk', { with: { 'resolution-mode': 'import' } });

const PACKAGE = '@anthropic-ai/claude-agent-sdk';

let cached: SdkModule | undefined;

export async function loadSdk(): Promise<SdkModule> {
    if (!cached) cached = await import('@anthropic-ai/claude-agent-sdk');
    return cached;
}

/** Turn a load failure into something a user can act on. */
export function sdkUnavailable(err: unknown): string {
    const message = (err as Error)?.message ?? String(err);
    if (!/cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) {
        return `The built-in chat panel is unavailable: ${message}`;
    }
    return (
        `The built-in chat panel needs ${PACKAGE}, which is not bundled with the installer. ` +
        'Everything else works as normal — connect Claude Code, Cursor, or any MCP client to this ' +
        'overlay over HTTP. To use the panel as well, run the app from source after `npm install`.'
    );
}
