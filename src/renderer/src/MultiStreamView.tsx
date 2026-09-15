import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Bookmark,
  ChevronLeft,
  GripVertical,
  Maximize,
  Maximize2,
  MessageSquare,
  MessageSquareOff,
  Minimize,
  Minimize2,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  MAX_MULTISTREAM_TILES,
  type MultiStreamTileState,
  type NativeQuality,
  type NativeQualityValue,
} from "../../shared/player";
import type { MultiStreamPreset } from "../../shared/preferences";
import type { FollowedChannel } from "../../shared/twitch";
import { channelKey, parseChannelKey, type Platform } from "../../shared/platform";
import { ProviderLogo } from "./ProviderLogo";
import { HlsNativeVideo } from "./HlsNativeVideo";
import "./multi-stream.css";

interface MultiStreamViewProps {
  tiles: MultiStreamTileState[];
  /** Tile ids in the arrangement the grid draws them in. */
  order: number[];
  /** Trade two tiles' cells, after a drop. */
  onSwap: (one: number, other: number) => void;
  /** Walk one tile `delta` cells along, from the keyboard. */
  onMove: (id: number, delta: number) => void;
  presets: MultiStreamPreset[];
  onSavePreset: (name: string) => void;
  /** Point a saved line-up at the streams that are open now. */
  onUpdatePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onOpenPreset: (preset: MultiStreamPreset) => void;
  chatVisible: boolean;
  onToggleChat: () => void;
  followedLive: FollowedChannel[];
  nameFor: (login: string) => string;
  tooltipFor: (channel: string) => string;
  controlsHideDelay: number;
  onAdd: (channel: string) => void;
  onRemove: (id: number) => void;
  onActivate: (id: number) => void;
  onToggleMute: (id: number) => void;
  onSetVolume: (id: number, volume: number) => void;
  onToggleCompressor: (id: number, enabled: boolean) => void;
  onSetQuality: (id: number, quality: NativeQualityValue) => void;
  theater: boolean;
  onToggleTheater: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onExit: () => void;
}

