import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AdminPage } from "./pages/AdminPage.js";
import { HomePage } from "./pages/HomePage.js";
import { DiagnosticsPage } from "./pages/DiagnosticsPage.js";
import { RoomPage } from "./pages/RoomPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 3000 } },
});

createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join/:inviteToken" element={<HomePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener(
    "load",
    () => void navigator.serviceWorker.register("/sw.js"),
  );
}
