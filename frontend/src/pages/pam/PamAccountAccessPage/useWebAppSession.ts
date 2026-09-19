import { useCallback, useEffect, useRef, useState } from "react";

import { createNotification } from "@app/components/notifications";
import { apiRequest } from "@app/config/request";

// Must match viewportWidth/viewportHeight in the gateway's web handler. The gateway renders at a
// fixed size and sends no resize events, so a mismatch would scale every input coordinate wrongly.
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const MSG_FRAME = 0x01;
const MSG_NAVIGATION = 0x02;
const MSG_INPUT = 0x10;

const HEADER_BYTES = 5;

const SESSION_FAILED_MESSAGE = "Unable to establish the remote session.";

type UseWebAppSessionOptions = {
  accountId: string;
  reason?: string;
  mfaSessionId?: string;
  onSessionEnd?: () => void;
};

type InputMessage = {
  kind: "mouse" | "key";
  action: string;
  x?: number;
  y?: number;
  button?: string;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  text?: string;
  keyCode?: number;
  modifiers?: number;
};

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

// Chromium expects the DOM modifier bitmask: alt=1, ctrl=2, meta=4, shift=8.
const modifierMask = (e: MouseEvent | KeyboardEvent) =>
  (e.altKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.metaKey ? 4 : 0) + (e.shiftKey ? 8 : 0);

