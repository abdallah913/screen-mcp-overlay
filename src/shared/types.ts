/**
 * Types shared by the Electron main process, the preload bridges and both
 * renderers. Everything on the wire between MCP clients and the overlay is
 * expressed with these shapes.
 */

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Size {
    width: number;
    height: number;
}

/**
 * Which coordinate system a set of numbers is expressed in.
 *
 * - `image`      Pixels inside a specific capture's PNG. Requires a captureId.
 *                This is the space an agent naturally reads coordinates in
 *                after looking at a screenshot, so it is the default.
 * - `physical`   Physical device pixels, origin at the top-left of one display.
 * - `dip`        Device-independent pixels, origin at the top-left of one
 *                display. Equals `physical / scaleFactor`.
 * - `normalized` 0..1 fractions of one display's physical size.
 */
export type CoordSpace = 'image' | 'physical' | 'dip' | 'normalized';

export interface DisplayInfo {
    /** Stable string form of the Electron display id. */
    id: string;
    label: string;
    primary: boolean;
    /** Physical pixels per DIP. 1.5 on a typical 150%-scaled Windows laptop. */
    scaleFactor: number;
    /** Position and size in the global DIP desktop space. */
    dipBounds: Rect;
    /** Size of this display in physical pixels. */
    physicalSize: Size;
}

export interface CaptureRecord {
    id: string;
    displayId: string;
    /** Region of the display that was captured, in that display's physical px. */
    regionPhysical: Rect;
    /** Size of the PNG actually written to disk. */
    imageSize: Size;
    /** imageSize.width / regionPhysical.width. <1 when downscaled for tokens. */
    imageScale: number;
    path: string;
    createdAt: number;
    /**
     * Set when this came from a window render rather than a screen grab. Its
     * regionPhysical is still display-local, so image coordinates convert the
     * same way as for a screen capture.
     */
    windowRef?: string;
    /**
     * The window refused to render itself and the pixels came from the screen
     * instead, so anything covering it is in the image.
     */
    fallback?: boolean;
}

/**
 * One control as captured by describe_window. `key` is a structural path, not a
 * ref: refs are allocated per query and share nothing between calls, so they
 * cannot identify the same control twice.
 */
export interface SnapshotNode {
    key: string;
    indent: number;
    name: string;
    role: string;
    automationId?: string;
    value?: string;
    enabled: boolean;
    ref: string;
    rect: Rect;
    /** Comma-joined state words: checked, unchecked, selected, expanded, collapsed, focused. */
    state?: string;
    /** Scrolled out of view: real rect, but not where the user can see it. */
    offscreen?: boolean;
    /** Top node of an open popup (menu, dropdown) belonging to the window. */
    popup?: boolean;
}

export interface UiSnapshot {
    id: string;
    windowRef: string;
    at: number;
    nodes: SnapshotNode[];
}

/**
 * `done` is internal: the brief check mark that replaces a step's circle once
 * the step is met. Agents cannot draw it, so it is not in the annotate schema.
 */
export type ShapeType = 'box' | 'highlight' | 'circle' | 'arrow' | 'label' | 'spotlight' | 'step' | 'done';

/**
 * Ties an annotation to a live window or UI control instead of to fixed screen
 * pixels, so it follows its target as the user moves and resizes things.
 * Offsets are stored in physical pixels relative to the anchor's top-left.
 */
export interface AnchorSelector {
    window: string;
    name?: string;
    role?: string;
    /**
     * The app's own control id. Preferred over `name` when available: it does
     * not shift with localisation, label edits or layout changes, which is what
     * makes a selector exact rather than a fuzzy match.
     */
    automationId?: string;
}

export interface AnchorSpec {
    kind: 'window' | 'element';
    /** Opaque handle from the UI Automation helper. */
    ref: string;
    /**
     * What the target is called, as the user sees it: the control's name, or
     * a window anchor's title. Empty when it has none; never a ref.
     */
    label: string;
    /** The title of the window the target is in (a window anchor's own), to tell the user what a step waits for. */
    app?: string;
    /** Snap to the anchor's own rectangle rather than using `offset`. */
    fit: boolean;
    /** Physical pixels to grow a fitted rectangle by, so the box frames the target. */
    pad: number;
    offset?: Rect;
    /** Arrow head offset. Only meaningful for `arrow`. */
    toOffset?: Point;
    /**
     * How to find this control again. Element refs die with the helper and with
     * the application; a selector lets the tracker recover the anchor instead of
     * leaving the drawing orphaned.
     */
    selector?: AnchorSelector;
}

/**
 * One drawn annotation, already resolved into display-local DIPs. This is what
 * crosses into the renderer; the MCP layer converts into it from whatever
 * coordinate space the agent used.
 */
