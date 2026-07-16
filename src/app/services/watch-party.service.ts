import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import Peer, { DataConnection, PeerError } from 'peerjs';
import {
  PartyLobbyService,
  PartyVisibility,
} from './party-lobby.service';

export type WatchPartyRole = 'host' | 'guest' | null;

export interface WatchPartyMediaState {
  mediaType: 'movie' | 'tv' | string;
  id: string;
  season?: number;
  episode?: number;
  title?: string;
  posterPath?: string | null;
}

export interface WatchPartyCommand {
  action: 'play' | 'pause' | 'seek' | 'sync' | 'hello' | 'media' | 'chat';
  time?: number;
  playing?: boolean;
  media?: WatchPartyMediaState;
  displayName?: string;
  text?: string;
  messageId?: string;
  sentAt?: number;
}

export interface WatchPartyChatMessage {
  id: string;
  peerId: string;
  displayName: string;
  text: string;
  sentAt: number;
  isLocal: boolean;
}

export interface WatchPartyMember {
  peerId: string;
  displayName: string;
  isHost: boolean;
}

export interface WatchPartySession {
  role: 'host' | 'guest';
  roomCode: string;
  displayName: string;
  visibility?: PartyVisibility;
  mediaType?: string;
  id?: string;
  season?: number;
  episode?: number;
  title?: string;
  savedAt: number;
}

export interface WatchPartyState {
  role: WatchPartyRole;
  roomCode: string | null;
  connected: boolean;
  connecting: boolean;
  members: WatchPartyMember[];
  error: string | null;
  inviteUrl: string | null;
  visibility: PartyVisibility;
}

const INITIAL_STATE: WatchPartyState = {
  role: null,
  roomCode: null,
  connected: false,
  connecting: false,
  members: [],
  error: null,
  inviteUrl: null,
  visibility: 'private',
};

@Injectable({
  providedIn: 'root',
})
export class WatchPartyService implements OnDestroy {
  /** Alphanumeric-only peer ids (PeerJS is picky about id format). */
  private static readonly PEER_PREFIX = 'lsparty';
  private static readonly CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  private static readonly SESSION_KEY = 'luscreensWatchParty';
  private static readonly SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private displayName = 'Guest';
  private mediaState: WatchPartyMediaState | null = null;
  private lastBroadcastAt = 0;
  private applyingRemote = false;

  private readonly stateSubject = new BehaviorSubject<WatchPartyState>(INITIAL_STATE);
  readonly state$ = this.stateSubject.asObservable();

  private readonly remoteCommandSubject = new Subject<WatchPartyCommand>();
  readonly remoteCommands$ = this.remoteCommandSubject.asObservable();

  /** Host-only: fired when a guest connects and needs a playback snapshot. */
  private readonly syncRequestedSubject = new Subject<void>();
  readonly syncRequested$ = this.syncRequestedSubject.asObservable();

  private readonly chatSubject = new Subject<WatchPartyChatMessage>();
  readonly chatMessages$ = this.chatSubject.asObservable();

