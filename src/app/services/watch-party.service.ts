import { Injectable, NgZone, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

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
  memberId?: string;
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
}

const INITIAL_STATE: WatchPartyState = {
  role: null,
  roomCode: null,
  connected: false,
  connecting: false,
  members: [],
  error: null,
  inviteUrl: null,
};

interface PartyCreateResponse {
  code: string;
  memberId: string;
  members?: WatchPartyMember[];
  media?: WatchPartyMediaState | null;
}

interface PartyPollResponse {
  events?: Array<{ seq: number; from: string; command: WatchPartyCommand }>;
  members?: WatchPartyMember[];
  media?: WatchPartyMediaState | null;
  seq?: number;
  closed?: boolean;
  error?: string;
}

/**
 * Watch party over auth-api HTTP long-poll.
 * Works PC ↔ mobile on different Wi‑Fi / cellular (no WebRTC/NAT).
 */
@Injectable({
  providedIn: 'root',
})
export class WatchPartyService implements OnDestroy {
  private static readonly SESSION_KEY = 'luscreensWatchParty';
  private static readonly SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  private static readonly MAX_CHAT_LENGTH = 500;

  private readonly http = inject(HttpClient);
  private readonly apiBase = (environment.authApiUrl || '').replace(/\/$/, '');

  private userId: string | null = null;
  private memberId: string | null = null;
  private displayName = 'Guest';
  private mediaState: WatchPartyMediaState | null = null;
  private lastBroadcastAt = 0;
  private applyingRemote = false;
  private pollAfterSeq = 0;
  private pollActive = false;
  private pollAbort = false;

  private readonly stateSubject = new BehaviorSubject<WatchPartyState>(INITIAL_STATE);
  readonly state$ = this.stateSubject.asObservable();

  private readonly remoteCommandSubject = new Subject<WatchPartyCommand>();
  readonly remoteCommands$ = this.remoteCommandSubject.asObservable();

  private readonly syncRequestedSubject = new Subject<void>();
  readonly syncRequested$ = this.syncRequestedSubject.asObservable();

  private readonly chatSubject = new Subject<WatchPartyChatMessage>();
  readonly chatMessages$ = this.chatSubject.asObservable();

  private readonly joinModalSubject = new BehaviorSubject<{
    open: boolean;
    code: string;
  }>({ open: false, code: '' });
  readonly joinModal$ = this.joinModalSubject.asObservable();

  constructor(private ngZone: NgZone) {}

  openJoinModal(prefillCode?: string): void {
    const code = prefillCode?.trim()
      ? this.normalizeRoomCode(prefillCode)
      : this.joinModalSubject.value.code;
    this.joinModalSubject.next({ open: true, code: code || '' });
  }

  closeJoinModal(): void {
    this.joinModalSubject.next({
      open: false,
      code: this.joinModalSubject.value.code,
    });
  }

  getMediaState(): WatchPartyMediaState | null {
    return this.mediaState;
  }

