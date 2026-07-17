import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import { NativeControls } from "./NativeControls";
import "./controls.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NativeControls />
  </React.StrictMode>,
);
