/** Bounded single-payload publication; each command invocation owns its own instance. */
export const RESULT_MAX_BYTES = 64 * 1024 * 1024;
export class InvocationResult {
  private staged?: string;
  private committed = false;
  private store(payload: unknown, space?: string | number): void {
    if (this.committed) throw new Error("invocation result is already committed");
    const serialized = JSON.stringify(payload, null, space);
    if (serialized === undefined) throw new Error("invocation result must be JSON serializable");
    if (Buffer.byteLength(serialized, "utf8") > RESULT_MAX_BYTES) throw new Error("invocation result exceeds the size limit");
    this.staged = serialized;
  }
  readonly emitJson = (payload: unknown, space?: string | number): void => {
    if (this.staged !== undefined) throw new Error("invocation result is already staged");
    this.store(payload, space);
  };
  readonly fail = (message: string): void => { this.store({ error: message }, 2); };
  commit(write: (serialized: string) => void): void {
    if (this.committed) throw new Error("invocation result is already committed");
    this.committed = true;
    const output = this.staged;
    this.staged = undefined;
    if (output !== undefined) write(output);
  }
}
