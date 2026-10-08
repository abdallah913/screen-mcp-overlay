/**
 * When an MCP client was last heard from.
 *
 * The MCP layer is stateless, so "the agent has gone away" can only be inferred
 * from silence. Drawings left by a client whose conversation ended otherwise
 * stay on screen forever, pointing at things that no longer matter.
 */

let lastRequestAt = Date.now();

/** Called by the MCP server on every request. */
export function noteRequest(): void {
    lastRequestAt = Date.now();
}

export function msSinceLastRequest(): number {
    return Date.now() - lastRequestAt;
}
