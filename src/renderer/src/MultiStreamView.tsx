import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ChevronLeft,
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
import { channelKey, parseChannelKey, type Platform } from "../../shared/platform";
import { ProviderLogo } from "./ProviderLogo";
import { HlsNativeVideo } from "./HlsNativeVideo";
import "./multi-stream.css";

interface MultiStreamViewProps {
  tiles: MultiStreamTileState[];
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
  const canAdd = tiles.length < MAX_MULTISTREAM_TILES;
  const usedLogins = useMemo(() => new Set(tiles.map((tile) => tile.channel)), [tiles]);

  // Close the add-stream menu when clicking anywhere outside it or its toggle.
  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".multi-add-picker") || target.closest(".multi-add-toggle"))
      ) {
        return;
      }
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [pickerOpen]);

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
              onClick={() => setPickerOpen((open) => !open)}
              type="button"
            >
              <Plus size={16} /> Add stream
            </button>
          )}
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

  const { status, error } = tile.state;
  const offline = error === "Stream is offline." || /offline|no playable streams/i.test(error ?? "");
  const showOverlay = status !== "playing";

  return (
    <div
      className={[
        "multi-tile",
        tile.active ? "active" : "",
        barVisible ? "" : "controls-hidden",
      ]
        .filter(Boolean)
        .join(" ")}
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
      <HlsNativeVideo state={tile.state} target={`multi-${tile.id}`} />
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
      <div className="multi-tile-name-box">
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