  private static readonly MAX_CHAT_LENGTH = 500;
  private lobbyVisibility: PartyVisibility = 'private';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private partyLobby: PartyLobbyService) {}

  get snapshot(): WatchPartyState {
    return this.stateSubject.value;
  }

  get isInParty(): boolean {
    return this.snapshot.role !== null && this.snapshot.connected;
  }

  get isHost(): boolean {
    return this.snapshot.role === 'host';
  }

  get isGuest(): boolean {
    return this.snapshot.role === 'guest';
  }

  get isApplyingRemote(): boolean {
    return this.applyingRemote;
  }

  setDisplayName(name: string): void {
    const trimmed = name.trim();
    this.displayName = trimmed || 'Guest';
  }

  setMediaState(media: WatchPartyMediaState): void {
    this.mediaState = media;
    if (this.isInParty) {
      this.broadcast({
        action: 'media',
        media,
        displayName: this.displayName,
        sentAt: Date.now(),
      });
      // Refresh persisted media so reload lands on the same title/episode
      const role = this.snapshot.role;
      const roomCode = this.snapshot.roomCode;
      if ((role === 'host' || role === 'guest') && roomCode) {
        this.persistSession(role, roomCode);
      }
      if (role === 'host' && roomCode) {
        this.syncLobbyRoom();
      }
    }
  }

  async createParty(
    displayName?: string,
    existingRoomCode?: string,
    visibility: PartyVisibility = 'private'
  ): Promise<string> {
    if (displayName) {
      this.setDisplayName(displayName);
    }
    this.lobbyVisibility = visibility === 'public' ? 'public' : 'private';

    await this.resetPeer();
    this.patchState({
      connecting: true,
      error: null,
      role: 'host',
      roomCode: null,
      visibility: this.lobbyVisibility,
    });

    const roomCode = existingRoomCode
      ? this.normalizeRoomCode(existingRoomCode)
      : this.generateRoomCode();
    if (!roomCode) {
      throw new Error('Invalid room code');
    }
    const peerId = this.toPeerId(roomCode);

    try {
      // After reload the old PeerJS id can linger briefly — retry a few times
      await this.openPeerWithRetry(peerId);

      if (this.peer?.id !== peerId) {
        throw new Error('Room id mismatch from signaling server. Please try again.');
      }

      this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
      this.peer.on('error', (err) => this.onPeerError(err));

      this.patchState({
        role: 'host',
        roomCode,
        connected: true,
        connecting: false,
        visibility: this.lobbyVisibility,
        members: [
          {
            peerId,
            displayName: this.displayName || 'Host',
            isHost: true,
          },
        ],
        inviteUrl: this.buildInviteUrl(roomCode),
        error: null,
      });

      this.persistSession('host', roomCode);
      await this.registerLobbyRoom(roomCode);
      this.startLobbyHeartbeat();
      return roomCode;
    } catch (error) {
      await this.resetPeer();
      this.patchState({
        ...INITIAL_STATE,
        error: this.toErrorMessage(error, 'Failed to create watch party'),
      });
      throw error;
    }
  }

  async joinParty(roomCode: string, displayName?: string): Promise<void> {
    if (displayName) {
      this.setDisplayName(displayName);
    }

    const normalized = this.normalizeRoomCode(roomCode);
    if (!normalized) {
      throw new Error('Enter a valid room code');
    }

    await this.resetPeer();
    this.patchState({
      connecting: true,
      error: null,
      role: 'guest',
      roomCode: normalized,
      connected: false,
      members: [],
      inviteUrl: null,
    });

    try {
      await this.openPeer();
      this.peer!.on('error', (err) => this.onPeerError(err));

      const hostPeerId = this.toPeerId(normalized);
      const conn = await this.connectToHostWithRetry(hostPeerId);
      this.registerConnection(conn, false);

      this.send(conn, {
        action: 'hello',
        displayName: this.displayName,
        sentAt: Date.now(),
      });

      this.patchState({
        role: 'guest',
        roomCode: normalized,
        connected: true,
        connecting: false,
        inviteUrl: this.buildInviteUrl(normalized),
        members: [
          { peerId: hostPeerId, displayName: 'Host', isHost: true },
          {
            peerId: this.peer!.id,
            displayName: this.displayName,
            isHost: false,
          },
        ],
        error: null,
      });

      this.persistSession('guest', normalized);
    } catch (error) {
      await this.resetPeer();
      this.patchState({
        ...INITIAL_STATE,
        error: this.toErrorMessage(error, 'Failed to join watch party'),
      });
      throw error;
    }
  }

  /** Restore a party after page reload. Returns true if reconnect was attempted. */
  async restoreSession(): Promise<boolean> {
    const session = this.readSession();
    if (!session) {
      return false;
    }

    this.setDisplayName(session.displayName);

    // Peer survived SPA navigation — do not destroy/recreate (that drops guests)
    if (
      this.peer &&
      !this.peer.destroyed &&
      this.snapshot.connected &&
      this.snapshot.roomCode === session.roomCode &&
      this.snapshot.role === session.role
    ) {
      if (session.role === 'host') {
        this.lobbyVisibility =
          session.visibility === 'public' ? 'public' : 'private';
        this.startLobbyHeartbeat();
      }
      return true;
    }

    try {
      if (session.role === 'host') {
        await this.createParty(
          session.displayName,
          session.roomCode,
          session.visibility === 'public' ? 'public' : 'private'
        );
      } else {
        await this.joinParty(session.roomCode, session.displayName);
      }
      return true;
    } catch (error) {
      // Guest may fail if host is briefly offline during reload — keep session for retry
      if (session.role === 'guest') {
        this.patchState({
          ...INITIAL_STATE,
          error:
            'Could not rejoin yet. Make sure the host is still in the party, then try Join again.',
        });
        return false;
      }
      this.clearSession();
      throw error;
    }
  }

  getSavedSession(): WatchPartySession | null {
    return this.readSession();
  }

  leaveParty(): void {
    this.stopLobbyHeartbeat();
    const code = this.snapshot.roomCode;
    if (this.isHost && code) {
      void firstValueFrom(this.partyLobby.unregisterRoom(code));
    }
    void this.resetPeer();
    this.applyingRemote = false;
    this.clearSession();
    this.stateSubject.next({ ...INITIAL_STATE });
  }

  /** Tear down the peer without clearing the saved session (used on page unload / SPA nav). */
  disconnectKeepingSession(): void {
    // Do NOT unregister from the lobby — host may be navigating to another title.
    // Heartbeat restarts on restore; room TTL is 2 minutes.
    this.stopLobbyHeartbeat();
    void this.resetPeer();
    this.applyingRemote = false;
    // Keep role/room in UI state cleared, but sessionStorage stays for reload restore
    this.stateSubject.next({ ...INITIAL_STATE });
  }

  /** Send a chat message to everyone in the party. */
  sendChat(text: string): boolean {
    if (!this.isInParty || !this.peer) {
      return false;
    }

    const trimmed = text.trim().slice(0, WatchPartyService.MAX_CHAT_LENGTH);
    if (!trimmed) {
      return false;
    }

    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = Date.now();

    this.chatSubject.next({
      id: messageId,
      peerId: this.peer.id,
      displayName: this.displayName,
      text: trimmed,
      sentAt,
      isLocal: true,
    });

    this.broadcast({
      action: 'chat',
      text: trimmed,
      messageId,
      displayName: this.displayName,
      sentAt,
    });

    return true;
  }

  /** Anyone in the party can broadcast play/pause/seek. */
  broadcastPlayerEvent(event: 'play' | 'pause' | 'seeked', time: number): void {
    if (!this.isInParty) {
      return;
    }

    const now = Date.now();
    if (now - this.lastBroadcastAt < 80) {
      return;
    }
    this.lastBroadcastAt = now;

    const action = event === 'seeked' ? 'seek' : event;
    this.broadcast({
      action,
      time,
      playing: action === 'play',
      media: this.mediaState ?? undefined,
      displayName: this.displayName,
      sentAt: now,
    });
  }

  /** Push your current playback state so everyone can catch up. */
  broadcastSync(time: number, playing: boolean): void {
    if (!this.isInParty) {
      return;
    }

    this.broadcast({
      action: 'sync',
      time,
      playing,
      media: this.mediaState ?? undefined,
      displayName: this.displayName,
      sentAt: Date.now(),
    });
  }

  runAsRemote(action: () => void): void {
    this.applyingRemote = true;
    try {
      action();
    } finally {
      setTimeout(() => {
        this.applyingRemote = false;
      }, 400);
    }
  }

  ngOnDestroy(): void {
    this.disconnectKeepingSession();
    this.remoteCommandSubject.complete();
    this.syncRequestedSubject.complete();
    this.chatSubject.complete();
    this.stateSubject.complete();
  }

  private async openPeer(peerId?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const peerOptions = {
        debug: 1 as const,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
          ],
        },
      };
      const peer = peerId
        ? new Peer(peerId, peerOptions)
        : new Peer(peerOptions);
      this.peer = peer;

      let settled = false;

      const onOpen = (id: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (peerId && id !== peerId) {
          reject(new Error('Signaling server assigned a different room id'));
          return;
        }
        resolve();
      };

      const onError = (err: PeerError<string>): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const cleanup = (): void => {
        peer.off('open', onOpen);
        peer.off('error', onError);
      };

      peer.on('open', onOpen);
      peer.on('error', onError);
    });
  }

  private async openPeerWithRetry(peerId: string, attempts = 4): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        if (i > 0) {
          await this.resetPeer();
          await new Promise((r) => setTimeout(r, 500 * i));
        }
        await this.openPeer(peerId);
        return;
      } catch (error) {
        lastError = error;
        const type =
          error && typeof error === 'object' && 'type' in error
            ? String((error as { type: string }).type)
            : '';
        // Only retry when the previous host session still holds the id
        if (type !== 'unavailable-id' && i === 0) {
          // first failure might still be unavailable-id under a generic Error
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Could not reclaim watch party room after reload');
  }

  private persistSession(role: 'host' | 'guest', roomCode: string): void {
    try {
      const session: WatchPartySession = {
        role,
        roomCode,
        displayName: this.displayName,
        visibility: role === 'host' ? this.lobbyVisibility : undefined,
        mediaType: this.mediaState?.mediaType,
        id: this.mediaState?.id,
        season: this.mediaState?.season,
        episode: this.mediaState?.episode,
        title: this.mediaState?.title,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(
        WatchPartyService.SESSION_KEY,
        JSON.stringify(session)
      );
    } catch {
      // ignore quota / private mode
    }
  }

  private readSession(): WatchPartySession | null {
    try {
      const raw = sessionStorage.getItem(WatchPartyService.SESSION_KEY);
      if (!raw) {
        return null;
      }
      const session = JSON.parse(raw) as WatchPartySession;
      if (
        !session?.roomCode ||
        !session?.role ||
        Date.now() - (session.savedAt || 0) > WatchPartyService.SESSION_MAX_AGE_MS
      ) {
        this.clearSession();
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    try {
      sessionStorage.removeItem(WatchPartyService.SESSION_KEY);
    } catch {
      // ignore
    }
  }

  /**
   * PeerJS often emits peer-unavailable on the Peer, not the DataConnection.
   * Listen to both so join fails fast instead of hanging / acting weird.
   */
  private waitForConnection(conn: DataConnection, timeoutMs = 20000): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = this.peer;
      if (!peer) {
        reject(new Error('Peer not ready'));
        return;
      }

      let settled = false;

      const timeout = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              'Timed out connecting to host. Make sure the host party is still open and the code is correct.'
            )
          )
        );
      }, timeoutMs);

      const onOpen = (): void => {
        finish(() => resolve());
      };

      const onConnError = (err: Error): void => {
        finish(() => reject(err));
      };

      const onPeerError = (err: PeerError<string>): void => {
        const type = (err as PeerError<string> & { type?: string }).type;
        if (type === 'peer-unavailable') {
          finish(() =>
            reject(
              new Error(
                'Room not found. Ask the host to start the party again and use the new code.'
              )
            )
          );
          return;
        }
        finish(() => reject(err));
      };

      const finish = (cb: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        conn.off('open', onOpen);
        conn.off('error', onConnError);
        peer.off('error', onPeerError);
        cb();
      };

      // Already open (rare but possible)
      if (conn.open) {
        finish(() => resolve());
        return;
      }

      conn.on('open', onOpen);
      conn.on('error', onConnError);
      peer.on('error', onPeerError);
    });
  }

  /** Retry guest→host connect; PeerJS cloud / ICE is often flaky on the first try. */
  private async connectToHostWithRetry(
    hostPeerId: string,
    attempts = 3
  ): Promise<DataConnection> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (!this.peer || this.peer.destroyed) {
        throw new Error('Peer not ready');
      }
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 700 * i));
      }
      try {
        const conn = this.peer.connect(hostPeerId, { reliable: true });
        if (!conn) {
          throw new Error('Could not start connection to host');
        }
        await this.waitForConnection(conn, 18000);
        return conn;
      } catch (error) {
        lastError = error;
        const message =
          error instanceof Error ? error.message : String(error ?? '');
        // Don't burn retries if the room truly doesn't exist
        if (message.includes('Room not found')) {
          break;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Timed out connecting to host');
  }

  private onPeerError(err: PeerError<string>): void {
    const type = (err as PeerError<string> & { type?: string }).type;
    if (type === 'peer-unavailable') {
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error') {
      this.patchState({
        error: this.toErrorMessage(err, 'Watch party connection error'),
        connected: false,
      });
    }
  }

  private handleIncomingConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.registerConnection(conn, true);

      this.send(conn, {
        action: 'hello',
        displayName: this.displayName || 'Host',
        media: this.mediaState ?? undefined,
        sentAt: Date.now(),
      });

      if (this.mediaState) {
        this.send(conn, {
          action: 'media',
          media: this.mediaState,
          sentAt: Date.now(),
        });
      }

      this.syncRequestedSubject.next();
    });
  }

  private registerConnection(conn: DataConnection, fromHostSide: boolean): void {
    this.connections.set(conn.peer, conn);

    conn.on('data', (data) => this.onConnectionData(conn, data, fromHostSide));
    conn.on('close', () => this.onConnectionClosed(conn.peer));
    conn.on('error', () => this.onConnectionClosed(conn.peer));

    this.refreshMembers();
  }

  private onConnectionData(
    conn: DataConnection,
    data: unknown,
    fromHostSide: boolean
  ): void {
    const command = data as WatchPartyCommand;
    if (!command?.action) {
      return;
    }

    if (command.action === 'hello') {
      const members = [...this.snapshot.members];
      const existing = members.find((m) => m.peerId === conn.peer);
      if (existing) {
        existing.displayName = command.displayName || existing.displayName;
      } else {
        members.push({
          peerId: conn.peer,
          displayName: command.displayName || (fromHostSide ? 'Guest' : 'Host'),
          isHost: !fromHostSide,
        });
      }
      this.patchState({ members });
      return;
    }

    if (command.action === 'chat') {
      const text = (command.text || '').trim().slice(0, WatchPartyService.MAX_CHAT_LENGTH);
      if (text) {
        this.chatSubject.next({
          id: command.messageId || `${command.sentAt || Date.now()}-${conn.peer}`,
          peerId: conn.peer,
          displayName: command.displayName || 'Guest',
          text,
          sentAt: command.sentAt || Date.now(),
          isLocal: false,
        });
      }

      // Star topology: host relays guest chat to the other guests
      if (this.isHost) {
        this.relayExcept(conn.peer, command);
      }
      return;
    }

    // Apply remote playback/media for everyone (host and guests)
    this.remoteCommandSubject.next(command);

    // Star topology: host relays guest controls to the other guests
    if (
      this.isHost &&
      (command.action === 'play' ||
        command.action === 'pause' ||
        command.action === 'seek' ||
        command.action === 'sync' ||
        command.action === 'media')
    ) {
      this.relayExcept(conn.peer, command);
    }
  }

  private relayExcept(excludePeerId: string, command: WatchPartyCommand): void {
    for (const [peerId, conn] of this.connections) {
      if (peerId !== excludePeerId) {
        this.send(conn, command);
      }
    }
  }

  private onConnectionClosed(peerId: string): void {
    this.connections.delete(peerId);
    this.refreshMembers();

    if (this.isGuest && this.connections.size === 0) {
      this.patchState({
        connected: false,
        error: 'Disconnected from host',
      });
    }
  }

  private refreshMembers(): void {
    const members: WatchPartyMember[] = [];

    if (this.isHost && this.peer) {
      members.push({
        peerId: this.peer.id,
        displayName: this.displayName || 'Host',
        isHost: true,
      });
      for (const [peerId] of this.connections) {
        const existing = this.snapshot.members.find((m) => m.peerId === peerId);
        members.push({
          peerId,
          displayName: existing?.displayName || 'Guest',
          isHost: false,
        });
      }
    } else if (this.isGuest && this.peer) {
      const host = this.snapshot.members.find((m) => m.isHost);
      if (host) {
        members.push(host);
      }
      members.push({
        peerId: this.peer.id,
        displayName: this.displayName,
        isHost: false,
      });
      for (const [peerId] of this.connections) {
        if (!members.some((m) => m.peerId === peerId)) {
          members.push({
            peerId,
            displayName: 'Host',
            isHost: true,
          });
        }
      }
    }

    this.patchState({ members });
    if (this.isHost && this.snapshot.roomCode) {
      this.syncLobbyRoom();
    }
  }

  private async registerLobbyRoom(roomCode: string): Promise<void> {
    if (!this.partyLobby.enabled) {
      return;
    }
    const media = this.mediaState;
    const title = media?.title?.trim();
    await firstValueFrom(
      this.partyLobby.registerRoom({
        code: roomCode,
        visibility: this.lobbyVisibility,
        hostName: this.displayName || 'Host',
        title: title || undefined,
        mediaType: media?.mediaType,
        mediaId: media?.id != null ? String(media.id) : undefined,
        posterPath: media?.posterPath || undefined,
        season: media?.season,
        episode: media?.episode,
        memberCount: Math.max(1, this.snapshot.members.length),
      })
    );
  }

  private syncLobbyRoom(): void {
    const code = this.snapshot.roomCode;
    if (!this.isHost || !code || !this.partyLobby.enabled) {
      return;
    }
    const media = this.mediaState;
    const title = media?.title?.trim();
    const patch: Parameters<PartyLobbyService['updateRoom']>[1] = {
      visibility: this.lobbyVisibility,
      hostName: this.displayName || 'Host',
      memberCount: Math.max(1, this.snapshot.members.length),
    };
    // Never push empty title — that clears the lobby listing to "Untitled"
    if (title) {
      patch.title = title;
    }
    if (media?.mediaType) {
      patch.mediaType = media.mediaType;
    }
    if (media?.id != null && media.id !== '') {
      patch.mediaId = String(media.id);
    }
    if (media?.posterPath) {
      patch.posterPath = media.posterPath;
    }
    if (media?.season != null) {
      patch.season = media.season;
    }
    if (media?.episode != null) {
      patch.episode = media.episode;
    }
    void firstValueFrom(this.partyLobby.updateRoom(code, patch));
  }

  private startLobbyHeartbeat(): void {
    this.stopLobbyHeartbeat();
    if (!this.partyLobby.enabled || !this.isHost) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      const code = this.snapshot.roomCode;
      if (!code || !this.isHost) {
        return;
      }
      void firstValueFrom(
        this.partyLobby.heartbeat(
          code,
          Math.max(1, this.snapshot.members.length),
          this.mediaState?.title
        )
      );
    }, 30_000);
  }

  private stopLobbyHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private broadcast(command: WatchPartyCommand): void {
    for (const conn of this.connections.values()) {
      this.send(conn, command);
    }
  }

  private send(conn: DataConnection, command: WatchPartyCommand): void {
    if (conn.open) {
      conn.send(command);
    }
  }

  private async resetPeer(): Promise<void> {
    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();

    if (this.peer) {
      const peer = this.peer;
      this.peer = null;
      try {
        peer.destroy();
      } catch {
        // ignore
      }
      // Give the broker a moment to release the previous id
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private generateRoomCode(length = 6): string {
    let code = '';
    const alphabet = WatchPartyService.CODE_ALPHABET;
    const values = crypto.getRandomValues(new Uint32Array(length));
    for (let i = 0; i < length; i++) {
      code += alphabet[values[i] % alphabet.length];
    }
    return code;
  }

  /** Accept raw codes or full invite URLs containing ?party=CODE */
  private normalizeRoomCode(input: string): string {
    const raw = (input || '').trim();
    if (!raw) {
      return '';
    }

    try {
      if (raw.includes('party=')) {
        const url = new URL(raw, typeof window !== 'undefined' ? window.location.origin : undefined);
        const fromQuery = url.searchParams.get('party');
        if (fromQuery) {
          return fromQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        }
      }
    } catch {
      // not a URL — fall through
    }

    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private toPeerId(roomCode: string): string {
    return `${WatchPartyService.PEER_PREFIX}${roomCode.trim().toUpperCase()}`;
  }

  private buildInviteUrl(roomCode: string): string {
    if (typeof window === 'undefined') {
      return '';
    }

    const url = new URL(window.location.href);
    url.searchParams.set('party', roomCode);
    return url.toString();
  }

  private patchState(partial: Partial<WatchPartyState>): void {
    this.stateSubject.next({ ...this.stateSubject.value, ...partial });
  }

  private toErrorMessage(error: unknown, fallback: string): string {
    if (error && typeof error === 'object' && 'type' in error) {
      const type = String((error as { type: string }).type);
      if (type === 'peer-unavailable') {
        return 'Room not found. Check the code or ask the host to restart the party.';
      }
      if (type === 'unavailable-id') {
        return 'That room code is busy. Start a new party.';
      }
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }
}
