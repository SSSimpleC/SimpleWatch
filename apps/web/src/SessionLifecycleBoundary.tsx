import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate } from "react-router";

import { clearLocalSession, SESSION_CHANNEL } from "./session-lifecycle.js";

export function SessionLifecycleBoundary() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "logout" ||
        !("version" in value) ||
        value.version !== 1
      )
        return;
      clearLocalSession(queryClient);
      void navigate("/", { replace: true });
    };
    return () => channel.close();
  }, [queryClient, navigate]);
  return null;
}
