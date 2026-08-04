import {
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { LinkPreview } from "../../shared/link-preview";
import "./react-tooltip.css";

const TOOLTIP_ATTRIBUTE = "data-violetwire-tooltip";
// Optional enlarged image shown above the tooltip text (badge zooms, link
// image previews). Height in CSS pixels; "large" opts into preview sizing.
const TOOLTIP_IMAGE_ATTRIBUTE = "data-violetwire-tooltip-image";
const TOOLTIP_IMAGE_HEIGHT_ATTRIBUTE = "data-violetwire-tooltip-image-height";
const TOOLTIP_LARGE_ATTRIBUTE = "data-violetwire-tooltip-large";
const LINK_PREVIEW_ATTRIBUTE = "data-violetwire-link-preview";
const TOOLTIP_DELAY = 320;
const VIEWPORT_MARGIN = 10;
const TOOLTIP_GAP = 8;

interface TooltipState {
  text: string;
  imageUrl?: string;
  imageHeight?: number;
  large?: boolean;
  linkPreview?: LinkPreview;
  target: HTMLElement;
  trigger: "focus" | "pointer";
}

interface ReactTooltipLayerProps {
  genericLinkPreviewsEnabled: boolean;
  genericLinkPreviewActivation: "hover" | "ctrl" | "alt";
  /**
   * A second document to watch, for chat rendered into a window of its own.
   * One layer serves both rather than each window running its own: a tooltip
   * is drawn into whichever document holds the thing being pointed at.
   */
  extraRoot?: Document | null;
}

/**
 * Whether a node is an element, without asking which window built it.
 * `instanceof` compares against this window's constructors, and chat can be
 * rendered into a window of its own — everything created over there is built
 * from that window's constructors and fails the comparison, so nothing there
 * was ever recognised.
 */
function asElement(value: unknown): Element | null {
  return value !== null &&
    typeof value === "object" &&
    (value as Node).nodeType === 1 /* Node.ELEMENT_NODE */
    ? (value as Element)
    : null;
}

function ownerDocumentOf(value: unknown): Document | null {
  const node = value as Node | null;
  return node && typeof node === "object" && typeof node.nodeType === "number"
    ? node.ownerDocument ?? (node as unknown as Document)
    : null;
}
function convertNativeTitles(root: ParentNode): void {
  const elements: Element[] = [];
  const asOwnElement = asElement(root);
  if (asOwnElement?.hasAttribute("title")) elements.push(asOwnElement);
  elements.push(...root.querySelectorAll("[title]"));

  for (const element of elements) {
    const title = element.getAttribute("title")?.trim();
    element.removeAttribute("title");
    if (!title) continue;
    element.setAttribute(TOOLTIP_ATTRIBUTE, title);
    if (
      !element.hasAttribute("aria-label") &&
      !element.textContent?.trim() &&
      !(element.tagName === "IMG" && element.getAttribute("alt"))
    ) {
      element.setAttribute("aria-label", title);
    }
  }
}

function tooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  return asElement(eventTarget)?.closest<HTMLElement>(`[${TOOLTIP_ATTRIBUTE}]`) ?? null;
}

// Measured against the window the tooltip is drawn in. Chat can be in a window
// of its own, and clamping to this window's width would put a tooltip outside
// a narrower one entirely.
function positionTooltip(tooltip: TooltipState, view: Window): CSSProperties {
  const targetBounds = tooltip.target.getBoundingClientRect();
  const longestTextLine = Math.max(...tooltip.text.split("\n").map((line) => line.length));
  const estimatedWidth = tooltip.linkPreview
    ? 340
    : tooltip.imageUrl
    ? tooltip.large
      ? 340
      : 120
    : Math.min(320, Math.max(70, longestTextLine * 7.2 + 22));
  const left = Math.min(
    view.innerWidth - VIEWPORT_MARGIN - estimatedWidth / 2,
    Math.max(VIEWPORT_MARGIN + estimatedWidth / 2, targetBounds.left + targetBounds.width / 2),
  );
  // Image tooltips are taller; flip below sooner so they stay on screen.
  const flipThreshold = tooltip.linkPreview || tooltip.large ? 340 : tooltip.imageUrl ? 110 : 52;
  const showBelow = targetBounds.top < flipThreshold;
  return {
    left,
    top: showBelow ? targetBounds.bottom + TOOLTIP_GAP : targetBounds.top - TOOLTIP_GAP,
    transform: showBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
  };
}

