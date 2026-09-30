import Hls, { ErrorDetails, ErrorTypes, Events } from "hls.js";
import { useEffect, useRef } from "react";
import type {
  NativePlayerCommand,
  NativePlayerState,
} from "../../shared/player";
import type { PlaybackLatencyMode } from "../../shared/preferences";

interface HlsNativeVideoProps {
  state: NativePlayerState;
  target?: string;
}

interface AudioGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  compressor: DynamicsCompressorNode;
}

/**
 * The compressor's audio graph, kept against the media element rather than the
 * component that rendered it.
 *
 * An element can only be handed to a MediaElementSourceNode once, and from
 * then on every sound it makes goes through that node. Building a second graph
 * for the same element throws, and closing the first one while the element is
 * still on screen leaves it wired to a dead sink: the audio stops and the
 * picture, which Chromium paces off the audio clock, drops to a frame every
 * few seconds. Both used to happen whenever the playback effect re-ran on the
 * same element — a quality change, a new playlist, or React's development
 * double-invoke — which is how a stream ended up frozen after being opened,
 * closed and opened again.
 */
const audioGraphs = new WeakMap<HTMLMediaElement, AudioGraph>();

function audioGraphFor(video: HTMLVideoElement): AudioGraph | null {
  const existing = audioGraphs.get(video);
  if (existing) return existing;
  const context = new AudioContext({ latencyHint: "playback" });
  let source: MediaElementAudioSourceNode;
  try {
    source = context.createMediaElementSource(video);
  } catch {
    // Already connected to a graph this build cannot see. Sound still reaches
    // the speakers through it; only the compressor is unavailable.
    void context.close();
    return null;
  }
  const graph: AudioGraph = {
    context,
    source,
    compressor: context.createDynamicsCompressor(),
  };
  graph.compressor.threshold.value = -18;
  graph.compressor.knee.value = 12;
  graph.compressor.ratio.value = 4;
  graph.compressor.attack.value = 0.02;
  graph.compressor.release.value = 0.25;
  audioGraphs.set(video, graph);
  return graph;
}

/** Closes a retired element's graph, once the element has actually gone. */
function retireAudioGraph(video: HTMLVideoElement | null): void {
  // Deliberately a task later: an effect cleanup also runs while the element is
  // still on screen (React's development double-invoke, and any re-run of the
  // playback effect), and closing the context then is exactly what breaks it.
  window.setTimeout(() => {
    if (!video || video.isConnected) return;
    const graph = audioGraphs.get(video);
    if (!graph) return;
    audioGraphs.delete(video);
    void graph.context.close();
  }, 0);
}

/**
 * With parts, how far behind the newest published part playback holds, in
 * seconds. Twitch's own player keeps about two seconds of buffer; the parts
 * themselves trail the broadcast by well under a second on top of that.
 */
const PARTS_TARGET_LATENCY = 2;
/** Where a parts stream settles once it has stalled repeatedly. */
const PARTS_STABLE_TARGET_LATENCY = 3.5;
/** A parts stream this far behind its target jumps back rather than catching up. */
const PARTS_RESYNC_DISTANCE = 3;
/**
 * Just after a parts stream starts, how far behind its target it may be before
 * it jumps straight there rather than catching up, and for how long.
 */
const START_JUMP_DISTANCE = 0.4;
const START_JUMP_WINDOW_MS = 8_000;
/** How long a parts stream plays without stalling before it gives back cushion, and how much. */
const CUSHION_RELAX_INTERVAL_MS = 60_000;
const CUSHION_RELAX_STEP = 0.5;
/** The rates used to close the distance to the target, either way. */
const CATCH_UP_RATE = 1.04;
const EASE_OFF_RATE = 0.96;

function liveEdge(video: HTMLVideoElement): number | null {
  if (video.seekable.length === 0) return null;
  return video.seekable.end(video.seekable.length - 1);
}

/** Seconds of media buffered ahead of the playhead. */
function forwardBuffer(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  for (let index = 0; index < buffered.length; index += 1) {
    if (currentTime >= buffered.start(index) - 0.1 && currentTime <= buffered.end(index)) {
      return buffered.end(index) - currentTime;
    }
  }
  return 0;
}