  waitForMediaState(timeoutMs = 4000): Promise<WatchPartyMediaState | null> {
    if (this.mediaState?.mediaType && this.mediaState?.id) {
      return Promise.resolve(this.mediaState);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (media: WatchPartyMediaState | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        sub.unsubscribe();
        resolve(media);
      };

      const sub = this.remoteCommands$.subscribe((command) => {
        if (command.media?.mediaType && command.media?.id) {
          finish(command.media);
        }
      });

      const timer = setTimeout(() => finish(this.mediaState), timeoutMs);
    });
  }

  bindToUser(userId: string | null): void {
    this.userId = userId;
  }

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

  setMediaState(media: WatchPartyMediaState, options?: { broadcast?: boolean }): void {
    const prev = this.mediaState;
    this.mediaState = media;
    if (!this.isInParty) {
      return;
    }

    const shouldBroadcast = options?.broadcast ?? this.isHost;
    const mediaChanged =
      !prev ||
      prev.mediaType !== media.mediaType ||
      String(prev.id) !== String(media.id) ||
      prev.season !== media.season ||
      prev.episode !== media.episode;

    // Host title/episode changes: pin on server (pushEvent) so guests navigate
    if (shouldBroadcast && this.isHost && mediaChanged) {
      void this.postMedia(media);
    }

    const role = this.snapshot.role;
    const roomCode = this.snapshot.roomCode;
    if ((role === 'host' || role === 'guest') && roomCode) {
      this.persistSession(role, roomCode);
    }
  }

  async createParty(displayName?: string, existingRoomCode?: string): Promise<string> {
    if (!this.apiBase) {
      throw new Error('Auth API is not configured');
    }
    if (displayName) {
      this.setDisplayName(displayName);
    }

    this.stopPolling();
    this.patchState({
      connecting: true,
      error: null,
      role: 'host',
      roomCode: null,
      connected: false,
      members: [],
      inviteUrl: null,
    });

    try {
      const res = await firstValueFrom(
        this.http.post<PartyCreateResponse>(`${this.apiBase}/party/create`, {
          displayName: this.displayName,
          roomCode: existingRoomCode || undefined,
        })
      );

      this.memberId = res.memberId;
      this.pollAfterSeq = 0;
      this.patchState({
        role: 'host',
        roomCode: res.code,
        connected: true,
        connecting: false,
        members: res.members?.length
          ? res.members
          : [
              {
                peerId: res.memberId,
                displayName: this.displayName || 'Host',
                isHost: true,
              },
            ],
        inviteUrl: this.buildInviteUrl(res.code),
        error: null,
      });

      if (this.mediaState) {
        void this.postMedia(this.mediaState);
      }

      this.persistSession('host', res.code);
      this.startPolling();
      return res.code;
    } catch (error) {
      this.memberId = null;
      this.patchState({
        ...INITIAL_STATE,
        connecting: false,
        error: this.toErrorMessage(error, 'Failed to create watch party'),
      });
      throw error;
    }
  }

  async joinParty(roomCode: string, displayName?: string): Promise<void> {
    if (!this.apiBase) {
      throw new Error('Auth API is not configured');
    }
    if (displayName) {
      this.setDisplayName(displayName);
    }

    const normalized = this.normalizeRoomCode(roomCode);
    if (!normalized) {
      throw new Error('Enter a valid room code');
    }

    this.stopPolling();
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
      const res = await firstValueFrom(
        this.http.post<PartyCreateResponse>(`${this.apiBase}/party/join`, {
          code: normalized,
          displayName: this.displayName,
        })
      );

      this.memberId = res.memberId;
      this.pollAfterSeq = 0;

      if (res.media?.mediaType && res.media?.id) {
        this.applyGuestMedia(res.media);
        this.ngZone.run(() => {
          this.remoteCommandSubject.next({
            action: 'media',
            media: res.media!,
            sentAt: Date.now(),
          });
        });
      }

      this.patchState({
        role: 'guest',
        roomCode: res.code || normalized,
        connected: true,
        connecting: false,
        members: res.members || [],
        inviteUrl: this.buildInviteUrl(res.code || normalized),
        error: null,
      });

      this.persistSession('guest', res.code || normalized);
      this.startPolling();
    } catch (error) {
      this.memberId = null;
      this.patchState({
        ...INITIAL_STATE,
        connecting: false,
        error: this.toErrorMessage(error, 'Failed to join watch party'),
      });
      throw error;
    }
  }

  async restoreSession(): Promise<boolean> {
    const session = this.readSession();
    if (!session) {
      return false;
    }

    this.setDisplayName(session.displayName);

    if (
      this.pollActive &&
      this.snapshot.connected &&
      this.snapshot.roomCode === session.roomCode &&
      this.snapshot.role === session.role
    ) {
      return true;
    }

    try {
      if (session.role === 'host') {
        await this.createParty(session.displayName, session.roomCode);
      } else {
        await this.joinParty(session.roomCode, session.displayName);
      }
      return true;
    } catch (error) {
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
    void this.leaveOnServer();
    this.stopPolling();
    this.memberId = null;
    this.applyingRemote = false;
    this.clearSession();
    this.stateSubject.next({ ...INITIAL_STATE });
  }

  disconnectKeepingSession(): void {
    void this.leaveOnServer();
    this.stopPolling();
    this.memberId = null;
    this.applyingRemote = false;
    this.stateSubject.next({ ...INITIAL_STATE });
  }

  sendChat(text: string): boolean {
    if (!this.isInParty || !this.memberId) {
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
      peerId: this.memberId,
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

  broadcastPlayerEvent(event: 'play' | 'pause' | 'seeked', time: number): void {
    // Playback transport is host-only; guests use Sync if they need to realign
    if (!this.isInParty || !this.isHost) {
      return;
    }

    const ts = Date.now();
    if (ts - this.lastBroadcastAt < 80) {
      return;
    }
    this.lastBroadcastAt = ts;

    const action = event === 'seeked' ? 'seek' : event;
    this.broadcast({
      action,
      time,
      playing: action === 'play',
      media: this.mediaState ?? undefined,
      displayName: this.displayName,
      sentAt: ts,
    });
  }

  /** Sync may be triggered by host or guest. */
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

  private broadcast(command: WatchPartyCommand): void {
    const code = this.snapshot.roomCode;
    const memberId = this.memberId;
    if (!this.apiBase || !code || !memberId) {
      return;
    }

    void firstValueFrom(
      this.http.post(`${this.apiBase}/party/send`, {
        code,
        memberId,
        command,
      })
    ).catch((err) => console.warn('Watch party send failed:', err));
  }

  private async postMedia(media: WatchPartyMediaState): Promise<void> {
    const code = this.snapshot.roomCode;
    const memberId = this.memberId;
    if (!this.apiBase || !code || !memberId || !this.isHost) {
      return;
    }
    try {
      await firstValueFrom(
        this.http.post(`${this.apiBase}/party/media`, {
          code,
          memberId,
          media,
        })
      );
    } catch (err) {
      console.warn('Watch party media update failed:', err);
    }
  }

  private startPolling(): void {
    if (this.pollActive) {
      return;
    }
    this.pollActive = true;
    this.pollAbort = false;
    void this.pollLoop();
  }

  private stopPolling(): void {
    this.pollAbort = true;
    this.pollActive = false;
  }

  private async pollLoop(): Promise<void> {
    while (!this.pollAbort && this.pollActive) {
      const code = this.snapshot.roomCode;
      const memberId = this.memberId;
      if (!this.apiBase || !code || !memberId) {
        break;
      }

      try {
        const res = await firstValueFrom(
          this.http.get<PartyPollResponse>(`${this.apiBase}/party/poll`, {
            params: {
              code,
              memberId,
              after: String(this.pollAfterSeq),
              waitMs: '12000',
            },
          })
        );

        if (this.pollAbort) {
          break;
        }

        if (res.closed) {
          this.ngZone.run(() => {
            this.stopPolling();
            this.memberId = null;
            this.patchState({
              ...INITIAL_STATE,
              error: 'Party ended or host left',
            });
          });
          break;
        }

        this.ngZone.run(() => this.applyPoll(res));
      } catch (err) {
        if (this.pollAbort) {
          break;
        }
        const status = (err as { status?: number })?.status;
        if (status === 404 || status === 403) {
          this.ngZone.run(() => {
            this.stopPolling();
            this.memberId = null;
            this.patchState({
              ...INITIAL_STATE,
              error: 'Disconnected from party',
            });
          });
          break;
        }
        // Cold start / network blip
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    this.pollActive = false;
  }

  private applyPoll(res: PartyPollResponse): void {
    if (Array.isArray(res.members) && res.members.length) {
      this.patchState({ members: res.members });
    }

    if (res.media?.mediaType && res.media?.id) {
      if (this.isGuest) {
        const prev = this.mediaState;
        this.applyGuestMedia(res.media);
        if (
          !prev ||
          prev.mediaType !== res.media.mediaType ||
          String(prev.id) !== String(res.media.id) ||
          prev.season !== res.media.season ||
          prev.episode !== res.media.episode
        ) {
          this.remoteCommandSubject.next({
            action: 'media',
            media: res.media,
            sentAt: Date.now(),
          });
        }
      } else {
        this.mediaState = res.media;
      }
    }

    for (const event of res.events || []) {
      if (event.seq > this.pollAfterSeq) {
        this.pollAfterSeq = event.seq;
      }
      if (!event.command || event.from === this.memberId) {
        continue;
      }
      this.handleRemoteCommand(event.from, event.command);
    }

    if (typeof res.seq === 'number' && res.seq > this.pollAfterSeq) {
      this.pollAfterSeq = res.seq;
    }
  }

  private handleRemoteCommand(fromId: string, command: WatchPartyCommand): void {
    if (command.action === 'chat') {
      const text = (command.text || '').trim().slice(0, WatchPartyService.MAX_CHAT_LENGTH);
      if (text) {
        this.chatSubject.next({
          id: command.messageId || `${command.sentAt || Date.now()}-${fromId}`,
          peerId: fromId,
          displayName: command.displayName || 'Guest',
          text,
          sentAt: command.sentAt || Date.now(),
          isLocal: false,
        });
      }
      return;
    }

    if (command.action === 'hello') {
      if (command.media && this.isGuest) {
        this.applyGuestMedia(command.media);
      }
      if (this.isHost) {
        this.syncRequestedSubject.next();
        if (this.mediaState) {
          void this.postMedia(this.mediaState);
        }
      }
    }

    if (command.media && this.isGuest) {
      this.applyGuestMedia(command.media);
    }

    // play / pause / seek: host only. sync: anyone.
    if (
      (command.action === 'play' ||
        command.action === 'pause' ||
        command.action === 'seek') &&
      !this.isMemberHost(fromId)
    ) {
      return;
    }

    this.remoteCommandSubject.next(command);
  }

  private isMemberHost(memberId: string): boolean {
    return this.snapshot.members.some((m) => m.peerId === memberId && m.isHost);
  }

  private applyGuestMedia(media: WatchPartyMediaState): void {
    if (!media?.mediaType || media.id == null || media.id === '') {
      return;
    }
    this.mediaState = {
      mediaType: media.mediaType,
      id: String(media.id),
      season: media.season,
      episode: media.episode,
      title: media.title,
      posterPath: media.posterPath ?? null,
    };
    const role = this.snapshot.role;
    const roomCode = this.snapshot.roomCode;
    if ((role === 'host' || role === 'guest') && roomCode) {
      this.persistSession(role, roomCode);
    }
  }

  private async leaveOnServer(): Promise<void> {
    const code = this.snapshot.roomCode;
    const memberId = this.memberId;
    if (!this.apiBase || !code || !memberId) {
      return;
    }
    try {
      await firstValueFrom(
        this.http.post(`${this.apiBase}/party/leave`, { code, memberId })
      );
    } catch {
      // ignore
    }
  }

  private sessionKey(): string {
    return this.userId
      ? `${WatchPartyService.SESSION_KEY}:${this.userId}`
      : WatchPartyService.SESSION_KEY;
  }

  private persistSession(role: 'host' | 'guest', roomCode: string): void {
    try {
      const session: WatchPartySession = {
        role,
        roomCode,
        displayName: this.displayName,
        memberId: this.memberId || undefined,
        mediaType: this.mediaState?.mediaType,
        id: this.mediaState?.id,
        season: this.mediaState?.season,
        episode: this.mediaState?.episode,
        title: this.mediaState?.title,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(this.sessionKey(), JSON.stringify(session));
    } catch {
      // ignore
    }
  }

  private readSession(): WatchPartySession | null {
    try {
      const raw = sessionStorage.getItem(this.sessionKey());
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
      sessionStorage.removeItem(this.sessionKey());
    } catch {
      // ignore
    }
  }

  private normalizeRoomCode(input: string): string {
    const raw = (input || '').trim();
    if (!raw) {
      return '';
    }

    try {
      if (raw.includes('party=')) {
        const url = new URL(
          raw,
          typeof window !== 'undefined' ? window.location.origin : undefined
        );
        const fromQuery = url.searchParams.get('party');
        if (fromQuery) {
          return fromQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        }
      }
    } catch {
      // fall through
    }

    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private buildInviteUrl(roomCode: string): string {
    if (typeof window === 'undefined') {
      return '';
    }

    const origin = window.location.origin;
    const media = this.mediaState;
    if (media?.mediaType && media.id) {
      let path = `/frame/${media.mediaType}/${media.id}`;
      if (
        media.mediaType === 'tv' &&
        media.season != null &&
        media.episode != null
      ) {
        path += `/${media.season}/${media.episode}`;
      }
      return `${origin}${path}?party=${encodeURIComponent(roomCode)}`;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('party', roomCode);
    return url.toString();
  }

  private patchState(partial: Partial<WatchPartyState>): void {
    const next = { ...this.stateSubject.value, ...partial };
    if (NgZone.isInAngularZone()) {
      this.stateSubject.next(next);
    } else {
      this.ngZone.run(() => this.stateSubject.next(next));
    }
  }

  private toErrorMessage(error: unknown, fallback: string): string {
    const httpErr = error as {
      error?: { error?: string };
      message?: string;
    };
    if (httpErr?.error?.error) {
      return String(httpErr.error.error);
    }
    if (httpErr?.message) {
      return httpErr.message;
    }
    return fallback;
  }
}
