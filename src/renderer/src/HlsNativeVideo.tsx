import Hls, { ErrorTypes, Events } from "hls.js";
import { useEffect, useRef } from "react";
import type {
  NativePlayerCommand,
  NativePlayerState,
} from "../../shared/player";

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
    "Low latency mode": "Yes",
    "Playback rate": `${video.playbackRate.toFixed(2)}×`,
    "Video bitrate":
      streamBitrate > 0
        ? `${Math.round(streamBitrate / 1_000)} kbps`
        : "Measuring",
    Protocol: "Filtered local HLS",
    "vw-presentation": "Chromium video",
    "vw-fps": fps.toFixed(0),
    "vw-delivery-fps": fps.toFixed(1),
  };
}

export function HlsNativeVideo({ state, target = "main" }: HlsNativeVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioGraph = useRef<AudioGraph | null>(null);
  const compressorEnabled = useRef(state.compressorEnabled);
  const stateRef = useRef(state);
  const hlsSessionId = state.hlsSource?.sessionId;
  const hlsPlaylistUrl = state.hlsSource?.playlistUrl;

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
      !hlsPlaylistUrl ||
      state.backend !== "hls"
    ) {
      return;
    }
    const source = {
      sessionId: hlsSessionId,
      playlistUrl: hlsPlaylistUrl,
    };

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
    // Keep the user's intent separate from HTMLMediaElement.paused. Source
    // attachment, manifest reparses, and hls.js recovery can all transiently
    // change the media element state; none of them should undo an explicit
    // pause.
    let playbackRequested = !stateRef.current.paused;

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
          ? playbackStats(
              video,
              measuredFps,
              streamBitrate,
              displayedLatency,
              targetLatency,
            )
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
            playbackRequested = true;
            seekToLive();
            void video.play().catch(() => undefined);
          } else {
            playbackRequested = false;
            video.pause();
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
          playbackRequested = true;
          seekToLive();
          void video.play().catch(() => undefined);
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
      // One complete Twitch segment previously starved Chromium on some
      // channels, while two segments adds more delay than necessary. A
      // one-and-three-quarter segment target absorbs normal playlist-arrival
      // jitter without returning to the old two-segment delay.
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 30,
      liveSyncDurationCount: 1.75,
      liveMaxLatencyDurationCount: 3.5,
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
    player.attachMedia(video);
    player.on(Events.MEDIA_ATTACHED, () => {
      player.loadSource(source.playlistUrl);
    });
    player.on(Events.MANIFEST_PARSED, () => {
      if (playbackRequested) void video.play().catch(() => undefined);
      else video.pause();
    });
    player.on(Events.LEVEL_SWITCHED, (_event, data) => {
      streamBitrate = player.levels[data.level]?.bitrate ?? streamBitrate;
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
      if (!data.fatal || disposed) return;
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

    const onPlaying = () => {
      if (!playbackRequested) {
        video.pause();
        return;
      }
      report("playing");
    };
    const onPause = () => report("playing");
    const onEnded = () => report("stopped");
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
      report("playing", undefined, true);
    }, 750);

    return () => {
      disposed = true;
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      window.clearInterval(statsTimer);
      removeCommandListener();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      player.destroy();
      video.removeAttribute("src");
      video.load();
      const graph = audioGraph.current;
      audioGraph.current = null;
      if (graph) void graph.context.close();
    };
  }, [hlsPlaylistUrl, hlsSessionId, state.backend, target]);

  return (
    <video
      aria-hidden="true"
      className="native-hls-video"
      playsInline
      ref={videoRef}
    />
  );
}