function playbackStats(
  video: HTMLVideoElement,
  fps: number,
  streamBitrate: number,
  latency: number,
  targetLatency: number,
  latencyMode: PlaybackLatencyMode,
  mediaTransport: "direct-cdn" | "chromium-protocol" | "localhost-relay",
): Record<string, string> {
  const quality = video.getVideoPlaybackQuality?.();
  const dropped = quality?.droppedVideoFrames ?? 0;
  const total = quality?.totalVideoFrames ?? 0;
  const buffered =
    video.buffered.length > 0
      ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime)
      : 0;
  return {
    Resolution: `${video.videoWidth || 0} × ${video.videoHeight || 0}`,
    Display: `${video.clientWidth} × ${video.clientHeight}`,
    FPS: fps.toFixed(0),
    "Frame delivery": fps.toFixed(1),
    Video: "Chromium Media Source Extensions",
    "Hardware decode": "Chromium automatic",
    "Render path": "HTMLVideoElement",
    "Dropped frames": String(dropped),
    "Presented frames": String(Math.max(0, total - dropped)),
    Buffer: `${buffered.toFixed(2)}s`,
    Latency: `${latency.toFixed(2)}s`,
    "Target latency": `${targetLatency.toFixed(2)}s`,
    "Latency mode": latencyMode === "ultra-low" ? "Low latency" : "Balanced",
    "Playback rate": `${video.playbackRate.toFixed(2)}×`,
    "Video bitrate":
      streamBitrate > 0
        ? `${Math.round(streamBitrate / 1_000)} kbps`
        : "Measuring",
    "Media transport":
      mediaTransport === "direct-cdn"
        ? "Direct Twitch CDN"
        : mediaTransport === "chromium-protocol"
          ? "Chromium protocol stream"
          : "Localhost compatibility relay",
    Protocol: "Filtered HLS",
    "vw-presentation": "Chromium video",
    "vw-fps": fps.toFixed(0),
    "vw-delivery-fps": fps.toFixed(1),
  };
}

/**
 * How far behind the broadcaster the picture is, and what the stream is made
 * of. "Latency" above is only distance from the newest fragment in the
 * playlist; this is measured from the broadcast time Twitch stamps on every
 * fragment (PROGRAM-DATE-TIME), to the frame on screen now — the same idea as
 * the "Latency To Broadcaster" figure in Twitch's own player, so the two can
 * be compared directly. The container matters as much as the number: MPEG-TS
 * and fragmented MP4 behave completely differently at the live edge.
 */
function broadcastStats(hls: Hls | null): Record<string, string> {
  if (!hls) return {};
  const playing = hls.playingDate;
  const details = hls.levels[hls.currentLevel]?.details ?? hls.latestLevelDetails;
  const fragmented = details?.fragments.some((fragment) => fragment.initSegment) ?? false;
  return {
    "Latency to broadcaster":
      playing === null ? "Measuring" : `${((Date.now() - playing.getTime()) / 1000).toFixed(2)}s`,
    Container: details ? (fragmented ? "Fragmented MP4 (CMAF)" : "MPEG-TS") : "Measuring",
    "Fragment length": details ? `${details.targetduration}s target` : "Measuring",
  };
}

