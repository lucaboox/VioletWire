import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Plus,
  RotateCcw,
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
import type { FollowedChannel } from "../../shared/twitch";
import "./multi-stream.css";

interface MultiStreamViewProps {
  tiles: MultiStreamTileState[];
  followedLive: FollowedChannel[];
  nameFor: (login: string) => string;
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
  followedLive,
  nameFor,
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
  const canAdd = tiles.length < MAX_MULTISTREAM_TILES;
  const usedLogins = useMemo(() => new Set(tiles.map((tile) => tile.channel)), [tiles]);

  return (
    <section className="multi-stream-page">
      <header className="multi-stream-bar">
        <div className="multi-stream-title">
          <strong>Multistream</strong>
          <span>
            {tiles.length}/{MAX_MULTISTREAM_TILES} streams
          </span>
        </div>
        <div className="multi-stream-bar-actions">
          {canAdd && (
            <button
              className={pickerOpen ? "multi-add-toggle active" : "multi-add-toggle"}
              onClick={() => setPickerOpen((open) => !open)}
              type="button"
            >
              <Plus size={16} /> Add stream
            </button>
          )}
          <button className="multi-exit" onClick={onExit} type="button">
            <X size={16} /> Exit
          </button>
          <button
            aria-pressed={theater}
            className={theater ? "multi-theater-toggle active" : "multi-theater-toggle"}
            onClick={onToggleTheater}
            title={theater ? "Show app UI" : "Theater mode — hide the app UI"}
            type="button"
          >
            {theater ? <Minimize2 size={16} /> : <Maximize2 size={16} />} Theater
          </button>
          <button
            aria-pressed={fullscreen}
            className={fullscreen ? "multi-theater-toggle active" : "multi-theater-toggle"}
            onClick={onToggleFullscreen}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
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
        </div>
      </header>

      <div className={`multi-grid count-${tiles.length}`}>
        {tiles.map((tile) => (
          <MultiTile
            key={tile.id}
            tile={tile}
            name={nameFor(tile.channel)}
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
  onRemove,
  onActivate,
  onToggleMute,
  onSetVolume,
  onToggleCompressor,
  onSetQuality,
}: MultiTileProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [qualities, setQualities] = useState<NativeQuality[]>([]);

  // Lazy-load the quality list the first time the menu opens for this tile.
  useEffect(() => {
    if (!qualityMenuOpen || qualities.length > 0) return;
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
  }, [qualityMenuOpen, qualities.length, tile.channel]);

  // Report the tile's on-screen size so the tile's mpv instance renders at the
  // right resolution (same CSS-pixel convention as the single player).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const report = () => {
      const bounds = host.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1) return;
      window.desktop.player.multiSetBounds(tile.id, {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [tile.id]);

  const { status, error } = tile.state;
  const offline = error === "Stream is offline." || /offline|no playable streams/i.test(error ?? "");
  const showOverlay = status !== "playing";

  return (
    <div
      className={tile.active ? "multi-tile active" : "multi-tile"}
      ref={hostRef}
      onClick={() => onActivate(tile.id)}
    >
      <canvas
        className="native-texture-canvas"
        data-native-texture-canvas={String(tile.id)}
        aria-hidden="true"
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
      <div className="multi-tile-bar" onClick={(event) => event.stopPropagation()}>
        {tile.active && <span className="multi-tile-live-dot" title="Audio focus" />}
        <span className="multi-tile-name">{name}</span>
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
          className={tile.state.compressorEnabled ? "multi-tile-btn active" : "multi-tile-btn"}
          onClick={() => onToggleCompressor(tile.id, !tile.state.compressorEnabled)}
          title="Audio compressor"
          type="button"
        >
          <AudioLines size={14} />
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
      {!tile.active && <div className="multi-tile-focus-hint">Click video for audio</div>}
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
  const available = useMemo(
    () => followedLive.filter((channel) => !usedLogins.has(channel.login)),
    [followedLive, usedLogins],
  );

  return (
    <div className="multi-add-picker" role="dialog" aria-label="Add a stream">
      <input
        aria-label="Add channel by name"
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter") {
            const login = query.trim().toLowerCase();
            if (login) onAdd(login);
          }
        }}
        placeholder="Add channel by name…"
        type="text"
        value={query}
      />
      <div className="multi-add-list">
        {available.map((channel) => (
          <button key={channel.login} onClick={() => onAdd(channel.login)} type="button">
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
