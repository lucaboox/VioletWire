import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import "./react-tooltip.css";

const TOOLTIP_ATTRIBUTE = "data-violetwire-tooltip";
// Optional enlarged image shown above the tooltip text (badge zooms, link
// image previews). Height in CSS pixels; "large" opts into preview sizing.
const TOOLTIP_IMAGE_ATTRIBUTE = "data-violetwire-tooltip-image";
const TOOLTIP_IMAGE_HEIGHT_ATTRIBUTE = "data-violetwire-tooltip-image-height";
const TOOLTIP_LARGE_ATTRIBUTE = "data-violetwire-tooltip-large";
const TOOLTIP_DELAY = 320;
const VIEWPORT_MARGIN = 10;
const TOOLTIP_GAP = 8;

interface TooltipState {
  text: string;
  imageUrl?: string;
  imageHeight?: number;
  large?: boolean;
  target: HTMLElement;
  trigger: "focus" | "pointer";
}

function convertNativeTitles(root: ParentNode): void {
  const elements: Element[] = [];
  if (root instanceof Element && root.hasAttribute("title")) elements.push(root);
  elements.push(...root.querySelectorAll("[title]"));

  for (const element of elements) {
    const title = element.getAttribute("title")?.trim();
    element.removeAttribute("title");
    if (!title) continue;
    element.setAttribute(TOOLTIP_ATTRIBUTE, title);
    if (
      !element.hasAttribute("aria-label") &&
      !element.textContent?.trim() &&
      !(element instanceof HTMLImageElement && element.alt)
    ) {
      element.setAttribute("aria-label", title);
    }
  }
}

function tooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  return eventTarget instanceof Element
    ? eventTarget.closest<HTMLElement>(`[${TOOLTIP_ATTRIBUTE}]`)
    : null;
}

function positionTooltip(tooltip: TooltipState): CSSProperties {
  const targetBounds = tooltip.target.getBoundingClientRect();
  const estimatedWidth = tooltip.imageUrl
    ? tooltip.large
      ? 340
      : 120
    : Math.min(320, Math.max(70, tooltip.text.length * 7.2 + 22));
  const left = Math.min(
    window.innerWidth - VIEWPORT_MARGIN - estimatedWidth / 2,
    Math.max(VIEWPORT_MARGIN + estimatedWidth / 2, targetBounds.left + targetBounds.width / 2),
  );
  // Image tooltips are taller; flip below sooner so they stay on screen.
  const flipThreshold = tooltip.large ? 340 : tooltip.imageUrl ? 110 : 52;
  const showBelow = targetBounds.top < flipThreshold;
  return {
    left,
    top: showBelow ? targetBounds.bottom + TOOLTIP_GAP : targetBounds.top - TOOLTIP_GAP,
    transform: showBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
  };
}

export function ReactTooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const showTimer = useRef<number | null>(null);
  const refreshFrame = useRef<number | null>(null);
  const pointerPosition = useRef({ x: 0, y: 0 });

  const cancelPending = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    cancelPending();
    setTooltip(null);
  }, [cancelPending]);

  const schedule = useCallback(
    (target: HTMLElement, trigger: TooltipState["trigger"], immediate = false) => {
      cancelPending();
      const text = target.getAttribute(TOOLTIP_ATTRIBUTE)?.trim();
      if (!text || target.matches(":disabled")) return;
      const imageUrl = target.getAttribute(TOOLTIP_IMAGE_ATTRIBUTE)?.trim() || undefined;
      const rawHeight = Number(target.getAttribute(TOOLTIP_IMAGE_HEIGHT_ATTRIBUTE));
      const imageHeight =
        Number.isFinite(rawHeight) && rawHeight > 0 ? Math.min(320, rawHeight) : undefined;
      const large = target.hasAttribute(TOOLTIP_LARGE_ATTRIBUTE);
      const reveal = () => {
        showTimer.current = null;
        if (!target.isConnected) return;
        setTooltip({ target, text, imageUrl, imageHeight, large, trigger });
      };
      if (immediate) reveal();
      else showTimer.current = window.setTimeout(reveal, TOOLTIP_DELAY);
    },
    [cancelPending],
  );

  const refreshPosition = useCallback(() => {
    if (refreshFrame.current !== null) return;
    refreshFrame.current = window.requestAnimationFrame(() => {
      refreshFrame.current = null;
      setTooltip((current) => {
        if (!current?.target.isConnected) return null;
        if (current.trigger === "pointer") {
          const { x, y } = pointerPosition.current;
          const elementAtPointer = document.elementFromPoint(x, y);
          if (
            !elementAtPointer
            || (
              elementAtPointer !== current.target
              && !current.target.contains(elementAtPointer)
            )
          ) {
            return null;
          }
        }
        // A fresh object recalculates the target bounds in positionTooltip.
        return { ...current };
      });
    });
  }, []);

  useLayoutEffect(() => {
    convertNativeTitles(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          convertNativeTitles(record.target as Element);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) convertNativeTitles(node);
        }
      }
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["title"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    const onPointerOver = (event: PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      const target = tooltipTarget(event.target);
      if (target) schedule(target, "pointer");
    };
    const onPointerMove = (event: PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerOut = (event: PointerEvent) => {
      const current = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (current && current !== next) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target) schedule(target, "focus", true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const current = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (current && current !== next) hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      observer.disconnect();
      cancelPending();
      if (refreshFrame.current !== null) {
        window.cancelAnimationFrame(refreshFrame.current);
        refreshFrame.current = null;
      }
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [cancelPending, hide, refreshPosition, schedule]);

  return tooltip
    ? createPortal(
        <div
          className={
            tooltip.large
              ? "violetwire-react-tooltip has-preview"
              : "violetwire-react-tooltip"
          }
          role="tooltip"
          style={positionTooltip(tooltip)}
        >
          {tooltip.imageUrl && (
            <img
              alt=""
              className="violetwire-tooltip-image"
              decoding="async"
              key={tooltip.imageUrl}
              onError={(event) => {
                // A URL that turns out not to be an image degrades to text.
                event.currentTarget.style.display = "none";
              }}
              src={tooltip.imageUrl}
              style={tooltip.imageHeight ? { height: tooltip.imageHeight } : undefined}
            />
          )}
          {tooltip.text}
        </div>,
        document.body,
      )
    : null;
}
