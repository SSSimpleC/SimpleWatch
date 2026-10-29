interface CoordinationMessage {
  type: "request-voice";
  requester: string;
}

/** BroadcastChannel is notification only; the Web Lock is the mutual exclusion primitive. */
export class VoiceTabCoordinator {
  private readonly name: string;
  private readonly requester = globalThis.crypto.randomUUID();
  private readonly channel: BroadcastChannel | null;
  private releaseHeldLock: (() => void) | null = null;
  private pendingRequest: Promise<void> | null = null;
  private acquisition: Promise<boolean> | null = null;
  private acquisitionAbort: AbortController | null = null;
  private disposed = false;
  private yielding = false;

  constructor(
    accountId: string,
    private readonly onYield: () => Promise<void>,
  ) {
    this.name = `simplewatch.voice.owner:${accountId}`;
    this.channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(this.name);
    this.channel?.addEventListener("message", this.handleMessage);
  }

  get supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.locks?.request === "function"
    );
  }

  get owned(): boolean {
    return this.releaseHeldLock !== null;
  }

  acquire(takeover = false): Promise<boolean> {
    if (this.disposed || !this.supported) return Promise.resolve(false);
    if (this.owned) return Promise.resolve(true);
    if (this.acquisition) return this.acquisition;
    if (takeover && !this.channel) return Promise.resolve(false);
    const abort = new AbortController();
    this.acquisitionAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const acquisition = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      if (takeover) {
        this.channel?.postMessage({
          type: "request-voice",
          requester: this.requester,
        } satisfies CoordinationMessage);
        // A frozen owner must not be stolen from. The user can close that tab and retry.
        timeout = setTimeout(() => abort.abort(), 5_000);
      }
      try {
        this.pendingRequest = navigator.locks
          .request(
            this.name,
            takeover
              ? { mode: "exclusive", signal: abort.signal }
              : { mode: "exclusive", ifAvailable: true },
            async (lock) => {
              if (!lock || this.disposed || abort.signal.aborted) {
                finish(false);
                return;
              }
              await new Promise<void>((release) => {
                this.releaseHeldLock = release;
                finish(true);
              });
            },
          )
          .then(
            () => undefined,
            () => finish(false),
          );
      } catch {
        finish(false);
      }
    });
    this.acquisition = acquisition;
    void acquisition.finally(() => {
      if (this.acquisition === acquisition) this.acquisition = null;
      if (this.acquisitionAbort === abort) this.acquisitionAbort = null;
    });
    return acquisition;
  }

  release(): void {
    this.acquisitionAbort?.abort();
    const release = this.releaseHeldLock;
    this.releaseHeldLock = null;
    release?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.channel?.removeEventListener("message", this.handleMessage);
    this.channel?.close();
    this.release();
    await this.pendingRequest;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data as Partial<CoordinationMessage> | null;
    if (
      !message ||
      message.type !== "request-voice" ||
      typeof message.requester !== "string" ||
      message.requester === this.requester ||
      !this.owned ||
      this.yielding ||
      this.disposed
    )
      return;
    this.yielding = true;
    void this.onYield().then(
      () => {
        this.release();
        this.yielding = false;
      },
      () => {
        // Failed cleanup cannot safely transfer ownership. Let the requester time out.
        this.yielding = false;
      },
    );
  };
}
