import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";

import { IconButton } from "@app/components/v3";
import { TSessionEvent } from "@app/hooks/api/pam";
import { isBrokenChunkMarker, TBrokenChunkMarker } from "@app/hooks/api/pam/session-playback";

import { parseWebLogEntry, WebEvent, WebReplayPlayer } from "./webReplayPlayer";

const CANVAS_W = 1280;
const CANVAS_H = 800;

const formatMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
};

type WebReplayEvent = TSessionEvent | TBrokenChunkMarker;

const parseRange = (events: WebReplayEvent[], start: number, end: number): WebEvent[] => {
  const out: WebEvent[] = [];
  for (let i = start; i < end; i += 1) {
    const event = events[i];
    if (!isBrokenChunkMarker(event)) {
      const ev = parseWebLogEntry(event);
      if (ev) out.push(ev);
    }
  }
  return out;
};

type Props = {
  events: WebReplayEvent[];
  isStreaming?: boolean;
  totalDurationMs?: number;
};

export const WebReplayView = ({ events, isStreaming = false, totalDurationMs }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<WebReplayPlayer | null>(null);
  const lastParsedIndexRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [lastSeenEventMs, setLastSeenEventMs] = useState(0);
  const [navigations, setNavigations] = useState<WebEvent[]>([]);

  const totalMs = totalDurationMs && totalDurationMs > 0 ? totalDurationMs : lastSeenEventMs;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || playerRef.current) return undefined;

    const parsed = parseRange(events, 0, events.length);
    lastParsedIndexRef.current = events.length;

    const player = new WebReplayPlayer(
      parsed,
      canvas,
      {
        onTick: setCurrentMs,
        onEnded: () => setIsPlaying(false),
        onBuffering: setIsBuffering
      },
      totalDurationMs
    );
    playerRef.current = player;

    setNavigations(parsed.filter((e) => e.type === "navigation"));
    setLastSeenEventMs(player.totalMs);
    if (!isStreaming) player.seek(0);

    return () => {
      player.dispose();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chunks keep arriving while a session is live, so new events are appended to the running player
  // rather than rebuilding it.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || events.length === lastParsedIndexRef.current) return;

    const more = parseRange(events, lastParsedIndexRef.current, events.length);
    lastParsedIndexRef.current = events.length;
    if (more.length) {
      player.appendEvents(more);
      setLastSeenEventMs(player.totalMs);
      const newNavigations = more.filter((e) => e.type === "navigation");
      if (newNavigations.length) setNavigations((prev) => [...prev, ...newNavigations]);
    }
  }, [events]);

  useEffect(() => {
    if (!isStreaming) playerRef.current?.markStreamComplete();
  }, [isStreaming]);

  const togglePlay = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  const restart = () => {
    playerRef.current?.seek(0);
    setCurrentMs(0);
  };

  const seekTo = (event: React.MouseEvent<HTMLDivElement>) => {
    const player = playerRef.current;
    if (!player || totalMs <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    player.seek(ratio * totalMs);
  };

  const progressPct = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="relative flex items-center justify-center overflow-hidden rounded-md bg-black">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="max-h-[70vh] w-full object-contain"
        />
        {isBuffering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2Icon className="size-6 animate-spin text-white" />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <IconButton ariaLabel={isPlaying ? "Pause" : "Play"} variant="outline" onClick={togglePlay}>
          {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </IconButton>
        <IconButton ariaLabel="Restart" variant="outline" onClick={restart}>
          <RotateCcwIcon className="size-4" />
        </IconButton>

        <div
          role="presentation"
          onClick={seekTo}
          className="group h-2 flex-1 cursor-pointer rounded-full bg-mineshaft-600"
        >
          <div
            className="h-full rounded-full bg-product-pam transition-[width] duration-75"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <span className="w-24 shrink-0 text-right font-mono text-xs text-muted">
          {formatMs(currentMs)} / {formatMs(totalMs)}
        </span>
      </div>

      {navigations.length > 0 && (
        <div className="rounded-md border border-border">
          <p className="border-b border-border px-3 py-2 text-xs font-medium">Pages visited</p>
          <ul className="max-h-40 overflow-y-auto">
            {navigations.map((nav) => (
              <li key={`${nav.elapsedMs}-${nav.url}`}>
                <button
                  type="button"
                  onClick={() => playerRef.current?.seek(nav.elapsedMs)}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-mineshaft-700"
                >
                  <span className="shrink-0 font-mono text-muted">{formatMs(nav.elapsedMs)}</span>
                  <span className="truncate">{nav.url}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default WebReplayView;
