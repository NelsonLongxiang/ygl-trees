/**
 * @ygl/web — React rich client for the ygl-trees workbench (spec R13.5).
 * DESIGN.md tokens are the single source of truth; colors here mirror them.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
