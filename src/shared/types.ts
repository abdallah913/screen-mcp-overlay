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
}

export interface UiSnapshot {
    id: string;
    windowRef: string;
    at: number;
    nodes: SnapshotNode[];
}

export type ShapeType = 'box' | 'highlight' | 'circle' | 'arrow' | 'label' | 'spotlight' | 'step';

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
    label: string;
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
    /** Slow opacity pulse to draw the eye. */
    pulse?: boolean;
    /** Wall-clock ms at which this annotation self-clears. */
    expiresAt?: number;
    createdAt: number;
    /** When set, geometry is recomputed from the live target each tick. */
    anchor?: AnchorSpec;
    /** True when the anchor's target is gone; kept so it returns if it comes back. */
    hidden?: boolean;
}

export interface ClickRequest {
    id: string;
    prompt: string;
    /** How many points to collect before resolving. */
    count: number;
}

export interface ClickResult {
    /** Display the click landed on. */
    displayId: string;
    physical: Point;
    dip: Point;
    normalized: Point;
    /** Present when the request named a capture to map back into. */
    image?: Point;
}

export type HudRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export interface HudMessage {
    id: string;
    role: HudRole;
    text: string;
    /** Set on assistant messages while tokens are still streaming in. */
    streaming?: boolean;
    at: number;
}

export interface OverlayState {
    annotations: Annotation[];
    click: ClickRequest | null;
}

export interface AppStatus {
    mcpUrl: string;
    mcpConnected: number;
    contentProtection: boolean;
    provider: string;
    busy: boolean;
}
