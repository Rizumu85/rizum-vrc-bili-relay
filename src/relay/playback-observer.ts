import { hasActivePublisher, type PlaybackFlow, type StateTrace } from "./playback-flow";
import type { RelayStatus } from "./protocol";

/** One observation loop per owner, not per render/intent. A discarded result
 * retires one observation, never the obligation to watch a still-owned relay.
 * The flow serializes core reads with mutations and pins them to a generation.
 */
export class PlaybackObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly flow: PlaybackFlow,
    private readonly receive: (status: RelayStatus) => void,
    private readonly failed: (error: unknown) => void,
    private readonly trace: StateTrace = () => undefined,
  ) {
    this.unsubscribe = flow.subscribe(() => this.schedule());
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(retry = false): void {
    if (this.disposed) return;
    const status = this.flow.status;
    if (this.flow.busy || !hasActivePublisher(status)) {
      this.clearTimer();
      return;
    }
    if (this.inFlight || this.timer !== null) return;
    const delay = !retry && status?.stage === "starting" ? 700 : 2000;
    this.trace("ui_poll_scheduled", { operation_id: this.flow.epoch });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (this.flow.busy || !hasActivePublisher(this.flow.status)) return;
    this.inFlight = true;
    const epoch = this.flow.epoch;
    let retry = false;
    this.trace("ui_poll_started", { operation_id: epoch });
    try {
      const status = await this.flow.poll();
      if (!this.disposed && epoch === this.flow.epoch && status) {
        this.receive(status);
        this.trace("ui_poll_received", { operation_id: epoch });
      } else {
        this.trace("ui_poll_discarded", { operation_id: epoch });
      }
    } catch (error) {
      retry = true;
      if (!this.disposed && epoch === this.flow.epoch && hasActivePublisher(this.flow.status)) {
        this.failed(error);
        this.trace("ui_poll_failed", { operation_id: epoch });
      }
    } finally {
      this.inFlight = false;
      // Read the CURRENT owner even if this request belonged to an older
      // intent, returned null, or failed. No old UI closure decides liveness.
      this.schedule(retry);
    }
  }
}
