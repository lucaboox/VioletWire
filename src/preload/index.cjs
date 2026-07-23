const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  player: {
    open: (channel, mode, quality) => ipcRenderer.invoke("player:open", channel, mode, quality),
    close: () => ipcRenderer.invoke("player:close"),
    setBounds: (bounds) => ipcRenderer.send("player:set-bounds", bounds),
    setChatBounds: (bounds) => ipcRenderer.send("player:set-chat-bounds", bounds),
    setChatVisible: (visible) => ipcRenderer.send("player:set-chat-visible", visible),
    setChatPresentation: (presentation) =>
      ipcRenderer.send("player:set-chat-presentation", presentation),
    setFullscreen: (fullscreen) => ipcRenderer.invoke("window:set-fullscreen", fullscreen),
    openChannelAction: (channel, action) => ipcRenderer.invoke("channel:open-action", channel, action),
    openSubscription: (channel, title) => ipcRenderer.invoke("twitch:open-subscription", channel, title),
    getNativeAvailability: () => ipcRenderer.invoke("native-player:get-availability"),
    getNativeQualities: (channel) => ipcRenderer.invoke("native-player:get-qualities", channel),
    setNativeQuality: (channel, quality) =>
      ipcRenderer.invoke("native-player:set-quality", channel, quality),
    controlNative: (command) => ipcRenderer.send("native-player:control", command),
    onNativeState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("native-player:state", handler);
      return () => ipcRenderer.removeListener("native-player:state", handler);
    },
    readyNativeControls: () => ipcRenderer.send("native-controls:ready"),
    setNativeControlsVisible: (visible) =>
      ipcRenderer.send("native-controls:set-visible", visible),
    setNativeControlsExpanded: (expanded) =>
      ipcRenderer.send("native-controls:set-expanded", expanded),
    setNativeControlsContext: (context) =>
      ipcRenderer.send("native-controls:set-context", context),
    sendNativeControlAction: (action) =>
      ipcRenderer.send("native-controls:action", action),
    onNativeControlsContext: (listener) => {
      const handler = (_event, context) => listener(context);
      ipcRenderer.on("native-controls:context", handler);
      return () => ipcRenderer.removeListener("native-controls:context", handler);
    },
    onNativeControlAction: (listener) => {
      const handler = (_event, action) => listener(action);
      ipcRenderer.on("native-controls:action", handler);
      return () => ipcRenderer.removeListener("native-controls:action", handler);
    },
  },
});