export interface Annotation {
    id: string;
    displayId: string;
    type: ShapeType;
    /** Geometry in display-local DIPs. Meaning depends on `type`. */
    rect: Rect;
    /** Arrow head position, display-local DIPs. Only for `arrow`. */
    to?: Point;
    text?: string;
    /** CSS color. Defaults are assigned per type when omitted. */
    color?: string;
    thickness?: number;
    /** 0..1 dim strength for `spotlight`. */
    dim?: number;
    /** Draw the eye: a short attention ping when it appears, moves or comes back. */
    pulse?: boolean;
    /** Wall-clock ms at which this annotation self-clears. */
    expiresAt?: number;
    createdAt: number;
    /** When set, geometry is recomputed from the live target each tick. */
    anchor?: AnchorSpec;
    /** True when the anchor's target is gone; kept so it returns if it comes back. */
    hidden?: boolean;
    /** When it became hidden, so long-gone targets can be retired. */
    hiddenSince?: number;
    /** Why the target went away: minimized, closed, other-desktop, or gone. */
    hiddenReason?: 'minimized' | 'closed' | 'other-desktop' | 'gone';
    /**
     * Titles of the windows covering the target. The renderer draws such a
     * shape so it cannot be mistaken for pointing at the covering window.
     */
    covered?: string;
    /**
     * The target is scrolled out of view or off every display. The renderer
     * points toward it instead of drawing on unrelated UI.
     */
    offscreen?: boolean;
    /** Left over from an idle client: drawn faded until someone clears it. */
    stale?: boolean;
    /** The pending step this belongs to, if any. */
    stepId?: string;
}

/**
 * The step the user is being asked to take, as the overlay and the panel show
 * it. There is at most one at a time; see src/main/steps.ts.
 *
 * - `click`: point at something; the overlay captures the click (the app does
 *   not receive it).
 * - `watch`: the user operates the app normally while the agent waits for the UI
 *   to change; the overlay stays click-through apart from the step strip.
 * - `choice`: pick one of `options`.
 */
export interface StepView {
    id: string;
    prompt: string;
    mode: 'click' | 'watch' | 'choice';
    /** Click mode: how many points to collect, and how many are in. */
    count: number;
    collected: number;
    options?: string[];
    startedAt: number;
    /** Wall-clock ms when the step times out. */
    deadline: number;
    /** "Step n of N", when the agent said where in a walkthrough this is. */
    progress?: { n: number; of: number };
    /** What is circled and where, e.g. `"Save" [button], top-left of "Notepad"`. */
    target?: string;
    /** The annotations that mark the step's target, for docking UI out of their way. */
    targetIds: string[];
    /**
     * Accelerators that answer this step, as labels for the UI to show (e.g.
     * "Ctrl+Shift+F9"). Only keys that actually registered are listed; Escape
     * cancels in click mode only.
     */
    keys: { done?: string; stuck?: string; cancel?: string };
}

/** What the user can answer from the overlay strip, the panel or a hotkey. */
export type UserAnswer =
    | { kind: 'done' }
    | { kind: 'stuck'; text?: string }
    | { kind: 'skip' }
    | { kind: 'reply'; text: string }
    | { kind: 'choice'; index: number };

/**
 * How a step ended. Never an error: Escape, silence and a typed reply are all
 * answers the agent should act on, not failures to retry.
 */
export type StepAnswer =
    | { kind: 'clicks'; clicks: ClickResult[]; complete: boolean }
    | { kind: 'done' }
    | { kind: 'stuck'; text?: string }
    | { kind: 'skip' }
    | { kind: 'reply'; text: string }
    | { kind: 'choice'; index: number; label: string }
    | { kind: 'cancelled'; by: 'esc' | 'clear' | 'client' | 'superseded'; partial: ClickResult[] }
    | { kind: 'timeout'; partial: ClickResult[] }
    /** The tool ended the step itself, e.g. because the awaited UI state arrived. */
    | { kind: 'ended' };

export interface ClickResult {
    /** Display the click landed on. */
    displayId: string;
    physical: Point;
    dip: Point;
    normalized: Point;
    /** Present when the request named a capture to map back into. */
    image?: Point;
}

/** `guide` is an instruction to the user, styled apart from audit and tool lines. */
export type HudRole = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'guide';

export interface HudMessage {
    id: string;
    role: HudRole;
    text: string;
    /** Set on assistant messages while tokens are still streaming in. */
    streaming?: boolean;
    at: number;
}

export interface OverlayState {
    /**
     * The display this overlay window covers. Sent explicitly because a click
     * report must name its display, and an overlay with nothing drawn on it
     * has no annotation to learn the id from.
     */
    displayId: string;
    annotations: Annotation[];
    step: StepView | null;
    /**
     * Display-local DIP rects the overlay must leave clear: the chat panel, so
     * a spotlight's scrim never dims the place the user types.
     */
    exclude: Rect[];
    /** The user's sound-cue preference. */
    cues: boolean;
}

export interface AppStatus {
    mcpUrl: string;
    mcpConnected: number;
    contentProtection: boolean;
    provider: string;
    busy: boolean;
}
