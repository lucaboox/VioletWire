import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let changed = false;
    const unsubscribe = window.desktop.windowControls.onMaximizedChanged((value) => {
      changed = true;
      setMaximized(value);
    });
    void window.desktop.windowControls.getMaximized().then((value) => {
      if (!disposed && !changed) setMaximized(value);
    }).catch(() => undefined);
    return () => { disposed = true; unsubscribe(); };
  }, []);

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button aria-label="Minimize window" title="Minimize" type="button"
        onClick={() => void window.desktop.windowControls.minimize()}>
        <Minus aria-hidden="true" size={12} strokeWidth={1} />
      </button>
      <button aria-label={maximized ? "Restore window" : "Maximize window"}
        title={maximized ? "Restore" : "Maximize"} type="button"
        onClick={() => void window.desktop.windowControls.toggleMaximize()}>
        {maximized ? <Copy aria-hidden="true" size={12} strokeWidth={1} /> : <Square aria-hidden="true" size={11} strokeWidth={1} />}
      </button>
      <button className="window-close" aria-label="Close window" title="Close" type="button"
        onClick={() => void window.desktop.windowControls.close()}>
        <X aria-hidden="true" size={15} strokeWidth={1} />
      </button>
    </div>
  );
}