export function ReactTooltipLayer({
  genericLinkPreviewsEnabled,
  genericLinkPreviewActivation,
  extraRoot,
}: ReactTooltipLayerProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const roots = useMemo(
    () => (extraRoot ? [document, extraRoot] : [document]),
    [extraRoot],
  );
  const showTimer = useRef<number | null>(null);
  const refreshFrame = useRef<number | null>(null);
  const pointerPosition = useRef({ x: 0, y: 0 });
  const modifierState = useRef({ alt: false, ctrl: false });

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

  const loadLinkPreview = useCallback((
    target: HTMLElement,
    rawUrl: string,
    allowGeneric: boolean,
  ) => {
    void window.desktop.system.getLinkPreview(rawUrl, allowGeneric).then((linkPreview) => {
      if (!linkPreview || !target.isConnected) return;
      if (
        linkPreview.kind === "generic" &&
        (
          !genericLinkPreviewsEnabled ||
          (
            genericLinkPreviewActivation === "ctrl" &&
            !modifierState.current.ctrl
          ) ||
          (
            genericLinkPreviewActivation === "alt" &&
            !modifierState.current.alt
          )
        )
      ) {
        return;
      }
      setTooltip((current) =>
        current?.target === target ? { ...current, linkPreview } : current,
      );
    }).catch(() => undefined);
  }, [genericLinkPreviewActivation, genericLinkPreviewsEnabled]);

  const allowsGenericPreview = useCallback(
    (event?: Pick<MouseEvent, "altKey" | "ctrlKey">) =>
      genericLinkPreviewsEnabled &&
      (
        genericLinkPreviewActivation === "hover" ||
        (genericLinkPreviewActivation === "ctrl" && event?.ctrlKey === true) ||
        (genericLinkPreviewActivation === "alt" && event?.altKey === true)
      ),
    [genericLinkPreviewActivation, genericLinkPreviewsEnabled],
  );

  const schedule = useCallback(
    (
      target: HTMLElement,
      trigger: TooltipState["trigger"],
      immediate = false,
      allowGeneric = false,
    ) => {
      cancelPending();
      const text = target.getAttribute(TOOLTIP_ATTRIBUTE)?.trim();
      if (!text || target.matches(":disabled")) return;
      const imageUrl = target.getAttribute(TOOLTIP_IMAGE_ATTRIBUTE)?.trim() || undefined;
      const rawHeight = Number(target.getAttribute(TOOLTIP_IMAGE_HEIGHT_ATTRIBUTE));
      const imageHeight =
        Number.isFinite(rawHeight) && rawHeight > 0 ? Math.min(320, rawHeight) : undefined;
      const large = target.hasAttribute(TOOLTIP_LARGE_ATTRIBUTE);
      const linkPreviewUrl = target.getAttribute(LINK_PREVIEW_ATTRIBUTE);
      const reveal = () => {
        showTimer.current = null;
        if (!target.isConnected) return;
        setTooltip({ target, text, imageUrl, imageHeight, large, trigger });
        if (linkPreviewUrl) loadLinkPreview(target, linkPreviewUrl, allowGeneric);
      };
      if (immediate) reveal();
      else showTimer.current = window.setTimeout(reveal, TOOLTIP_DELAY);
    },
    [cancelPending, loadLinkPreview],
  );

  const refreshPosition = useCallback(() => {
    if (refreshFrame.current !== null) return;
    refreshFrame.current = window.requestAnimationFrame(() => {
      refreshFrame.current = null;
      setTooltip((current) => {
        if (!current?.target.isConnected) return null;
        if (current.trigger === "pointer") {
          const { x, y } = pointerPosition.current;
          const owner = current.target.ownerDocument;
          const elementAtPointer = owner.elementFromPoint(x, y);
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
    for (const watched of roots) convertNativeTitles(watched);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          convertNativeTitles(record.target as Element);
          continue;
        }
        for (const node of record.addedNodes) {
          const element = asElement(node);
          if (element) convertNativeTitles(element);
        }
      }
    });
    for (const watched of roots) observer.observe(watched.documentElement, {
      attributeFilter: ["title"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    const onPointerOver = (event: PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      modifierState.current = { alt: event.altKey, ctrl: event.ctrlKey };
      const target = tooltipTarget(event.target);
      if (target) schedule(target, "pointer", false, allowsGenericPreview(event));
    };
    const onPointerMove = (event: PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      modifierState.current = { alt: event.altKey, ctrl: event.ctrlKey };
    };
    const onPointerOut = (event: PointerEvent) => {
      const current = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (current && current !== next) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target) {
        schedule(
          target,
          "focus",
          true,
          genericLinkPreviewsEnabled && genericLinkPreviewActivation === "hover",
        );
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const current = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (current && current !== next) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      modifierState.current = { alt: event.altKey, ctrl: event.ctrlKey };
      if (
        event.repeat ||
        !genericLinkPreviewsEnabled ||
        (
          (genericLinkPreviewActivation !== "ctrl" || event.key !== "Control") &&
          (genericLinkPreviewActivation !== "alt" || event.key !== "Alt")
        )
      ) {
        return;
      }
      const { x, y } = pointerPosition.current;
      const target = tooltipTarget(
        (ownerDocumentOf(event.target) ?? document)
          ?.elementFromPoint(x, y) ?? null,
      );
      if (target?.hasAttribute(LINK_PREVIEW_ATTRIBUTE)) {
        schedule(target, "pointer", true, true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      modifierState.current = { alt: event.altKey, ctrl: event.ctrlKey };
      const releasedActivationKey =
        (genericLinkPreviewActivation === "ctrl" && event.key === "Control") ||
        (genericLinkPreviewActivation === "alt" && event.key === "Alt");
      if (!releasedActivationKey) return;
      setTooltip((current) =>
        current?.linkPreview?.kind === "generic"
          ? { ...current, linkPreview: undefined }
          : current,
      );
    };

    for (const watched of roots) watched.addEventListener("pointerover", onPointerOver, true);
    for (const watched of roots) watched.addEventListener("pointermove", onPointerMove, true);
    for (const watched of roots) watched.addEventListener("pointerout", onPointerOut, true);
    for (const watched of roots) watched.addEventListener("focusin", onFocusIn, true);
    for (const watched of roots) watched.addEventListener("focusout", onFocusOut, true);
    for (const watched of roots) watched.addEventListener("keydown", onKeyDown, true);
    for (const watched of roots) watched.addEventListener("keyup", onKeyUp, true);
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
      for (const watched of roots) watched.removeEventListener("pointerover", onPointerOver, true);
      for (const watched of roots) watched.removeEventListener("pointermove", onPointerMove, true);
      for (const watched of roots) watched.removeEventListener("pointerout", onPointerOut, true);
      for (const watched of roots) watched.removeEventListener("focusin", onFocusIn, true);
      for (const watched of roots) watched.removeEventListener("focusout", onFocusOut, true);
      for (const watched of roots) watched.removeEventListener("keydown", onKeyDown, true);
      for (const watched of roots) watched.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [
    allowsGenericPreview,
    cancelPending,
    genericLinkPreviewActivation,
    genericLinkPreviewsEnabled,
    hide,
    refreshPosition,
    schedule,
    roots,
  ]);

  return tooltip
    ? createPortal(
        <div
          className={
            tooltip.linkPreview || tooltip.large
              ? "violetwire-react-tooltip has-preview"
              : "violetwire-react-tooltip"
          }
          role="tooltip"
          style={positionTooltip(
            tooltip,
            tooltip.target.ownerDocument.defaultView ?? window,
          )}
        >
          {tooltip.linkPreview ? (
            <div className="violetwire-link-preview-card">
              {tooltip.linkPreview.thumbnailUrl && (
                <img
                  alt=""
                  className={
                    tooltip.linkPreview.thumbnailPresentation === "avatar"
                      ? "violetwire-tooltip-image is-avatar"
                      : "violetwire-tooltip-image"
                  }
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                  referrerPolicy="no-referrer"
                  src={tooltip.linkPreview.thumbnailUrl}
                />
              )}
              <strong>{tooltip.linkPreview.title}</strong>
              <span>{tooltip.linkPreview.author}</span>
              {tooltip.linkPreview.description && (
                <p>{tooltip.linkPreview.description}</p>
              )}
              {(tooltip.linkPreview.kind === "twitch-clip" ||
                tooltip.linkPreview.kind === "kick-clip") && (
                <small>
                  {formatDuration(tooltip.linkPreview.durationSeconds)} · {formatCount(tooltip.linkPreview.viewCount)} views · {formatDate(tooltip.linkPreview.createdAt)}
                </small>
              )}
            </div>
          ) : tooltip.imageUrl && (
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
          {tooltip.text.includes("\n") ? (
            <span className="violetwire-tooltip-lines">
              {tooltip.text.split("\n").map((line, index) =>
                index === 0 ? <strong key={line}>{line}</strong> : <span key={line}>{line}</span>,
              )}
            </span>
          ) : tooltip.text}
        </div>,
        tooltip.target.ownerDocument.body,
      )
    : null;
}

function formatDuration(value?: number): string {
  if (!value || value < 0) return "Clip";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatCount(value?: number): string {
  if (typeof value !== "number") return "0";
  return new Intl.NumberFormat().format(value);
}

function formatDate(value?: string): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : date.toLocaleDateString();
}
