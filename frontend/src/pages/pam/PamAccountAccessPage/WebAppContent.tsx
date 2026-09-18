import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { ContentLoader } from "@app/components/v2";
import { Button } from "@app/components/v3";
import { TPamAccount } from "@app/hooks/api/pam";

import { DisconnectedScreen } from "./DisconnectedScreen";
import { useWebAppSession } from "./useWebAppSession";
import { WebAccessStatusCard } from "./WebAccessStatusCard";

type WebAppContentProps = {
  account: TPamAccount;
  reason?: string;
  mfaSessionId?: string;
};

export const WebAppContent = ({ account, reason, mfaSessionId }: WebAppContentProps) => {
  const [sessionEnded, setSessionEnded] = useState(false);

  const { canvasRef, canvasHandlers, viewport, isConnected, currentUrl, error, disconnect, reconnect } =
    useWebAppSession({
      accountId: account.id,
      reason,
      mfaSessionId,
      onSessionEnd: () => setSessionEnded(true)
    });

  const handleReconnect = () => {
    setSessionEnded(false);
    void reconnect();
  };

  const isConnecting = !isConnected && !error && !sessionEnded;

  let statusLabel = "Connecting";
  let statusDotClass = "bg-warning";
  if (isConnected) {
    statusLabel = "Connected";
    statusDotClass = "bg-success";
  } else if (error) {
    statusLabel = `Error: ${error}`;
    statusDotClass = "bg-danger";
  } else if (sessionEnded) {
    statusLabel = "Disconnected";
    statusDotClass = "bg-muted";
  }

  return (
    <div className="flex h-dvh w-screen flex-col bg-background">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={viewport.width}
          height={viewport.height}
          tabIndex={0}
          className="h-full w-full object-contain outline-none"
          {...canvasHandlers}
        />
        {isConnecting && (
          <ContentLoader text="Opening web application..." className="absolute inset-0 z-10 h-full" />
        )}
        {error && (
          <WebAccessStatusCard
            overlay
            tone="danger"
            icon={TriangleAlert}
            title="Connection failed"
            description={error}
          >
            <Button variant="pam" isFullWidth onClick={handleReconnect}>
              Reconnect
            </Button>
          </WebAccessStatusCard>
        )}
        {sessionEnded && !error && <DisconnectedScreen onReconnect={handleReconnect} />}
      </div>
      <div className="flex h-[33px] shrink-0 items-center justify-between border-t border-border bg-card px-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block size-2 rounded-full ${statusDotClass}`} />
          <span className="text-muted">{statusLabel}</span>
          {isConnected && (
            <button type="button" onClick={disconnect} className="ml-2 text-muted hover:text-danger">
              Disconnect
            </button>
          )}
        </span>
        <div className="flex items-center gap-4">
          {currentUrl && (
            <span className="max-w-md truncate">
              <span className="text-muted">URL:</span> <span className="text-muted">{currentUrl}</span>
            </span>
          )}
          <span>
            <span className="text-muted">Account:</span>{" "}
            <span className="text-muted">{account.name}</span>
          </span>
        </div>
      </div>
    </div>
  );
};
