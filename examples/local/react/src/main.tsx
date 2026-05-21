import React from "react";
import ReactDOM from "react-dom/client";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import App from "./App";

// Registers <ai-agent> + <ai-message>. Idempotent — HMR-safe.
bootstrapAi();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
