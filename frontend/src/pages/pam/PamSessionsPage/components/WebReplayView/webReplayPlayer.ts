export type WebEventType = "keyboard" | "mouse" | "navigation" | "target_frame";

export type WebEvent = {
  type: WebEventType;
  elapsedMs: number;
  action?: string;
  x?: number;
  y?: number;
  button?: string;
  wheelDelta?: number;
  key?: string;
  code?: string;
  text?: string;
  url?: string;
  payload?: Uint8Array;
};

type PlayerCallbacks = {
  onTick: (currentMs: number) => void;
  onEnded: () => void;
  onBuffering: (buffering: boolean) => void;
};

export class WebReplayPlayer {
  private events: WebEvent[];

  private canvas: HTMLCanvasElement;

  private ctx: CanvasRenderingContext2D;

  private callbacks: PlayerCallbacks;

  private index = 0;

  private clockMs = 0;

  private wallStart: number | null = null;

  private raf: number | null = null;

  private wantPlay = false;

  private streamComplete = false;

  private buffering = false;

  private pendingFrame: Uint8Array | null = null;

  private decoding = false;

  // Wall-clock length of the session, which exceeds the last event when the page sat idle. Playback
  // holds the final frame over that tail instead of ending early.
  private durationMs: number;

  constructor(
    events: WebEvent[],
    canvas: HTMLCanvasElement,
    callbacks: PlayerCallbacks,
    durationMs = 0
  ) {
    this.events = events;
    this.durationMs = durationMs;
    this.canvas = canvas;
    const c = canvas.getContext("2d");
    if (!c) throw new Error("2d context unavailable");
    this.ctx = c;
    this.callbacks = callbacks;
  }

  get totalMs(): number {
    const last = this.events[this.events.length - 1];
    return Math.max(last ? last.elapsedMs : 0, this.durationMs);
  }

  get currentMs(): number {
    return this.clockMs;
  }

  get isPlaying(): boolean {
    return this.wantPlay;
  }

  get isBuffering(): boolean {
    return this.buffering;
  }

  play = () => {
    if (this.wantPlay) return;
    if (this.streamComplete && this.index >= this.events.length && this.clockMs >= this.totalMs) {
      this.resetForReplay();
    }
    this.wantPlay = true;
    if (this.index >= this.events.length && !this.streamComplete) {
      this.setBuffering(true);
      return;
    }
    this.startRaf();
  };

  pause = () => {
    this.wantPlay = false;
    this.stopRaf();
    this.setBuffering(false);
  };

  restart = () => {
    this.resetForReplay();
    this.wantPlay = false;
  };

  // Every frame is a complete JPEG, so any moment can be rendered by drawing the most recent frame
  // at or before it. RDP has to replay from a keyframe here because its frames are deltas.
  seek = (targetMs: number) => {
    const clamped = Math.max(0, Math.min(targetMs, this.totalMs));
    this.stopRaf();
    this.clockMs = clamped;

    let frame: WebEvent | null = null;
    let nextIndex = 0;
    for (let i = 0; i < this.events.length; i += 1) {
      const ev = this.events[i];
      if (ev.elapsedMs > clamped) break;
      if (ev.type === "target_frame" && ev.payload) frame = ev;
      nextIndex = i + 1;
    }
    this.index = nextIndex;

    if (frame) {
      void this.drawFrame(frame.payload as Uint8Array);
    } else {
      this.clearCanvas();
    }

    this.callbacks.onTick(this.clockMs);
    if (this.wantPlay) this.startRaf();
  };

  appendEvents = (more: WebEvent[]) => {
    if (more.length === 0) return;
    this.events.push(...more);
    if (this.buffering && this.wantPlay) {
      this.setBuffering(false);
      this.startRaf();
    }
  };

  markStreamComplete = () => {
    if (this.streamComplete) return;
    this.streamComplete = true;
    if (this.buffering) {
      this.setBuffering(false);
      this.wantPlay = false;
      this.callbacks.onEnded();
    }
  };

