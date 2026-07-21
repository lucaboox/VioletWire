import type { BrowserWindow } from "electron";
import {
  MAX_MULTISTREAM_TILES,
  type MultiStreamTileState,
  type NativePlayerCommand,
  type NativePlayerState,
  type NativeQualityValue,
  type PlayerBounds,
} from "../shared/player";
import { TextureNativePlayer } from "./texture-native-player";

interface Tile {
  id: number;
  channel: string;
  player: TextureNativePlayer;
  state: NativePlayerState;
}

type TileStateListener = (tile: MultiStreamTileState) => void;
type TileRemovedListener = (id: number) => void;

/**
 * Runs up to {@link MAX_MULTISTREAM_TILES} native texture players at once, one
 * per grid tile. Each tile reuses the single-stream {@link TextureNativePlayer}
 * with its own render target (canvas) and streamlink resolution. Only the
 * active tile plays audio; the rest are muted (audio focus).
 */
export class MultiStreamManager {
  private readonly tiles = new Map<number, Tile>();
  private activeId: number | null = null;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly getStreamlinkPath: () => string | undefined,
    private readonly getTwitchPlaybackToken: () => string | null,
    private readonly getStoredVolume: () => number,
    private readonly onTileState: TileStateListener,
    private readonly onTileRemoved: TileRemovedListener,
  ) {}

  isActive(): boolean {
    return this.tiles.size > 0;
  }

  getTiles(): MultiStreamTileState[] {
    return [...this.tiles.values()]
      .sort((left, right) => left.id - right.id)
      .map((tile) => this.toTileState(tile));
  }

  getChannels(): string[] {
    return [...this.tiles.values()]
      .sort((left, right) => left.id - right.id)
      .map((tile) => tile.channel);
  }

  async start(channels: string[]): Promise<MultiStreamTileState[]> {
    this.stop();
    const unique: string[] = [];
    for (const channel of channels) {
      const login = channel.toLowerCase();
      if (login && !unique.includes(login)) unique.push(login);
      if (unique.length >= MAX_MULTISTREAM_TILES) break;
    }
    // The first tile owns audio focus initially.
    this.activeId = unique.length > 0 ? 0 : null;
    await Promise.all(unique.map((channel, index) => this.createTile(index, channel)));
    return this.getTiles();
  }

  async addTile(channel: string): Promise<MultiStreamTileState | null> {
    const login = channel.toLowerCase();
    if (!login) return null;
    if (this.tiles.size >= MAX_MULTISTREAM_TILES) return null;
    if ([...this.tiles.values()].some((tile) => tile.channel === login)) return null;
    const id = this.nextFreeId();
    if (id === null) return null;
    if (this.activeId === null) this.activeId = id;
    await this.createTile(id, login);
    const tile = this.tiles.get(id);
    return tile ? this.toTileState(tile) : null;
  }

  removeTile(id: number): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.player.destroy();
    this.tiles.delete(id);
    this.onTileRemoved(id);
    if (this.activeId === id) {
      // Hand audio focus to the lowest remaining tile, if any.
      const next = [...this.tiles.keys()].sort((left, right) => left - right)[0];
      this.activeId = next ?? null;
      this.applyAudioFocus();
    }
  }

  setActive(id: number): void {
    if (!this.tiles.has(id) || this.activeId === id) return;
    this.activeId = id;
    this.applyAudioFocus();
    // Reflect the new active flags for every tile, including any not yet
    // playing (those get no state event from applyAudioFocus).
    for (const tile of this.tiles.values()) this.onTileState(this.toTileState(tile));
  }

  setBounds(id: number, bounds: PlayerBounds): void {
    this.tiles.get(id)?.player.setBounds(bounds);
  }

  control(id: number, command: NativePlayerCommand): void {
    this.tiles.get(id)?.player.control(command);
  }

  async setQuality(id: number, quality: NativeQualityValue): Promise<void> {
    const tile = this.tiles.get(id);
    if (!tile) return;
    await tile.player.start(tile.channel, quality, { kind: "quality", detail: quality });
  }

  stop(): void {
    for (const tile of this.tiles.values()) tile.player.destroy();
    this.tiles.clear();
    this.activeId = null;
  }

  recoverGraphics(): void {
    for (const tile of this.tiles.values()) tile.player.recoverGraphics();
  }

  private async createTile(id: number, channel: string): Promise<void> {
    const player = new TextureNativePlayer(
      this.getMainWindow,
      (state) => this.handleTileState(id, state),
      this.getStreamlinkPath,
      this.getTwitchPlaybackToken,
      String(id),
      this.getStoredVolume,
    );
    const tile: Tile = { id, channel, player, state: player.getState() };
    this.tiles.set(id, tile);
    this.onTileState(this.toTileState(tile));
    await player.start(channel, "best", { kind: "channel", detail: channel });
  }

  private handleTileState(id: number, state: NativePlayerState): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    const wasPlaying = tile.state.status === "playing";
    tile.state = state;
    // Enforce audio focus once a tile actually starts playing (mpv ignores mute
    // commands before it has an audio track).
    if (!wasPlaying && state.status === "playing") {
      tile.player.setMuted(this.activeId !== id);
    }
    this.onTileState(this.toTileState(tile));
  }

  private applyAudioFocus(): void {
    for (const tile of this.tiles.values()) {
      tile.player.setMuted(this.activeId !== tile.id);
    }
  }

  private nextFreeId(): number | null {
    for (let id = 0; id < MAX_MULTISTREAM_TILES; id += 1) {
      if (!this.tiles.has(id)) return id;
    }
    return null;
  }

  private toTileState(tile: Tile): MultiStreamTileState {
    return {
      id: tile.id,
      channel: tile.channel,
      state: tile.state,
      active: this.activeId === tile.id,
    };
  }
}
