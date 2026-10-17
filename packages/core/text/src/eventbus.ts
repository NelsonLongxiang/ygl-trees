/**
 * Cross-domain event bus — connects logEvent writes to real-time consumers.
 *
 * Architecture: a process-wide EventEmitter singleton. Write services call
 * `emitEvent()` after logEvent persists to the events table; consumers
 * (webui SSE, user plugins, future watchers) subscribe with `onEvent()`.
 *
 * This makes "ctx.on reactivity" real without requiring a full Cordis
 * event system — a lightweight bridge that the webui and plugins can use.
 *
 * @module @ygl/core-text/eventbus
 */
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(50); // SSE connections + plugins

export interface YglEvent {
  kind: string;       // e.g. "node.unlock", "kb.add", "claim.resolve"
  entity: string;     // e.g. "node", "kb", "claim"
  entityId: string;
  payload: string;
  ts: string;         // ISO timestamp
}

/** Publish a cross-domain event (called after events table write). */
export function emitEvent(evt: YglEvent): void {
  bus.emit("ygl", evt);
  bus.emit(`ygl:${evt.kind}`, evt); // specific subscription channel
}

/** Subscribe to all events. Returns an unsubscribe function. */
export function onEvent(handler: (evt: YglEvent) => void): () => void {
  bus.on("ygl", handler);
  return () => bus.off("ygl", handler);
}

/** Subscribe to a specific kind (e.g. "node.unlock"). Returns unsubscribe. */
export function onEventKind(kind: string, handler: (evt: YglEvent) => void): () => void {
  bus.on(`ygl:${kind}`, handler);
  return () => bus.off(`ygl:${kind}`, handler);
}
