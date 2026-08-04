import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import { App } from "./App";
import { PopoutChat } from "./PopoutChat";
import "./styles.css";

// The pop-out chat window loads this same bundle so it inherits the theme,
// emotes, and badges; the view it should show is named in the URL.
const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "chat" ? <PopoutChat /> : <App />}</React.StrictMode>,
);
