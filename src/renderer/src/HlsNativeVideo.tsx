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

function liveEdge(video: HTMLVideoElement): number | null {
  if (video.seekable.length === 0) return null;
  return video.seekable.end(video.seekable.length - 1);
}

function playbackStats(
  video: HTMLVideoElement,
  fps: number,
  streamBitrate: number,
  latency: number,
  targetLatency: number,
  latencyMode: PlaybackLatencyMode,
  mediaTransport: "chromium-protocol" | "localhost-relay",
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
    "Latency mode": latencyMode === "ultra-low" ? "Ultra low" : "Balanced",
    "Playback rate": `${video.playbackRate.toFixed(2)}×`,
    "Video bitrate":
      streamBitrate > 0
        ? `${Math.round(streamBitrate / 1_000)} kbps`
        : "Measuring",
    "Media transport":
      mediaTransport === "chromium-protocol"
        ? "Chromium protocol stream"
        : "Localhost compatibility relay",
    Protocol: "Filtered HLS",
    "vw-presentation": "Chromium video",
    "vw-fps": fps.toFixed(0),
    "vw-delivery-fps": fps.toFixed(1),
  };
}

export function HlsNativeVideo({ state, target = "main" }: HlsNativeVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedFrameRef = useRef<HTMLCanvasElement>(null);
  const audioGraph = useRef<AudioGraph | null>(null);
  const compressorEnabled = useRef(state.compressorEnabled);
  const stateRef = useRef(state);
  const hlsSessionId = state.hlsSource?.sessionId;
  const hlsPlaylistUrl = state.hlsSource?.playlistUrl;
  const hlsLatencyMode = state.hlsSource?.latencyMode ?? "balanced";
  const hlsMediaTransport =
    state.hlsSource?.mediaTransport ?? "localhost-relay";

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
    };
    const ultraLowLatency = source.latencyMode === "ultra-low";

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
    let stabilityProfile = false;
    let balancedFallbackRequested = false;
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
      recommendedLatencyMode?: "balanced",
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
        recommendedLatencyMode,
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
              "Stall recoveries": String(stallRecoveries),
              "Buffer profile": stabilityProfile
                ? "Adaptive stability"
                : ultraLowLatency
                  ? "Ultra low latency"
                  : "Balanced",
            }
          : undefined,
      });
    };

    const requestBalancedFallbackForHighResolution = (): boolean => {
      if (
        !ultraLowLatency ||
        balancedFallbackRequested ||
        video.videoHeight <= 1_080
      ) {
        return false;
      }
      balancedFallbackRequested = true;
      report("playing", undefined, true, "balanced");
      return true;
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
      if (!enabled && !audioGraph.current) return;
      if (!audioGraph.current) {
        const context = new AudioContext({ latencyHint: "playback" });
        const graph: AudioGraph = {
          context,
          source: context.createMediaElementSource(video),
          compressor: context.createDynamicsCompressor(),
        };
        graph.compressor.threshold.value = -18;
        graph.compressor.knee.value = 12;
        graph.compressor.ratio.value = 4;
        graph.compressor.attack.value = 0.02;
        graph.compressor.release.value = 0.25;
        audioGraph.current = graph;
      }
      const graph = audioGraph.current;
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
      progressive: ultraLowLatency,
      // Twitch commonly advertises a six-second target duration even though
      // its regular media fragments are about two seconds long. Count-based
      // sync therefore put Chromium roughly nine seconds behind. Use seconds
      // so the intended one-and-a-half-fragment cushion stays near three.
      backBufferLength: 30,
      maxBufferLength: ultraLowLatency ? 20 : 28,
      maxMaxBufferLength: ultraLowLatency ? 30 : 40,
      // Filtered ad boundaries and Twitch's in-progress fragments can leave
      // sub-frame timestamp gaps. Treat a short gap as continuous media rather
      // than presenting it as a visible stall.
      maxBufferHole: 0.5,
      liveSyncDuration: ultraLowLatency ? 3 : 4,
      liveMaxLatencyDuration: ultraLowLatency ? 7 : 10,
      // Start at the same low-latency target, then trade at most roughly two
      // seconds for stability only after hls.js observes a real playback
      // stall. This gives high-bitrate 1440p streams enough jitter headroom
      // without penalizing streams that are already healthy.
      liveSyncOnStallIncrease: 1,
      // Keep frame presentation at the source cadence. Even subtle variable
      // playback rates can make Chromium's video compositor and a neighboring
      // scroll layer contend at mismatched frame intervals. If playback drifts
      // too far, hls.js performs a discrete live-edge resync instead.
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
      if (data.details === ErrorDetails.BUFFER_STALLED_ERROR) {
        stallRecoveries += 1;
        if (video.videoHeight >= 1_400 || stallRecoveries >= 2) {
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
      if (requestBalancedFallbackForHighResolution()) return;
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
      if (requestBalancedFallbackForHighResolution()) return;
      report("playing", undefined, true);
    }, 750);

    return () => {
      disposed = true;
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      window.clearInterval(statsTimer);
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
      const graph = audioGraph.current;
      audioGraph.current = null;
      if (graph) void graph.context.close();
    };
  }, [
    hlsLatencyMode,
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