  dispose = () => {
    this.stopRaf();
    this.wantPlay = false;
    this.buffering = false;
    this.pendingFrame = null;
  };

  private clearCanvas = () => {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  };

  private resetForReplay = () => {
    this.stopRaf();
    this.setBuffering(false);
    this.index = 0;
    this.clockMs = 0;
    this.clearCanvas();
    this.callbacks.onTick(0);
  };

  private startRaf = () => {
    if (this.raf !== null) return;
    this.wallStart = performance.now() - this.clockMs;
    this.tick();
  };

  private stopRaf = () => {
    if (this.raf === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.wallStart = null;
  };

  private setBuffering = (value: boolean) => {
    if (this.buffering === value) return;
    this.buffering = value;
    this.callbacks.onBuffering(value);
  };

  private tick = () => {
    if (this.wallStart === null) return;
    const now = performance.now();
    this.clockMs = now - this.wallStart;

    while (this.index < this.events.length && this.events[this.index].elapsedMs <= this.clockMs) {
      this.apply(this.events[this.index]);
      this.index += 1;
    }

    this.callbacks.onTick(this.clockMs);

    if (this.index >= this.events.length && this.clockMs >= this.totalMs) {
      this.raf = null;
      this.wallStart = null;
      if (this.streamComplete) {
        this.wantPlay = false;
        this.callbacks.onEnded();
      } else {
        this.setBuffering(true);
      }
      return;
    }

    this.raf = requestAnimationFrame(this.tick);
  };

  // Input and navigation events carry the audit trail rather than pixels: the frames already show
  // their result, so replay only has to draw.
  private apply = (ev: WebEvent) => {
    if (ev.type === "target_frame" && ev.payload) void this.drawFrame(ev.payload);
  };

  // Decoding is async while the tick loop is not, so a frame arriving mid-decode replaces the
  // pending one. Drawing the newest frame beats drawing every frame late.
  private drawFrame = async (payload: Uint8Array) => {
    this.pendingFrame = payload;
    if (this.decoding) return;

    this.decoding = true;
    try {
      while (this.pendingFrame) {
        const next = this.pendingFrame;
        this.pendingFrame = null;
        // eslint-disable-next-line no-await-in-loop
        const bitmap = await createImageBitmap(new Blob([next], { type: "image/jpeg" }));
        this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
        bitmap.close();
      }
    } catch {
      // A malformed frame is skipped; the next one supersedes it.
    } finally {
      this.decoding = false;
    }
  };
}

const decodeBase64ToUint8 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

export const parseWebLogEntry = (entry: unknown): WebEvent | null => {
  const e = entry as { data?: string; channelType?: string };
  if (e?.channelType !== "web" || typeof e.data !== "string") return null;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(atob(e.data));
  } catch {
    return null;
  }

  const type = rec.type as WebEventType | undefined;
  if (!type) return null;
  const elapsedMs = Number(rec.elapsedNs ?? 0) / 1e6;

  const ev: WebEvent = { type, elapsedMs };
  if (type === "target_frame") {
    const payloadB64 = rec.payload as string | undefined;
    if (payloadB64) ev.payload = decodeBase64ToUint8(payloadB64);
  } else if (type === "mouse") {
    ev.action = rec.action as string;
    ev.x = Number(rec.x ?? 0);
    ev.y = Number(rec.y ?? 0);
    ev.button = rec.button as string | undefined;
    ev.wheelDelta = Number(rec.wheelDelta ?? 0);
  } else if (type === "keyboard") {
    ev.action = rec.action as string;
    ev.key = rec.key as string | undefined;
    ev.code = rec.code as string | undefined;
    ev.text = rec.text as string | undefined;
  } else if (type === "navigation") {
    ev.url = rec.url as string | undefined;
  }
  return ev;
};
