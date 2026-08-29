import { z } from "zod";
export declare const PROTOCOL_VERSION: 1;
export declare const automationErrorCodes: readonly ["Timeout", "NotFound", "Ambiguous", "Protocol", "Closed", "Unsupported", "Security", "Cancelled"];
export type AutomationErrorCode = (typeof automationErrorCodes)[number];
export declare class AutomationError extends Error {
    readonly code: AutomationErrorCode;
    readonly data?: unknown;
    constructor(code: AutomationErrorCode, message: string, data?: unknown);
}
export declare const boundsSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export type ElementBounds = z.infer<typeof boundsSchema>;
export declare const treeNodeSchema: z.ZodType<TreeNode>;
export interface TreeNode {
    id: number;
    type: string;
    text?: string;
    testId?: string;
    style?: Record<string, unknown>;
    events?: string[];
    customProps?: Record<string, unknown>;
    bounds?: ElementBounds;
    children?: TreeNode[];
}
/** Single source of truth for method names, params, and results. */
export declare const methods: {
    readonly initialize: {
        readonly params: z.ZodObject<{
            protocolVersion: z.ZodLiteral<1>;
            client: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            protocolVersion: z.ZodLiteral<1>;
            pid: z.ZodNumber;
            capabilities: z.ZodArray<z.ZodEnum<{
                input: "input";
                screenshot: "screenshot";
                clock: "clock";
                tree: "tree";
            }>>;
            window: z.ZodObject<{
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly cancel: {
        readonly params: z.ZodObject<{
            id: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly click: {
        readonly params: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            button: z.ZodOptional<z.ZodNumber>;
            modifiers: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly mouseDown: {
        readonly params: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            button: z.ZodOptional<z.ZodNumber>;
            modifiers: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly mouseUp: {
        readonly params: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            button: z.ZodOptional<z.ZodNumber>;
            modifiers: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly mouseMove: {
        readonly params: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            pressedButton: z.ZodOptional<z.ZodNumber>;
            modifiers: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly scrollWheel: {
        readonly params: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            deltaX: z.ZodNumber;
            deltaY: z.ZodNumber;
            modifiers: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly keystrokes: {
        readonly params: z.ZodObject<{
            keys: z.ZodString;
            elementId: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly keyDown: {
        readonly params: z.ZodObject<{
            key: z.ZodString;
            isHeld: z.ZodOptional<z.ZodBoolean>;
            elementId: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly keyUp: {
        readonly params: z.ZodObject<{
            key: z.ZodString;
            elementId: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly focus: {
        readonly params: z.ZodObject<{
            elementId: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly blur: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly scrollTo: {
        readonly params: z.ZodObject<{
            elementId: z.ZodNumber;
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly getScrollOffset: {
        readonly params: z.ZodObject<{
            elementId: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            offset: z.ZodNullable<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
        }, z.core.$strip>;
    };
    readonly getTree: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            tree: z.ZodNullable<z.ZodType<TreeNode, unknown, z.core.$ZodTypeInternals<TreeNode, unknown>>>;
        }, z.core.$strip>;
    };
    readonly getPaintedText: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            text: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly getAllText: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            text: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly getBounds: {
        readonly params: z.ZodObject<{
            elementId: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            bounds: z.ZodNullable<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly getSelectedText: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            text: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly clearSelection: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            ok: z.ZodLiteral<true>;
        }, z.core.$strip>;
    };
    readonly screenshot: {
        readonly params: z.ZodObject<{
            path: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            path: z.ZodString;
        }, z.core.$strip>;
    };
    readonly clockPause: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            nowMs: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly clockSet: {
        readonly params: z.ZodObject<{
            nowMs: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            nowMs: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly clockFastForward: {
        readonly params: z.ZodObject<{
            deltaMs: z.ZodNumber;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            nowMs: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly clockResume: {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            nowMs: z.ZodNumber;
        }, z.core.$strip>;
    };
};
export type MethodName = keyof typeof methods;
export type ParamsOf<M extends MethodName> = z.infer<(typeof methods)[M]["params"]>;
export type ResultOf<M extends MethodName> = z.infer<(typeof methods)[M]["result"]>;
export type AutomationRequest<M extends MethodName = MethodName> = {
    [K in M]: {
        id: number;
        method: K;
        params: ParamsOf<K>;
    };
}[M];
export type AutomationSuccess<M extends MethodName = MethodName> = {
    [K in M]: {
        id: number;
        result: ResultOf<K>;
    };
}[M];
export interface AutomationFailure {
    id: number;
    error: {
        code: AutomationErrorCode;
        message: string;
        data?: unknown;
    };
}
export type AutomationResponse<M extends MethodName = MethodName> = AutomationSuccess<M> | AutomationFailure;
export declare const serverEventNames: readonly ["console", "frame", "closed"];
export type ServerEventName = (typeof serverEventNames)[number];
export type AutomationServerEvent = {
    event: "console";
    params: {
        text: string;
    };
} | {
    event: "frame";
    params: {
        n: number;
        path?: string;
    };
} | {
    event: "closed";
    params: {
        reason: string;
    };
};
export type WireMessage = AutomationRequest | AutomationResponse | AutomationServerEvent;
export declare function parseRequest(value: unknown): AutomationRequest;
export declare function parseResponse(value: unknown): AutomationResponse;
export declare function parseServerEvent(value: unknown): AutomationServerEvent;
export declare function parseWireMessage(value: unknown): WireMessage;
export declare function encodeSse(message: WireMessage): string;
export interface SseDecoder {
    feed(chunk: string): void;
}
export declare function createSseDecoder(onMessage: (message: WireMessage) => void, onInvalid?: (raw: string, error: unknown) => void): SseDecoder;
export declare function decodeSseChunk(chunk: string): WireMessage[];
//# sourceMappingURL=protocol.d.ts.map