export function MultiStreamView({
  tiles,
  order,
  onSwap,
  onMove,
  presets,
  onSavePreset,
  onUpdatePreset,
  onDeletePreset,
  onOpenPreset,
  chatVisible,
  onToggleChat,
  followedLive,
  nameFor,
  tooltipFor,
  controlsHideDelay,
  onAdd,
  onRemove,
  onActivate,
  onToggleMute,
  onSetVolume,
  onToggleCompressor,
  onSetQuality,
  theater,
  onToggleTheater,
  fullscreen,
  onToggleFullscreen,
  onExit,
}: MultiStreamViewProps) {
  const [pickerOpen, setPickerOpen] = useState(tiles.length === 0);
  const [presetsOpen, setPresetsOpen] = useState(false);
  // The tile being dragged, and the one the pointer is over — only for the
  // highlight; the swap itself is decided on drop.
  const [draggedTile, setDraggedTile] = useState<number | null>(null);
  const [dropTile, setDropTile] = useState<number | null>(null);
  // The drop handler reads the ref, not the state: a drop that arrives before
  // React has re-rendered since the drag started would otherwise see no tile
  // being carried and quietly do nothing.
  const draggedTileRef = useRef<number | null>(null);
  const canAdd = tiles.length < MAX_MULTISTREAM_TILES;
  const canReorder = tiles.length > 1;
  const usedLogins = useMemo(() => new Set(tiles.map((tile) => tile.channel)), [tiles]);

  const startDrag = useCallback((id: number) => {
    draggedTileRef.current = id;
    setDraggedTile(id);
  }, []);

  const endDrag = useCallback(() => {
    draggedTileRef.current = null;
    setDraggedTile(null);
    setDropTile(null);
  }, []);

  const dropOnTile = useCallback(
    (id: number) => {
      const carried = draggedTileRef.current;
      if (carried !== null && carried !== id) onSwap(carried, id);
      endDrag();
    },
    [endDrag, onSwap],
  );

  // Close a bar menu when clicking anywhere outside it or its own toggle.
  useEffect(() => {
    if (!pickerOpen && !presetsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".multi-add-picker, .multi-add-toggle")) setPickerOpen(false);
      if (!target?.closest(".multi-preset-menu, .multi-preset-toggle")) setPresetsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [pickerOpen, presetsOpen]);

  return (
    <section className="multi-stream-page">
      <header className="multi-stream-bar">
        <div className="multi-stream-title">
          <button
            aria-label="Exit multistream"
            className="multi-back"
            onClick={onExit}
            title="Exit multistream"
            type="button"
          >
            <ChevronLeft size={24} />
          </button>
          <strong>Multistream</strong>
          <span>
            {tiles.length}/{MAX_MULTISTREAM_TILES} streams
          </span>
        </div>
        <div className="multi-stream-bar-actions">
          {canAdd && (
            <button
              className={pickerOpen ? "multi-bar-btn multi-add-toggle active" : "multi-bar-btn multi-add-toggle"}
              onClick={() => {
                setPresetsOpen(false);
                setPickerOpen((open) => !open);
              }}
              type="button"
            >
              <Plus size={16} /> Add stream
            </button>
          )}
          <button
            aria-expanded={presetsOpen}
            className={
              presetsOpen ? "multi-bar-btn multi-preset-toggle active" : "multi-bar-btn multi-preset-toggle"
            }
            onClick={() => {
              setPickerOpen(false);
              setPresetsOpen((open) => !open);
            }}
            title="Saved line-ups"
            type="button"
          >
            <Bookmark size={16} /> Presets
          </button>
          <button
            aria-pressed={chatVisible}
            className={chatVisible ? "multi-bar-btn active" : "multi-bar-btn"}
            onClick={onToggleChat}
            title={chatVisible ? "Hide chat" : "Show chat"}
            type="button"
          >
            {chatVisible ? <MessageSquare size={16} /> : <MessageSquareOff size={16} />} Chat
          </button>
          <button
            aria-pressed={theater}
            className={theater ? "multi-bar-btn active" : "multi-bar-btn"}
            onClick={onToggleTheater}
            title="Theater mode (T)"
            type="button"
          >
            {theater ? <Minimize2 size={16} /> : <Maximize2 size={16} />} Theater
          </button>
          <button
            aria-pressed={fullscreen}
            className={fullscreen ? "multi-bar-btn active" : "multi-bar-btn"}
            onClick={onToggleFullscreen}
            title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            type="button"
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />} Fullscreen
          </button>
          {pickerOpen && canAdd && (
            <AddStreamPicker
              followedLive={followedLive}
              usedLogins={usedLogins}
              onAdd={(login) => {
                onAdd(login);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
          {presetsOpen && (
            <PresetMenu
              canSave={tiles.length > 0}
              nameFor={nameFor}
              onClose={() => setPresetsOpen(false)}
              onDelete={onDeletePreset}
              onOpen={onOpenPreset}
              onSave={onSavePreset}
              onUpdate={onUpdatePreset}
              presets={presets}
            />
          )}
        </div>
      </header>

      <div className={`multi-grid count-${tiles.length}`}>
        {tiles.map((tile) => (
          <MultiTile
            key={tile.id}
            tile={tile}
            name={nameFor(tile.channel)}
            tooltip={tooltipFor(tile.channel)}
            platform={parseChannelKey(tile.channel).platform}
            controlsHideDelay={controlsHideDelay}
            position={Math.max(0, order.indexOf(tile.id))}
            positionCount={tiles.length}
            canReorder={canReorder}
            dragged={draggedTile === tile.id}
            dropTarget={dropTile === tile.id && draggedTile !== tile.id}
            onDragStart={startDrag}
            onDragEnd={endDrag}
            onDragOverTile={setDropTile}
            onDropTile={dropOnTile}
            onMove={onMove}
            onRemove={onRemove}
            onActivate={onActivate}
            onToggleMute={onToggleMute}
            onSetVolume={onSetVolume}
            onToggleCompressor={onToggleCompressor}
            onSetQuality={onSetQuality}
          />
        ))}
        {tiles.length === 0 && (
          <div className="multi-empty">
            <p>Add up to {MAX_MULTISTREAM_TILES} streams to watch them together.</p>
            <button onClick={() => setPickerOpen(true)} type="button">
              <Plus size={16} /> Add a stream
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

interface MultiTileProps {
  tile: MultiStreamTileState;
  name: string;
  tooltip: string;
  platform: Platform;
  controlsHideDelay: number;
  /** Which grid cell this tile is drawn in; the DOM order never changes. */
  position: number;
  positionCount: number;
  canReorder: boolean;
  dragged: boolean;
  dropTarget: boolean;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDragOverTile: (id: number) => void;
  onDropTile: (id: number) => void;
  onMove: (id: number, delta: number) => void;
  onRemove: (id: number) => void;
  onActivate: (id: number) => void;
  onToggleMute: (id: number) => void;
  onSetVolume: (id: number, volume: number) => void;
  onToggleCompressor: (id: number, enabled: boolean) => void;
  onSetQuality: (id: number, quality: NativeQualityValue) => void;
}

const MultiTile = memo(function MultiTile({
  tile,
  name,
  tooltip,
  platform,
  controlsHideDelay,
  position,
  positionCount,
  canReorder,
  dragged,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverTile,
  onDropTile,
  onMove,
  onRemove,
  onActivate,
  onToggleMute,
  onSetVolume,
  onToggleCompressor,
  onSetQuality,
}: MultiTileProps) {
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [qualities, setQualities] = useState<NativeQuality[]>([]);
  // Controls auto-hide exactly like the single player: they start visible, hide
  // after the configured delay of no movement, reveal on pointer move, and hide
  // immediately when the pointer leaves the tile. The cursor hides with them.
  const [controlsShown, setControlsShown] = useState(true);
  const hideTimer = useRef<number | null>(null);

  const revealControls = useCallback(() => {
    setControlsShown(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsShown(false), controlsHideDelay);
  }, [controlsHideDelay]);

  const hideControls = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setControlsShown(false);
  }, []);

  // Start the initial hide countdown on mount, like the single player.
  useEffect(() => {
    hideTimer.current = window.setTimeout(() => setControlsShown(false), controlsHideDelay);
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [controlsHideDelay]);

  // The quality popover keeps the bar up while it's open.
  const barVisible = controlsShown || qualityMenuOpen;

  const { status, error } = tile.state;

  // Fetch the quality list as soon as the tile is playing instead of when the
  // menu opens. The list comes from a Streamlink run that takes seconds, which
  // is why opening the menu used to sit on "Loading…". Waiting for playback
  // keeps that run clear of starting the stream; a menu opened before then
  // still asks for it, for a tile that never got going.
  useEffect(() => {
    if (qualities.length > 0) return;
    if (status !== "playing" && !qualityMenuOpen) return;
    let cancelled = false;
    void window.desktop.player
      .getNativeQualities(tile.channel)
      .then((list) => {
        if (!cancelled) setQualities(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status, qualityMenuOpen, qualities.length, tile.channel]);

  const offline = error === "Stream is offline." || /offline|no playable streams/i.test(error ?? "");
  const showOverlay = status !== "playing";

  return (
    <div
      className={[
        "multi-tile",
        tile.active ? "active" : "",
        barVisible ? "" : "controls-hidden",
        position === 0 ? "lead" : "",
        dragged ? "dragged" : "",
        dropTarget ? "drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ order: position }}
      onDragOver={(event) => {
        if (!canReorder || dragged) return;
        // Without this the browser refuses the drop and no drop event fires.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverTile(tile.id);
      }}
      onDrop={(event) => {
        if (!canReorder) return;
        event.preventDefault();
        onDropTile(tile.id);
      }}
      onClick={() => onActivate(tile.id)}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        if (event.target instanceof Element && event.target.closest("button, input")) return;
        event.preventDefault();
        onToggleMute(tile.id);
        revealControls();
      }}
      onMouseDown={(event) => {
        if (
          event.button === 1 &&
          !(event.target instanceof Element && event.target.closest("button, input"))
        ) {
          event.preventDefault();
        }
      }}
      onMouseMove={revealControls}
      onMouseLeave={hideControls}
    >
      <HlsNativeVideo
        key={tile.state.hlsSource?.sessionId ?? `pending-${tile.id}`}
        state={tile.state}
        target={`multi-${tile.id}`}
      />
      {showOverlay && (
        <div className="multi-tile-overlay">
          <span className={`native-status-orb ${offline ? "offline" : status}`} />
          <strong>
            {offline
              ? `${name} is offline`
              : status === "error"
                ? "Could not start"
                : `Loading ${name}`}
          </strong>
          {status === "error" && !offline && error && <p>{error}</p>}
        </div>
      )}
      {/* The name plate doubles as the grip: drag it onto another stream to
          trade places, or focus it and walk the stream along with the arrow
          keys. Dragging the tile itself would fight the volume slider. */}
      <div
        aria-label={
          canReorder
            ? `${name}, stream ${position + 1} of ${positionCount}. Drag onto another stream to swap places, or use the left and right arrow keys.`
            : undefined
        }
        className="multi-tile-name-box"
        draggable={canReorder}
        onDragEnd={onDragEnd}
        onDragStart={(event) => {
          if (!canReorder) return;
          event.dataTransfer.effectAllowed = "move";
          // A drag only starts once the transfer carries something.
          event.dataTransfer.setData("text/plain", String(tile.id));
          onDragStart(tile.id);
        }}
        onKeyDown={(event) => {
          if (!canReorder) return;
          const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          if (delta === 0) return;
          event.preventDefault();
          onMove(tile.id, delta);
        }}
        role={canReorder ? "button" : undefined}
        tabIndex={canReorder ? 0 : undefined}
        title={canReorder ? "Drag onto another stream to swap places" : undefined}
      >
        {canReorder && <GripVertical aria-hidden="true" className="multi-tile-grip" size={13} />}
        {tile.active && <span className={`multi-tile-live-dot ${platform}`} title="Audio playing" />}
        <ProviderLogo name={platform} />
        <span className="multi-tile-name" title={tooltip}>{name}</span>
      </div>
      <div className="multi-tile-controls" onClick={(event) => event.stopPropagation()}>
        <button
          aria-label={tile.state.muted ? "Unmute" : "Mute"}
          className="multi-tile-btn"
          onClick={() => onToggleMute(tile.id)}
          title={tile.state.muted ? "Unmute" : "Mute"}
          type="button"
        >
          {tile.state.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <input
          aria-label="Volume"
          className="multi-tile-volume"
          max="100"
          min="0"
          onChange={(event) => onSetVolume(tile.id, Number(event.target.value))}
          type="range"
          value={tile.state.volume}
        />
        <button
          aria-label={
            tile.state.compressorEnabled ? "Disable audio compressor" : "Enable audio compressor"
          }
          aria-pressed={tile.state.compressorEnabled}
          className="multi-tile-btn"
          onClick={() => onToggleCompressor(tile.id, !tile.state.compressorEnabled)}
          title="Audio compressor"
          type="button"
        >
          <span className={`icon-toggle${tile.state.compressorEnabled ? "" : " off"}`}>
            <AudioLines size={14} />
          </span>
        </button>
        <div className="multi-tile-quality">
          <button
            aria-label="Quality"
            className={qualityMenuOpen ? "multi-tile-btn active" : "multi-tile-btn"}
            onClick={() => setQualityMenuOpen((open) => !open)}
            title="Change quality"
            type="button"
          >
            <Settings size={14} />
          </button>
          {qualityMenuOpen && (
            <div className="multi-tile-quality-menu">
              {qualities.length === 0 ? (
                <span className="multi-tile-quality-loading">Loading…</span>
              ) : (
                qualities.map((quality) => (
                  <button
                    className={
                      tile.state.quality === quality.value
                        ? "multi-tile-quality-option active"
                        : "multi-tile-quality-option"
                    }
                    key={quality.value}
                    onClick={() => {
                      onSetQuality(tile.id, quality.value);
                      setQualityMenuOpen(false);
                    }}
                    type="button"
                  >
                    {quality.label}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          aria-label={`Remove ${name}`}
          className="multi-tile-btn multi-tile-remove"
          onClick={() => onRemove(tile.id)}
          title="Remove stream"
          type="button"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
});

interface AddStreamPickerProps {
  followedLive: FollowedChannel[];
  usedLogins: Set<string>;
  onAdd: (login: string) => void;
  onClose: () => void;
}

function AddStreamPicker({ followedLive, usedLogins, onAdd, onClose }: AddStreamPickerProps) {
  const [query, setQuery] = useState("");
  // The service to add the typed name on. The logo before the field toggles it;
  // Twitch by default. Typing an explicit "twitch:"/"kick:" flips it too.
  const [scope, setScope] = useState<Platform>("twitch");
  const available = useMemo(
    () => followedLive.filter((channel) => !usedLogins.has(channel.login)),
    [followedLive, usedLogins],
  );

  const submit = () => {
    const name = query.trim().toLowerCase();
    if (name) onAdd(channelKey(scope, name));
  };

  return (
    <div className="multi-add-picker" role="dialog" aria-label="Add a stream">
      <div className="multi-add-field">
        <button
          aria-label={`Adding on ${scope === "kick" ? "Kick" : "Twitch"}. Click to switch service.`}
          className={`multi-add-service ${scope}`}
          onClick={() => setScope((current) => (current === "kick" ? "twitch" : "kick"))}
          title={`Adding on ${scope === "kick" ? "Kick" : "Twitch"} — click to switch`}
          type="button"
        >
          <ProviderLogo name={scope} />
        </button>
        <input
          aria-label="Add channel by name"
          autoFocus
          onChange={(event) => {
            const prefix = /^(twitch|kick):(.*)$/i.exec(event.target.value);
            if (prefix) {
              setScope(prefix[1].toLowerCase() as Platform);
              setQuery(prefix[2]);
            } else {
              setQuery(event.target.value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter") submit();
          }}
          placeholder={`Add a ${scope === "kick" ? "Kick" : "Twitch"} channel…`}
          type="text"
          value={query}
        />
      </div>
      <div className="multi-add-list">
        {available.map((channel) => (
          // The avatar carries its service's colour — purple for Twitch, green
          // for Kick — since the list mixes both and the names alone don't say.
          <button
            className={`service-ring ${parseChannelKey(channel.login).platform}`}
            key={channel.login}
            onClick={() => onAdd(channel.login)}
            type="button"
          >
            {channel.profileImageUrl && <img alt="" src={channel.profileImageUrl} />}
            <span className="multi-add-name">{channel.displayName}</span>
            <span className="multi-add-game">{channel.category || "Live"}</span>
          </button>
        ))}
        {available.length === 0 && (
          <p className="multi-add-empty">
            <RotateCcw size={13} /> No more live followed channels — type a name above.
          </p>
        )}
      </div>
    </div>
  );
}

interface PresetMenuProps {
  presets: MultiStreamPreset[];
  /** False with an empty grid, where there is no line-up to name. */
  canSave: boolean;
  nameFor: (login: string) => string;
  onSave: (name: string) => void;
  onUpdate: (name: string) => void;
  onDelete: (name: string) => void;
  onOpen: (preset: MultiStreamPreset) => void;
  onClose: () => void;
}

/** Save the streams that are up under a name, and bring a saved set back. */
function PresetMenu({
  presets,
  canSave,
  nameFor,
  onSave,
  onUpdate,
  onDelete,
  onOpen,
  onClose,
}: PresetMenuProps) {
  const [name, setName] = useState("");

  const submit = () => {
    if (!canSave || name.trim().length === 0) return;
    onSave(name);
    setName("");
    onClose();
  };

  return (
    <div className="multi-add-picker multi-preset-menu" role="dialog" aria-label="Multistream presets">
      <div className="multi-add-field">
        <input
          aria-label="Name for the streams that are open"
          autoFocus
          disabled={!canSave}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter") submit();
          }}
          placeholder={canSave ? "Name these streams…" : "Add a stream first"}
          type="text"
          value={name}
        />
        <button
          className="multi-preset-save"
          disabled={!canSave || name.trim().length === 0}
          onClick={submit}
          type="button"
        >
          <Save size={14} /> Save
        </button>
      </div>
      <div className="multi-add-list">
        {presets.map((preset) => (
          <div className="multi-preset-row" key={preset.name}>
            <button
              className="multi-preset-open"
              onClick={() => {
                onOpen(preset);
                onClose();
              }}
              type="button"
            >
              <span className="multi-preset-name">{preset.name}</span>
              <span className="multi-preset-channels">
                {preset.channels.map((channel) => nameFor(channel)).join(" · ")}
              </span>
            </button>
            <button
              aria-label={`Save the open streams into the ${preset.name} preset`}
              className="multi-preset-update"
              disabled={!canSave}
              onClick={() => onUpdate(preset.name)}
              title="Save the streams that are open into this preset"
              type="button"
            >
              <Save size={13} />
            </button>
            <button
              aria-label={`Delete the ${preset.name} preset`}
              className="multi-preset-delete"
              onClick={() => onDelete(preset.name)}
              title="Delete preset"
              type="button"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {presets.length === 0 && (
          <p className="multi-add-empty">
            <Bookmark size={13} /> No presets yet — name the streams you have open to save them.
          </p>
        )}
        {presets.length > 0 && (
          <p className="multi-preset-hint">
            To change one, open it, add or remove streams, then save it back with{" "}
            <Save aria-hidden="true" size={11} />.
          </p>
        )}
      </div>
    </div>
  );
}