export const useWebAppSession = ({
  accountId,
  reason,
  mfaSessionId,
  onSessionEnd
}: UseWebAppSessionOptions) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const decodingRef = useRef(false);
  const inboundRef = useRef<Uint8Array>(new Uint8Array(0));
  const pendingFrameRef = useRef<Uint8Array | null>(null);
  const generationRef = useRef(0);

  const [isConnected, setIsConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSessionEndRef = useRef(onSessionEnd);
  useEffect(() => {
    onSessionEndRef.current = onSessionEnd;
  }, [onSessionEnd]);

  const send = useCallback((message: InputMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const payload = new TextEncoder().encode(JSON.stringify(message));
    const buffer = new Uint8Array(HEADER_BYTES + payload.length);
    buffer[0] = MSG_INPUT;
    new DataView(buffer.buffer).setUint32(1, payload.length);
    buffer.set(payload, HEADER_BYTES);
    ws.send(buffer);
  }, []);

  // Frames can arrive faster than they decode. Only the newest is worth drawing, so an arrival
  // during a decode replaces the pending one rather than queueing behind it.
  const drawFrame = useCallback(async (payload: Uint8Array) => {
    pendingFrameRef.current = payload;
    if (decodingRef.current || !ctxRef.current) return;

    decodingRef.current = true;
    try {
      while (pendingFrameRef.current) {
        const next = pendingFrameRef.current;
        pendingFrameRef.current = null;
        // eslint-disable-next-line no-await-in-loop
        const bitmap = await createImageBitmap(new Blob([next], { type: "image/jpeg" }));
        ctxRef.current?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
    } catch {
      // A malformed frame is dropped; the next one supersedes it.
    } finally {
      decodingRef.current = false;
    }
  }, []);

  const teardown = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }
    setIsConnected(false);
  }, []);

  const connect = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    teardown();
    setError(null);
    generationRef.current += 1;
    const gen = generationRef.current;
    const isCurrent = () => gen === generationRef.current;

    ctxRef.current = canvas.getContext("2d");
    inboundRef.current = new Uint8Array(0);

    try {
      const { data } = await apiRequest.post<{ ticket: string }>(
        `/api/v1/pam/accounts/${accountId}/web-access-ticket`,
        { reason, mfaSessionId }
      );
      if (!isCurrent()) return;

      const { protocol, host } = window.location;
      const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${wsProtocol}//${host}/api/v1/pam/accounts/${accountId}/web-access?ticket=${encodeURIComponent(data.ticket)}`
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (isCurrent()) setIsConnected(true);
      };

      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (!isCurrent()) return;

        // The session lifecycle is negotiated in text frames (errors, policy refusals, session end)
        // while the stream itself is binary, so both arrive on the same socket.
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as { type?: string; reason?: string; data?: string };
            if (msg.type === "session_end") {
              setError(msg.reason || "Session ended");
            } else if (msg.data) {
              setError(msg.data.trim());
            }
          } catch {
            setError(event.data);
          }
          return;
        }

        if (!(event.data instanceof ArrayBuffer)) return;

        // The backend relays raw TCP, which does not preserve message boundaries: one websocket
        // message may carry a partial frame, several frames, or a split header. Accumulate and
        // drain complete messages instead of assuming one message per event.
        const incoming = new Uint8Array(event.data);
        const merged = new Uint8Array(inboundRef.current.length + incoming.length);
        merged.set(inboundRef.current);
        merged.set(incoming, inboundRef.current.length);

        let offset = 0;
        while (merged.length - offset >= HEADER_BYTES) {
          const view = new DataView(merged.buffer, merged.byteOffset + offset, HEADER_BYTES);
          const msgType = view.getUint8(0);
          const length = view.getUint32(1);
          if (merged.length - offset - HEADER_BYTES < length) break;

          const payload = merged.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
          offset += HEADER_BYTES + length;

          if (msgType === MSG_FRAME) {
            drawFrame(payload.slice()).catch(() => {});
          } else if (msgType === MSG_NAVIGATION) {
            try {
              const parsed = JSON.parse(new TextDecoder().decode(payload)) as { url?: string };
              if (parsed.url) setCurrentUrl(parsed.url);
            } catch {
              // Navigation is informational; a malformed one changes nothing.
            }
          }
        }

        inboundRef.current = merged.subarray(offset);
      };

      ws.onerror = () => {
        if (!isCurrent()) return;
        setError(SESSION_FAILED_MESSAGE);
      };

      ws.onclose = () => {
        if (!isCurrent()) return;
        setIsConnected(false);
        onSessionEndRef.current?.();
      };
    } catch (err) {
      if (!isCurrent()) return;
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        SESSION_FAILED_MESSAGE;
      setError(message);
      createNotification({ type: "error", text: message });
    }
  }, [accountId, reason, mfaSessionId, teardown, drawFrame]);

  // Mount-once, matching useRdpSession: every connect mints a ticket and creates a server-side PAM
  // session, so re-running this when a prop identity changes would strand real sessions.
  useEffect(() => {
    connect().catch(() => {});
    return () => {
      generationRef.current += 1;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // object-contain letterboxes the frame inside the element, so the element's box is not the drawn
  // area. Mapping through the box alone would offset every click by the letterbox margin.
  const toViewport = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / VIEWPORT_WIDTH, rect.height / VIEWPORT_HEIGHT);
    if (scale <= 0) return { x: 0, y: 0 };

    const offsetX = (rect.width - VIEWPORT_WIDTH * scale) / 2;
    const offsetY = (rect.height - VIEWPORT_HEIGHT * scale) / 2;

    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    return {
      x: clamp((clientX - rect.left - offsetX) / scale, VIEWPORT_WIDTH),
      y: clamp((clientY - rect.top - offsetY) / scale, VIEWPORT_HEIGHT)
    };
  }, []);

  const pointerPosition = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => toViewport(e.clientX, e.clientY),
    [toViewport]
  );

  const canvasHandlers = {
    onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = pointerPosition(e);
      send({ kind: "mouse", action: "move", x, y, modifiers: modifierMask(e.nativeEvent) });
    },
    onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = pointerPosition(e);
      send({
        kind: "mouse",
        action: "down",
        x,
        y,
        button: MOUSE_BUTTONS[e.button] ?? "left",
        clickCount: e.detail || 1,
        modifiers: modifierMask(e.nativeEvent)
      });
    },
    onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = pointerPosition(e);
      send({
        kind: "mouse",
        action: "up",
        x,
        y,
        button: MOUSE_BUTTONS[e.button] ?? "left",
        clickCount: e.detail || 1,
        modifiers: modifierMask(e.nativeEvent)
      });
    },
    onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      send({
        kind: "key",
        action: "down",
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text: e.key.length === 1 ? e.key : undefined,
        modifiers: modifierMask(e.nativeEvent)
      });
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      send({
        kind: "key",
        action: "up",
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        modifiers: modifierMask(e.nativeEvent)
      });
    }
  };

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = toViewport(e.clientX, e.clientY);
      send({
        kind: "mouse",
        action: "wheel",
        x,
        y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers: modifierMask(e)
      });
    },
    [send, toViewport]
  );

  // Registered natively because React's onWheel is passive, so preventDefault there cannot stop the
  // page itself from scrolling behind the session.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const disconnect = useCallback(() => {
    generationRef.current += 1;
    teardown();
    onSessionEndRef.current?.();
  }, [teardown]);

  return {
    canvasRef,
    canvasHandlers,
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    isConnected,
    currentUrl,
    error,
    disconnect,
    reconnect: connect
  };
};
