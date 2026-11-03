import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./layout.css";
// Opt-in local profiling; no telemetry or persistent production state.
const profiling = new URLSearchParams(location.search).has("profile");
const content = profiling ? (
  <React.Profiler
    id="AppDock"
    onRender={(id, phase, actualDuration, baseDuration) => {
      window.dispatchEvent(
        new CustomEvent("appdock-profile", {
          detail: { id, phase, actualDuration, baseDuration },
        }),
      );
    }}
  >
    <App />
  </React.Profiler>
) : (
  <App />
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{content}</React.StrictMode>,
);
