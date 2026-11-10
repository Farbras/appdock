import { initializeCatalog } from "./feature-api";
import { apps } from "./catalog";
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
void initializeCatalog(apps)
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>{content}</React.StrictMode>,
    );
  })
  .catch((e) => {
    const root = document.getElementById("root")!;
    root.textContent = "Не удалось согласовать каталог с ядром: " + String(e);
    const retry = document.createElement("button");
    retry.textContent = "Повторить запуск";
    retry.onclick = () => location.reload();
    root.append(retry);
  });
