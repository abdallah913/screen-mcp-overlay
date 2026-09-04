/**
 * The seam that keeps this app agent-agnostic.
 *
 * The overlay's tools are exposed over MCP, so any MCP-capable agent can drive
 * the screen from outside without going through this interface at all. This
 * interface exists only for the built-in chat panel: it is what a provider must
 * implement to be typed into directly from the overlay.
 */

export type AgentEvent =
    | { type: 'text-start'; id: string }
    | { type: 'text-delta'; id: string; delta: string }
    | { type: 'text-end'; id: string }
    | { type: 'thinking'; active: boolean }
    | { type: 'tool'; name: string; summary: string }
    | { type: 'notice'; text: string }
    | { type: 'error'; message: string }
    | { type: 'done'; costUsd?: number; turns?: number };

export interface SendInput {
    prompt: string;
    /** Provider-defined conversation handle, echoed back from a previous turn. */
    sessionId?: string;
}

export interface AgentProvider {
    readonly id: string;
    readonly label: string;

    /**
     * A human-readable reason the provider cannot run right now, or null when
     * it is ready. Checked before the first send so the panel can explain
     * itself instead of failing mid-stream.
     */
    check(): Promise<string | null>;

    /** Run one turn, emitting events as they arrive. Resolves when the turn ends. */
    send(input: SendInput, emit: (e: AgentEvent) => void): Promise<{ sessionId?: string }>;

    /** Stop the in-flight turn, if any. */
    interrupt(): Promise<void>;
}