export function HlsNativeVideo({ state, target = "main" }: HlsNativeVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedFrameRef = useRef<HTMLCanvasElement>(null);
  const compressorEnabled = useRef(state.compressorEnabled);
  const stateRef = useRef(state);
  const hlsSessionId = state.hlsSource?.sessionId;
  const hlsPlaylistUrl = state.hlsSource?.playlistUrl;
  const hlsLatencyMode = state.hlsSource?.latencyMode ?? "balanced";
  const hlsMediaTransport =
    state.hlsSource?.mediaTransport ?? "localhost-relay";
  const hlsLowLatencyParts = state.hlsSource?.lowLatencyParts ?? false;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The graph outlives this effect on purpose — see audioGraphs above. All this
  // asks for is that it be closed once the element has gone. The element is
  // taken here rather than in the cleanup, where React has already detached
  // the ref and there would be nothing left to retire.
  useEffect(() => {
    const video = videoRef.current;
    return () => retireAudioGraph(video);
  }, []);

  useEffect(() => {
    compressorEnabled.current = state.compressorEnabled;
  }, [state.compressorEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.muted !== state.muted) video.muted = state.muted;
  }, [state.muted]);

  useEffect(() => {
    const video = videoRef.current;
    const volume = Math.min(1, Math.max(0, state.volume / 100));
    if (video && Math.abs(video.volume - volume) > 0.001) video.volume = volume;
  }, [state.volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      !video ||
      !hlsSessionId ||
      !hlsPlaylistUrl
    ) {
      return;
    }
    const source = {
      sessionId: hlsSessionId,
      playlistUrl: hlsPlaylistUrl,
      latencyMode: hlsLatencyMode,
      mediaTransport: hlsMediaTransport,
      lowLatencyParts: hlsLowLatencyParts,
    };
    const lowLatency = source.latencyMode === "ultra-low";
    const parts = source.lowLatencyParts;

    let disposed = false;
    let recoveryTimer: number | null = null;
    // hls.js's bandwidthEstimate measures downloads from VioletWire's local
    // relay, which is loopback throughput rather than the encoded stream rate.
    // Use the selected media level's declared bitrate instead.
    let streamBitrate = 0;
    let lastFrameCount = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    let lastFrameAt = performance.now();
    let measuredFps = 0;
    let hls: Hls | null = null;
    let displayedLatency = 0;
    let stallRecoveries = 0;
    // Parts mode gives back the cushion stalls added once playback has been
    // steady for a while; these say how recently it has had to add any.
    let recentStalls = 0;
    let lastStallAt = 0;
    let lastRelaxAt = 0;
    // The most recent error hls.js reported, for the stats overlay.
    let lastPlayerError = "None";
    let stabilityProfile = false;
    // Parts mode only: which way playback is being steered towards its
    // target distance from live, and a smoothed reading of that distance.
    let steering: -1 | 0 | 1 = 0;
    let smoothedLatency: number | null = null;
    // Until when, once playback first settles, it may jump to its target.
    let startJumpUntil: number | null = null;
    const appendedFragmentBytes = new Map<
      string,
      { bytes: number; duration: number }
    >();
    let pendingVideoFrame: number | null = null;
    // Keep the user's intent separate from HTMLMediaElement.paused. Source
    // attachment, manifest reparses, and hls.js recovery can all transiently
    // change the media element state; none of them should undo an explicit
    // pause.
    let playbackRequested = !stateRef.current.paused;

    const cancelPendingVideoFrame = () => {
      if (pendingVideoFrame === null) return;
      video.cancelVideoFrameCallback(pendingVideoFrame);
      pendingVideoFrame = null;
    };

    const hidePausedFrame = () => {
      const canvas = pausedFrameRef.current;
      if (!canvas) return;
      canvas.hidden = true;
      // Drop the full-resolution backing store after the handoff so an active
      // stream does not retain an unnecessary second video-sized surface.
      canvas.width = 1;
      canvas.height = 1;
    };

    const showPausedFrame = () => {
      const canvas = pausedFrameRef.current;
      if (
        !canvas ||
        !canvas.hidden ||
        video.videoWidth < 1 ||
        video.videoHeight < 1
      ) {
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.hidden = false;
    };

    const revealFreshPlaybackFrame = (minimumMediaTime: number) => {
      cancelPendingVideoFrame();
      const inspectFrame: VideoFrameRequestCallback = (_now, metadata) => {
        pendingVideoFrame = null;
        if (disposed || !playbackRequested) return;
        // Chromium can deliver one callback for the pre-seek frame. Keep the
        // frozen image up until the frame actually belongs to the live seek.
        if (metadata.mediaTime + 0.1 < minimumMediaTime) {
          pendingVideoFrame = video.requestVideoFrameCallback(inspectFrame);
          return;
        }
        hidePausedFrame();
      };
      pendingVideoFrame = video.requestVideoFrameCallback(inspectFrame);
    };

    const report = (
      status: "playing" | "stopped" | "error",
      error?: string,
      includeStats = false,
    ) => {
      if (disposed) return;
      const edge = liveEdge(video);
      const latency = edge === null ? 0 : Math.max(0, edge - video.currentTime);
      if (!video.paused) displayedLatency = latency;
      const reportedTargetLatency = hls?.targetLatency;
      const targetLatency =
        typeof reportedTargetLatency === "number" &&
        Number.isFinite(reportedTargetLatency) &&
        reportedTargetLatency > 0
          ? Math.max(2, reportedTargetLatency)
          : 2;
      window.desktop.player.reportNativeHlsState({
        target,
        sessionId: source.sessionId,
        status,
        paused: video.paused,
        muted: video.muted,
        volume: Math.round(video.volume * 100),
        // Sitting at hls.js's chosen live-sync distance is normal. Only mark
        // the stream behind once it has drifted materially beyond that target.
        behindLive:
          edge !== null &&
          latency > targetLatency + Math.max(2.5, targetLatency * 0.75),
        error,
        stats: includeStats
          ? {
              ...playbackStats(
              video,
              measuredFps,
              streamBitrate,
              displayedLatency,
              targetLatency,
              source.latencyMode,
              source.mediaTransport,
              ),
              ...broadcastStats(hls),
              "Stall recoveries": String(stallRecoveries),
              "Last player error": lastPlayerError,
              ...(parts
                ? {
                    "Low-latency parts": "On",
                    "Catch-up":
                      steering === 1
                        ? "Speeding up"
                        : steering === -1
                          ? "Easing off"
                          : "Holding",
                  }
                : { "Low-latency parts": "Off" }),
              "Buffer profile": stabilityProfile
                ? "Adaptive stability"
                : lowLatency
                  ? "Low latency"
                  : "Balanced",
            }
          : undefined,
      });
    };

    const seekToLive = () => {
      const edge = liveEdge(video);
      if (edge === null) return;
      const syncPosition = hls?.liveSyncPosition;
      video.currentTime =
        typeof syncPosition === "number" && Number.isFinite(syncPosition)
          ? Math.max(0, syncPosition)
          : Math.max(0, edge - 4);
    };

    const resumeAtLive = () => {
      playbackRequested = true;
      seekToLive();
      revealFreshPlaybackFrame(video.currentTime);
      void video.play().catch(() => undefined);
    };

    const ensureAudioGraph = async (enabled: boolean) => {
      compressorEnabled.current = enabled;
      if (!enabled && !audioGraphs.has(video)) return;
      const graph = audioGraphFor(video);
      if (!graph) return;
      graph.source.disconnect();
      graph.compressor.disconnect();
      if (enabled) {
        graph.source.connect(graph.compressor);
        graph.compressor.connect(graph.context.destination);
      } else {
        graph.source.connect(graph.context.destination);
      }
      if (graph.context.state === "suspended") {
        await graph.context.resume().catch(() => undefined);
      }
    };

    const handleCommand = (commandTarget: string, command: NativePlayerCommand) => {
      if (commandTarget !== target) return;
      switch (command.command) {
        case "toggle-pause":
          if (!playbackRequested) {
            resumeAtLive();
          } else {
            playbackRequested = false;
            cancelPendingVideoFrame();
            video.pause();
            showPausedFrame();
            report("playing");
          }
          break;
        case "toggle-mute":
          video.muted = !video.muted;
          report("playing");
          break;
        case "set-muted":
          video.muted = command.muted;
          report("playing");
          break;
        case "go-live":
          resumeAtLive();
          break;
        case "set-volume":
          video.volume = command.value / 100;
          video.muted = command.value === 0;
          report("playing");
          break;
        case "set-compressor":
          void ensureAudioGraph(command.enabled);
          break;
      }
    };
    const removeCommandListener =
      window.desktop.player.onNativeHlsCommand(handleCommand);

    video.volume = Math.min(1, Math.max(0, stateRef.current.volume / 100));
    video.muted = stateRef.current.muted;
    if (compressorEnabled.current) void ensureAudioGraph(true);

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      // Twitch PREFETCH resources are chunked responses that begin before the
      // segment is complete. Stream them into the transmuxer as bytes arrive;
      // the default all-at-once loader can otherwise starve startup for one
      // full segment before the steady-state buffer has formed.
      progressive: false,
      // Twitch commonly advertises a six-second target duration even though
      // its regular media fragments are about two seconds long. Count-based
      // sync therefore put Chromium roughly nine seconds behind. Use seconds
      // so the intended one-and-a-half-fragment cushion stays near three.
      backBufferLength: 30,
      maxBufferLength: lowLatency ? 24 : 32,
      maxMaxBufferLength: lowLatency ? 36 : 48,
      // Filtered ad boundaries and Twitch's in-progress fragments can leave
      // sub-frame timestamp gaps. Treat a short gap as continuous media rather
      // than presenting it as a visible stall.
      maxBufferHole: 0.5,
      // With parts, the distance is measured from the newest part rather than
      // the newest whole fragment, so it can be much shorter for the same
      // safety margin. Without them, whole two-second fragments set the pace.
      liveSyncDuration: parts ? PARTS_TARGET_LATENCY : lowLatency ? 4 : 6,
      liveMaxLatencyDuration: parts ? PARTS_TARGET_LATENCY + 6 : lowLatency ? 10 : 14,
      // Start at the low-latency target, then trade some of it for stability
      // only after hls.js observes a real playback stall (hls.js caps the
      // total at one target duration). This gives high-bitrate 1440p streams
      // jitter headroom without penalizing streams that are already healthy.
      liveSyncOnStallIncrease: parts ? 0.5 : 1,
      // hls.js's own catch-up switches to its fastest rate whenever latency
      // is 50ms over target, which with parts arriving every third of a
      // second is most of the time — and every stretch at a faster rate drops
      // frames on a 60Hz display. Parts mode steers itself below instead, with
      // hysteresis; without parts, playback stays at the source cadence and
      // hls.js resyncs discretely if it drifts too far.
      maxLiveSyncPlaybackRate: 1,
      manifestLoadingMaxRetry: 8,
      manifestLoadingRetryDelay: 1_000,
      manifestLoadingMaxRetryTimeout: 4_000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 500,
      fragLoadingMaxRetryTimeout: 4_000,
    });
    const player = hls;
    const enableStabilityProfile = () => {
      if (stabilityProfile) return;
      stabilityProfile = true;
      if (parts) {
        // Parts arrive as they are written, so a high bitrate no longer means
        // waiting on large downloads; only repeated stalls call for this, and
        // a second and a half more cushion rather than whole fragments.
        player.config.liveMaxLatencyDuration = PARTS_STABLE_TARGET_LATENCY + 6;
        player.targetLatency = PARTS_STABLE_TARGET_LATENCY;
        return;
      }
      // hls.js normally limits stall-driven target growth to one target
      // duration (about two seconds on Twitch). That is not enough when a
      // high-bitrate source repeatedly exhausts the three-second live cushion.
      // Give unstable playback room to settle while leaving healthy streams
      // at VioletWire's normal low-latency target.
      player.config.liveMaxLatencyDuration = 12;
      player.config.maxBufferLength = 30;
      player.config.maxMaxBufferLength = 45;
      player.targetLatency = 6;
    };
    player.attachMedia(video);
    player.on(Events.MEDIA_ATTACHED, () => {
      player.loadSource(source.playlistUrl);
    });
    player.on(Events.MANIFEST_PARSED, () => {
      if (playbackRequested) void video.play().catch(() => undefined);
      else {
        video.pause();
        showPausedFrame();
      }
    });
    player.on(Events.LEVEL_SWITCHED, (_event, data) => {
      streamBitrate = player.levels[data.level]?.bitrate ?? streamBitrate;
    });
    player.on(Events.BUFFER_APPENDING, (_event, data) => {
      const key = `${data.frag.level}:${String(data.frag.sn)}`;
      const current = appendedFragmentBytes.get(key) ?? {
        bytes: 0,
        duration: data.frag.duration,
      };
      current.bytes += data.data.byteLength;
      current.duration = data.frag.duration;
      appendedFragmentBytes.set(key, current);
      // Bound diagnostics independently of hls.js's own media buffer.
      if (appendedFragmentBytes.size > 12) {
        appendedFragmentBytes.delete(appendedFragmentBytes.keys().next().value!);
      }
    });
    player.on(Events.FRAG_CHANGED, (_event, data) => {
      const key = `${data.frag.level}:${String(data.frag.sn)}`;
      const appended = appendedFragmentBytes.get(key);
      if (!appended || appended.bytes <= 0 || appended.duration <= 0) return;
      const measuredBitrate = (appended.bytes * 8) / appended.duration;
      streamBitrate =
        streamBitrate > 0
          ? streamBitrate * 0.7 + measuredBitrate * 0.3
          : measuredBitrate;
    });
    player.on(Events.FRAG_LOADED, (_event, data) => {
      const level = data.frag.level;
      if (level >= 0) {
        streamBitrate = player.levels[level]?.bitrate ?? streamBitrate;
      }
      // Direct media playlists often have no master-level BANDWIDTH value.
      // Segment bytes divided by media duration measures the encoded stream,
      // independent of how quickly the localhost relay delivered those bytes.
      const duration = data.frag.duration;
      const loadedBytes = data.payload.byteLength;
      if (duration > 0 && loadedBytes > 0) {
        const measuredBitrate = (loadedBytes * 8) / duration;
        streamBitrate =
          streamBitrate > 0
            ? streamBitrate * 0.7 + measuredBitrate * 0.3
            : measuredBitrate;
      }
    });
    player.on(Events.ERROR, (_event, data) => {
      if (disposed) return;
      // Messages can quote signed media URLs; the stats never show those.
      const message = data.error?.message.replace(/https?:\/\/\S+/g, "(media URL)").slice(0, 120);
      lastPlayerError = `${data.details}${data.fatal ? " (fatal)" : ""}${message ? `: ${message}` : ""}`;
      if (data.details === ErrorDetails.BUFFER_STALLED_ERROR) {
        stallRecoveries += 1;
        recentStalls += 1;
        lastStallAt = performance.now();
        if (parts ? recentStalls >= 3 : video.videoHeight >= 1_400 || stallRecoveries >= 2) {
          enableStabilityProfile();
        }
      }
      if (!data.fatal) return;
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        recoveryTimer = window.setTimeout(() => {
          recoveryTimer = null;
          if (!disposed) player.loadSource(source.playlistUrl);
        }, 1_000);
        return;
      }
      if (data.type === ErrorTypes.MEDIA_ERROR) {
        player.recoverMediaError();
        return;
      }
      report("error", "Chromium could not play the filtered HLS stream.");
    });

    const onPlay = () => {
      if (document.pictureInPictureElement !== video || playbackRequested) return;
      // The stock browser PiP controls call HTMLVideoElement.play() directly
      // instead of going through VioletWire's go-live command. Treat that as a
      // request to resume at the current live edge.
      playbackRequested = true;
      seekToLive();
      revealFreshPlaybackFrame(video.currentTime);
    };
    const onPlaying = () => {
      if (!playbackRequested) {
        video.pause();
        showPausedFrame();
        return;
      }
      report("playing");
    };
    const onPause = () => {
      if (document.pictureInPictureElement === video && playbackRequested) {
        // Likewise, pausing from the legacy browser PiP window bypasses the
        // command handler. The custom VioletWire PiP controls use the normal
        // command path and do not need this fallback.
        playbackRequested = false;
        cancelPendingVideoFrame();
      }
      if (!playbackRequested) showPausedFrame();
      report("playing");
    };
    const onEnded = () => report("stopped");
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    const setSteering = (next: -1 | 0 | 1) => {
      steering = next;
      const rate = next === 1 ? CATCH_UP_RATE : next === -1 ? EASE_OFF_RATE : 1;
      if (video.playbackRate !== rate) video.playbackRate = rate;
    };
    // Holds a parts stream at its target distance from live. It speeds up
    // only once playback is clearly behind, eases off only once it is
    // clearly too close to the edge, and holds either until the distance is
    // nearly made up, so the rate changes a few times a minute at most rather
    // than with every part.
    const steerLatency = () => {
      if (disposed) return;
      const target = player.targetLatency;
      const latency = player.latency;
      const settled =
        playbackRequested &&
        !video.paused &&
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      if (!settled || target === null || !(latency > 0)) {
        smoothedLatency = null;
        setSteering(0);
        return;
      }
      const now = performance.now();
      if (
        target > PARTS_TARGET_LATENCY + 0.01 &&
        now - Math.max(lastStallAt, lastRelaxAt) >= CUSHION_RELAX_INTERVAL_MS
      ) {
        // Every stall adds to the cushion, and without this none of it ever
        // came back: an evening's odd hiccup left a stream seconds behind for
        // good. A minute without a stall gives half a second back.
        lastRelaxAt = now;
        const relaxed = Math.max(PARTS_TARGET_LATENCY, target - CUSHION_RELAX_STEP);
        player.targetLatency = relaxed;
        if (relaxed <= PARTS_TARGET_LATENCY) {
          stabilityProfile = false;
          recentStalls = 0;
          player.config.liveMaxLatencyDuration = PARTS_TARGET_LATENCY + 6;
        }
      }
      smoothedLatency =
        smoothedLatency === null ? latency : smoothedLatency + (latency - smoothedLatency) * 0.2;
      const distance = smoothedLatency - target;
      if (distance > PARTS_RESYNC_DISTANCE) {
        // Seconds behind — after a long stall, or back from a hidden window.
        // Catching that up at a few percent would take minutes.
        smoothedLatency = null;
        setSteering(0);
        seekToLive();
        return;
      }
      const ahead = forwardBuffer(video);
      if (startJumpUntil === null) startJumpUntil = performance.now() + START_JUMP_WINDOW_MS;
      if (performance.now() < startJumpUntil && distance > START_JUMP_DISTANCE) {
        // Playback starts at a key frame, which can be a second or more
        // earlier than the target; closing that at a few percent takes most
        // of a minute. Just after the first frame, one jump to the target
        // within what is already buffered goes unnoticed.
        const sync = player.liveSyncPosition;
        if (sync !== null && sync > video.currentTime && sync < video.currentTime + ahead - 0.5) {
          startJumpUntil = 0;
          smoothedLatency = null;
          setSteering(0);
          video.currentTime = sync;
          return;
        }
      }
      let next = steering;
      if (steering === 1 && (distance < 0.1 || ahead < 1)) next = 0;
      else if (steering === -1 && distance > -0.1) next = 0;
      if (next === 0) {
        if (distance > 0.5 && ahead > 1.2) next = 1;
        else if (distance < -0.5) next = -1;
      }
      setSteering(next);
    };
    const steerTimer = parts ? window.setInterval(steerLatency, 250) : null;

    const statsTimer = window.setInterval(() => {
      if (disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const now = performance.now();
      const currentFrames =
        video.getVideoPlaybackQuality?.().totalVideoFrames ??
        (video as HTMLVideoElement & { webkitDecodedFrameCount?: number })
          .webkitDecodedFrameCount ??
        lastFrameCount;
      const elapsed = now - lastFrameAt;
      if (elapsed > 0) measuredFps = ((currentFrames - lastFrameCount) * 1_000) / elapsed;
      lastFrameCount = currentFrames;
      lastFrameAt = now;
      report("playing", undefined, true);
    }, 750);

    return () => {
      disposed = true;
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      window.clearInterval(statsTimer);
      if (steerTimer !== null) window.clearInterval(steerTimer);
      cancelPendingVideoFrame();
      removeCommandListener();
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      // A new playback session gets a new media element (the component is
      // keyed by sessionId). Fully retire this decoder first so switching
      // between Kick and Twitch cannot carry a stale Chromium media pipeline
      // into the next stream.
      video.pause();
      player.stopLoad();
      player.detachMedia();
      player.destroy();
      hidePausedFrame();
      video.removeAttribute("src");
      video.load();
    };
  }, [
    hlsLatencyMode,
    hlsLowLatencyParts,
    hlsMediaTransport,
    hlsPlaylistUrl,
    hlsSessionId,
    target,
  ]);

  return (
    <>
      <video
        aria-hidden="true"
        className="native-hls-video"
        playsInline
        ref={videoRef}
      />
      <canvas
        aria-hidden="true"
        className="native-hls-paused-frame"
        hidden
        ref={pausedFrameRef}
      />
    </>
  );
}
