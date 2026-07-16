import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { inject } from '@vercel/analytics';
import { environment } from '../../../environments/environment';
import { WatchProgressService } from '../../services/watch-progress.service';
import {
  WatchPartyChatMessage,
  WatchPartyCommand,
  WatchPartyService,
  WatchPartyState,
} from '../../services/watch-party.service';
import {
  PartyLobbyService,
  PartyVisibility,
  PublicPartyRoom,
} from '../../services/party-lobby.service';

/** Chromium Document Picture-in-Picture (not on Window by default in TS libs). */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

type PlayerEventName = 'play' | 'pause' | 'seeked' | 'ended' | 'timeupdate' | 'playerstatus';

interface PlayerEventData {
  event: PlayerEventName;
  currentTime: number;
  duration: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  playing: boolean;
  muted: boolean;
  volume: number;
}

@Component({
  selector: 'app-frame',
  templateUrl: './frame.component.html',
  imports: [NgIf, FormsModule, NgForOf, CommonModule],
  styleUrls: ['./frame.component.css'],
  standalone: true,
})
export class FrameComponent implements OnInit, OnDestroy {

  private readonly vidfastOrigins = [
    'https://vidfast.pro',
    'https://vidfast.in',
    'https://vidfast.io',
    'https://vidfast.me',
    'https://vidfast.net',
    'https://vidfast.pm',
    'https://vidfast.xyz',
    'https://vidfast.vc',
    'https://vidfast.bz',
  ];

  private readonly onPlayerMessage = (event: MessageEvent): void => {
    this.handleVidfastMessage(event);
  };

  embedUrl: SafeResourceUrl | null = null;
  mediaType: string = '';
  id: string = '';
  seasons: any[] = [];
  episodes: any[] = [];
  selectedSeason: number = 1;
  selectedEpisode: number = 1;
  backdropPath: string | null = null;
  item: { logo_path: string | null } = {
    logo_path: null,
  };

  // New properties for title, rating, release date, and details
  title: string = '';
  rating: number = 0;
  releaseDate: string = '';
  details: string = '';
  isLoading: boolean = true;

  // Custom player state (driven by VidFast PLAYER_EVENT)
  isPlaying = false;
  currentTime = 0;
  duration = 0;
  isSeeking = false;
  isFullscreen = false;
  /** In fullscreen, buttons stay hidden until the user expands controls. */
  showFullscreenControls = false;
  isPictureInPicture = false;
  readonly supportsDocumentPip =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  private pipWindow: Window | null = null;
  private pipPlaceholder: HTMLElement | null = null;

  // Subtitles / server (VidFast URL params)
  readonly subtitleOptions: { code: string | null; label: string }[] = [
    { code: null, label: 'Off' },
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'zh', label: 'Chinese' },
  ];
  selectedSubtitle: string | null = null;
  selectedServer: string = environment.streamServer || 'vEdge';
  showCcMenu = false;
  showServerMenu = false;
  isPlayerReloading = false;
  playerReloadLabel = 'Loading…';

  get serverOptions(): { id: string; label: string }[] {
    const fromEnv = (environment as { streamServers?: string[] }).streamServers ?? [];
    const preferred = environment.streamServer || 'vEdge';
    const names = [preferred, ...fromEnv].filter(Boolean);
    // Keep vEdge (preferred) first, then the rest unique
    return [...new Set(names)].map((id) => ({ id, label: id }));
  }

  // Watch party
  watchParty: WatchPartyState = {
    role: null,
    roomCode: null,
    connected: false,
    connecting: false,
    members: [],
    error: null,
    inviteUrl: null,
    visibility: 'private',
  };
  showWatchPartyPanel = false;
  showJoinInviteModal = false;
  watchPartyMode: 'create' | 'join' | 'browse' = 'create';
  watchPartyName = '';
  joinRoomCode = '';
  partyVisibility: PartyVisibility = 'private';
  publicPartyRooms: PublicPartyRoom[] = [];
  publicRoomsLoading = false;
  watchPartyCopied = false;
  partyChatMessages: WatchPartyChatMessage[] = [];
  partyChatDraft = '';
  /** Collapsible chat inside the watch-party panel (non-fullscreen). */
  showPartyChat = true;
  /** Floating chat overlay while the player is fullscreen. */
  showFloatingPartyChat = false;
  partyChatUnread = 0;
  private watchPartySubs = new Subscription();
  private ignorePartyBroadcastUntil = 0;
  private lastLocalProgressSaveAt = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onFullscreenChange = (): void => {
    this.isFullscreen = !!document.fullscreenElement;
    // Entering fullscreen → minimal time bar only
    this.showFullscreenControls = !this.isFullscreen;
    if (!this.isFullscreen) {
      this.showFloatingPartyChat = false;
    }
  };
  

  @ViewChild('seasonScroll') seasonScroll!: ElementRef;
  @ViewChild('episodeScroll') episodeScroll!: ElementRef;
  @ViewChild('playerIframe') playerIframe!: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerContainer') playerContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('partyChatScroll') partyChatScroll?: ElementRef<HTMLDivElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private tmdbService: TmdbService,
    private watchPartyService: WatchPartyService,
    public partyLobby: PartyLobbyService,
    private watchProgress: WatchProgressService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // Initialize Vercel Analytics
    inject();

    window.addEventListener('message', this.onPlayerMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.setupWatchParty();
    this.startProgressTimer();

    this.mediaType = this.route.snapshot.paramMap.get('media_type') || '';
    this.id = this.route.snapshot.paramMap.get('id') || '';

    const seasonParam = this.route.snapshot.paramMap.get('season');
    const episodeParam = this.route.snapshot.paramMap.get('episode');
    if (seasonParam) {
      this.selectedSeason = +seasonParam;
    }
    if (episodeParam) {
      this.selectedEpisode = +episodeParam;
    }

    if (this.mediaType && this.id) {
      if (this.mediaType === 'movie') {
        this.fetchMovieDetails();
      } else if (this.mediaType === 'tv') {
        this.fetchTvDetails();
      } else {
        console.error('Invalid media type.');
      }
      this.fetchLogo(this.mediaType, +this.id);
    } else {
      console.error('Missing required route parameters.');
    }

    void this.tryRestoreWatchParty();
  }

  ngOnDestroy(): void {
    this.persistLocalProgress(true);
    this.stopProgressTimer();
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.closePictureInPicture();
    this.watchPartySubs.unsubscribe();
    // Keep session so a full page reload can rejoin the same party
    this.watchPartyService.disconnectKeepingSession();
  }

  private readonly onBeforeUnload = (): void => {
    this.persistLocalProgress(true);
  };

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      if (this.isPlaying || this.currentTime > 5) {
        this.persistLocalProgress(false);
      }
    }, 8000);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  fetchLogo(mediaType: string, id: number): void {
    if (mediaType === 'movie') {
      // Fetch movie logos
      this.tmdbService.getMovieImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching movie logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else if (mediaType === 'tv') {
      // Fetch TV show logos
      this.tmdbService.getTvImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching TV show logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else {
      console.error('Invalid media type for logo fetching.');
      this.item.logo_path = null;
    }
  }

  fetchMovieDetails(): void {
    this.tmdbService.getMovieDetails(+this.id).subscribe(
      (data: any) => {
        this.backdropPath = data.backdrop_path;
        this.title = data.title || 'Unknown Movie'; // Set the title with a fallback
        this.rating = data.vote_average || 0;
        this.releaseDate = data.release_date || 'Unknown Release Date';
        this.details = data.overview || 'No details available.';
        this.isLoading = false; // Mark loading as complete

        this.embedUrl = this.buildEmbedUrl(`movie/${this.id}`);
        this.syncWatchPartyMedia();
        this.watchProgress.enrichMetadata({
          mediaType: 'movie',
          id: this.id,
          title: this.title,
          posterPath: data.poster_path ?? null,
          backdropPath: data.backdrop_path ?? null,
        });
      },
      (error) => {
        console.error('Error fetching movie details:', error);
        this.isLoading = false; // Mark loading as complete even if there's an error
      }
    );
  }

  fetchTvDetails(): void {
    this.tmdbService.getTvDetails(+this.id).subscribe(
      (data: any) => {
        this.backdropPath = data.backdrop_path;
        this.title = data.name || 'Unknown TV Show'; // Set the title with a fallback
        this.rating = data.vote_average || 0;
        this.releaseDate = data.first_air_date || 'Unknown Release Date';
        this.details = data.overview || 'No details available.';
        this.isLoading = false; // Mark loading as complete

        this.seasons = data.seasons.filter((season: any) => season.season_number > 0);
        if (this.seasons.length > 0) {
          const hasRouteSeason = this.seasons.some(
            (season) => season.season_number === this.selectedSeason
          );
          if (!hasRouteSeason) {
            this.selectedSeason = this.seasons[0].season_number;
          }
          this.fetchEpisodes(this.selectedSeason);
        } else {
          console.error('No seasons found for this TV show.');
        }

        this.watchProgress.enrichMetadata({
          mediaType: 'tv',
          id: this.id,
          title: this.title,
          posterPath: data.poster_path ?? null,
          backdropPath: data.backdrop_path ?? null,
        });
      },
      (error) => {
        console.error('Error fetching TV show details:', error);
        this.isLoading = false; // Mark loading as complete even if there's an error
      }
    );
  }

  fetchEpisodes(seasonNumber: number): any {
    // Return the observable from the service call
    return this.tmdbService.getSeasonDetails(+this.id, seasonNumber).subscribe(
      (data: any) => {
        this.episodes = data.episodes;
        if (this.episodes.length > 0) {
          const hasRouteEpisode = this.episodes.some(
            (episode) => episode.episode_number === this.selectedEpisode
          );
          if (!hasRouteEpisode) {
            this.selectedEpisode = this.episodes[0].episode_number;
          }
          this.updateEmbedUrl();
        } else {
          console.error(`No episodes found for Season ${seasonNumber}.`);
        }
      },
      (error) => {
        console.error('Error fetching episodes:', error);
      }
    );
  }
  
  selectSeason(seasonNumber: number): void {
    this.selectedSeason = seasonNumber;
    this.fetchEpisodes(this.selectedSeason);
  }
  
  selectEpisode(episodeNumber: number): void {
    this.selectedEpisode = episodeNumber;
    this.updateEmbedUrl();
  }

  updateEmbedUrl(): void {
    if (this.mediaType === 'tv') {
      this.resetPlayerState();
      this.embedUrl = this.buildEmbedUrl(
        `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
      );
      this.syncWatchPartyMedia();
    }
  }

  private buildEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'red',
      title: 'false',
      // Reduce embed chrome so users rely on our custom controls instead
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
    });

    if (this.selectedServer) {
      params.set('server', this.selectedServer);
    }

    if (this.selectedSubtitle) {
      params.set('sub', this.selectedSubtitle);
    }

    const startAt =
      resumeAt != null && resumeAt > 0
        ? resumeAt
        : this.getSavedStartAt();
    if (startAt > 0) {
      params.set('startAt', String(Math.floor(startAt)));
    }

    if (this.mediaType === 'tv') {
      params.set('nextButton', 'true');
      params.set('autoNext', 'true');
    }

    const url = `https://vidfast.vc/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private getEmbedPath(): string | null {
    if (!this.id || !this.mediaType) {
      return null;
    }
    if (this.mediaType === 'movie') {
      return `movie/${this.id}`;
    }
    if (this.mediaType === 'tv') {
      return `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`;
    }
    return null;
  }

  private reloadPlayer(resumeAt?: number, label = 'Loading…'): void {
    const path = this.getEmbedPath();
    if (!path) {
      return;
    }
    const time = resumeAt ?? this.currentTime;
    this.playerReloadLabel = label;
    this.isPlayerReloading = true;
    // Keep previous frame painted under the overlay; swap src on next tick
    setTimeout(() => {
      this.embedUrl = this.buildEmbedUrl(path, time > 5 ? time : undefined);
    }, 50);
  }

  onPlayerIframeLoad(): void {
    this.isPlayerReloading = false;
    this.requestPlayerStatus();
  }

  toggleCcMenu(): void {
    this.showCcMenu = !this.showCcMenu;
    this.showServerMenu = false;
  }

  toggleServerMenu(): void {
    this.showServerMenu = !this.showServerMenu;
    this.showCcMenu = false;
  }

  selectSubtitle(code: string | null): void {
    if (this.selectedSubtitle === code) {
      this.showCcMenu = false;
      return;
    }
    this.selectedSubtitle = code;
    this.showCcMenu = false;
    // Soft-reload with sub= URL param (VidFast's supported way) — overlay avoids black flash
    this.reloadPlayer(this.currentTime, code ? 'Applying subtitles…' : 'Turning off subtitles…');
  }

  selectServer(server: string): void {
    if (this.selectedServer === server) {
      this.showServerMenu = false;
      return;
    }
    this.selectedServer = server;
    this.showServerMenu = false;
    this.reloadPlayer(this.currentTime, 'Switching server…');
  }

  private resetPlayerState(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.isSeeking = false;
  }

  private handleVidfastMessage(event: MessageEvent): void {
    if (!event.data) {
      return;
    }
    // Allow known VidFast hosts; also accept if origin host contains "vidfast"
    const originOk =
      this.vidfastOrigins.includes(event.origin) ||
      /vidfast\./i.test(event.origin || '');
    if (!originOk) {
      return;
    }

    const payload = event.data;
    const type = payload?.type || payload?.eventType;
    const data = payload?.data ?? payload?.payload ?? payload;

    if (type === 'PLAYER_EVENT' && data) {
      this.onPlayerEvent(data as PlayerEventData);
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      this.watchProgress.saveMap(data);
      this.persistLocalProgress(true);
      return;
    }

    // Some embeds send player fields without wrapping type
    if (
      data &&
      typeof data === 'object' &&
      ('currentTime' in data || 'event' in data) &&
      ((data as PlayerEventData).event || (data as PlayerEventData).playing !== undefined)
    ) {
      this.onPlayerEvent(data as PlayerEventData);
    }
  }

  private onPlayerEvent(data: PlayerEventData): void {
    if (!this.isSeeking || data.event === 'seeked') {
      this.currentTime = Number(data.currentTime ?? this.currentTime) || this.currentTime;
    }

    this.duration = Number(data.duration ?? this.duration) || this.duration;
    if (typeof data.playing === 'boolean') {
      this.isPlaying = data.playing;
    }

    switch (data.event) {
      case 'play':
        this.isPlaying = true;
        this.broadcastWatchPartyEvent('play', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'pause':
        this.isPlaying = false;
        this.broadcastWatchPartyEvent('pause', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'ended':
        this.isPlaying = false;
        this.persistLocalProgress(true);
        break;
      case 'seeked':
        this.isSeeking = false;
        this.broadcastWatchPartyEvent('seeked', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'timeupdate':
        this.persistLocalProgress(false);
        break;
      case 'playerstatus':
        this.persistLocalProgress(false);
        break;
      default:
        // Still persist when we get timed updates without a named event
        if (typeof data.currentTime === 'number' && data.currentTime > 0) {
          this.persistLocalProgress(false);
        }
        break;
    }
  }

  private persistLocalProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLocalProgressSaveAt < 3000) {
      return;
    }
    if (!this.id) {
      return;
    }

    // Prefer live player time; fall back to last saved resume point so we don't wipe history
    const watched = this.currentTime > 0 ? this.currentTime : this.getSavedStartAt();
    if (watched < 1 && !force) {
      return;
    }

    this.lastLocalProgressSaveAt = now;
    this.watchProgress.upsertPlayback({
      mediaType: this.mediaType,
      id: this.id,
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      watched,
      duration: this.duration,
      title: this.title,
      backdropPath: this.backdropPath,
    });
  }

  private getSavedStartAt(): number {
    return this.watchProgress.getSavedStartAt(
      this.mediaType,
      this.id,
      this.selectedSeason,
      this.selectedEpisode
    );
  }

  private postPlayerCommand(command: Record<string, unknown>): void {
    const contentWindow = this.playerIframe?.nativeElement?.contentWindow;
    if (!contentWindow) {
      return;
    }

    contentWindow.postMessage(command, '*');
  }

  togglePlayPause(): void {
    this.postPlayerCommand({ command: this.isPlaying ? 'pause' : 'play' });
  }

  /** Overlay over the iframe — play/pause without clicking into the embed (avoids ads). */
  onPlayerOverlayClick(): void {
    if (this.isPlayerReloading) {
      return;
    }
    this.togglePlayPause();
  }

  seekTo(time: number): void {
    const clamped = Math.max(0, Math.min(time, this.duration || time));
    this.isSeeking = true;
    this.currentTime = clamped;
    this.postPlayerCommand({ command: 'seek', time: clamped });
  }

  onSeekInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.isSeeking = true;
    this.currentTime = value;
  }

  onSeekChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.seekTo(value);
  }

  skipBy(seconds: number): void {
    this.seekTo(this.currentTime + seconds);
  }

  requestPlayerStatus(): void {
    this.postPlayerCommand({ command: 'getStatus' });
  }

  async toggleFullscreen(): Promise<void> {
    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }

    try {
      if (!document.fullscreenElement) {
        this.showFullscreenControls = false;
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
        this.showFullscreenControls = false;
      }
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  }

  async togglePictureInPicture(): Promise<void> {
    if (!this.supportsDocumentPip) {
      return;
    }

    if (this.isPictureInPicture) {
      this.closePictureInPicture();
      return;
    }

    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }

      const dpip = (window as unknown as { documentPictureInPicture: DocumentPictureInPicture })
        .documentPictureInPicture;
      const pipWindow = await dpip.requestWindow({
        width: Math.max(360, Math.round(container.clientWidth * 0.45)),
        height: Math.max(240, Math.round(container.clientHeight * 0.45)),
      });

      this.copyStylesToPipWindow(pipWindow);

      const placeholder = document.createElement('div');
      placeholder.className =
        'w-full aspect-video bg-black/80 rounded-lg flex items-center justify-center text-sm text-gray-400 border border-white/10';
      placeholder.textContent = 'Playing in Picture-in-Picture';
      container.parentNode?.insertBefore(placeholder, container);
      this.pipPlaceholder = placeholder;

      pipWindow.document.body.style.margin = '0';
      pipWindow.document.body.style.background = '#000';
      pipWindow.document.body.style.overflow = 'hidden';
      pipWindow.document.body.appendChild(container);

      this.pipWindow = pipWindow;
      this.isPictureInPicture = true;

      pipWindow.addEventListener('pagehide', () => {
        this.restorePlayerFromPip();
        this.cdr.markForCheck();
      });
    } catch (error) {
      console.error('Picture-in-Picture failed:', error);
      this.restorePlayerFromPip();
    }
  }

  private closePictureInPicture(): void {
    if (this.pipWindow && !this.pipWindow.closed) {
      this.pipWindow.close();
    }
    this.restorePlayerFromPip();
  }

  private restorePlayerFromPip(): void {
    const container = this.playerContainer?.nativeElement;
    const placeholder = this.pipPlaceholder;

    if (container && placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(container, placeholder);
      placeholder.remove();
    }

    this.pipPlaceholder = null;
    this.pipWindow = null;
    this.isPictureInPicture = false;
  }

  private copyStylesToPipWindow(pipWindow: Window): void {
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      pipWindow.document.head.appendChild(node.cloneNode(true));
    });
  }

  toggleFullscreenControls(): void {
    this.showFullscreenControls = !this.showFullscreenControls;
  }

  get showPlayerButtons(): boolean {
    return !this.isFullscreen || this.showFullscreenControls;
  }

  private setupWatchParty(): void {
    this.watchPartySubs.add(
      this.watchPartyService.state$.subscribe((state) => {
        this.watchParty = state;
        if (state.connected && state.roomCode) {
          this.syncPartyQueryParam(state.roomCode);
        }
        if (!state.connected) {
          this.partyChatMessages = [];
          this.partyChatDraft = '';
          this.partyChatUnread = 0;
          this.showFloatingPartyChat = false;
        }
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.remoteCommands$.subscribe((command) => {
        this.applyWatchPartyCommand(command);
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.syncRequested$.subscribe(() => {
        this.watchPartyService.broadcastSync(this.currentTime, this.isPlaying);
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.chatMessages$.subscribe((message) => {
        this.partyChatMessages = [...this.partyChatMessages, message].slice(-100);
        if (!message.isLocal && !this.isPartyChatVisible()) {
          this.partyChatUnread += 1;
        }
        this.cdr.detectChanges();
        queueMicrotask(() => this.scrollPartyChatToBottom());
      })
    );
  }

  private async tryRestoreWatchParty(): Promise<void> {
    const saved = this.watchPartyService.getSavedSession();
    const partyFromUrl = this.route.snapshot.queryParamMap.get('party');

    if (saved) {
      this.showWatchPartyPanel = true;
      this.watchPartyName = saved.displayName || '';
      this.joinRoomCode = saved.roomCode;
      this.watchPartyMode = saved.role === 'host' ? 'create' : 'join';

      try {
        const restored = await this.watchPartyService.restoreSession();
        if (restored) {
          this.syncWatchPartyMedia();
        } else if (saved.role === 'guest') {
          // Host may still be reconnecting — show join modal so they can retry with a name
          this.openJoinInviteModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
        }
      } catch (error) {
        console.error('Failed to restore watch party:', error);
        if (saved.role === 'guest') {
          this.openJoinInviteModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
        }
      }
      return;
    }

    if (partyFromUrl) {
      this.openJoinInviteModal(partyFromUrl);
    }
  }

  private openJoinInviteModal(roomCode: string): void {
    this.joinRoomCode = roomCode.trim().toUpperCase();
    this.watchPartyMode = 'join';
    this.showJoinInviteModal = true;
    this.showWatchPartyPanel = false;
  }

  closeJoinInviteModal(): void {
    this.showJoinInviteModal = false;
  }

  private syncPartyQueryParam(roomCode: string): void {
    const current = this.route.snapshot.queryParamMap.get('party');
    if (current?.toUpperCase() === roomCode.toUpperCase()) {
      return;
    }
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { party: roomCode },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private syncWatchPartyMedia(): void {
    this.watchPartyService.setMediaState({
      mediaType: this.mediaType,
      id: this.id,
      season: this.mediaType === 'tv' ? this.selectedSeason : undefined,
      episode: this.mediaType === 'tv' ? this.selectedEpisode : undefined,
      title: this.title,
    });
  }

  private broadcastWatchPartyEvent(
    event: 'play' | 'pause' | 'seeked',
    time: number
  ): void {
    if (Date.now() < this.ignorePartyBroadcastUntil) {
      return;
    }
    if (this.watchPartyService.isApplyingRemote) {
      return;
    }
    this.watchPartyService.broadcastPlayerEvent(event, time ?? this.currentTime);
  }

  toggleWatchPartyPanel(): void {
    this.showWatchPartyPanel = !this.showWatchPartyPanel;
    if (this.showWatchPartyPanel && this.showPartyChat && !this.isFullscreen) {
      this.partyChatUnread = 0;
    }
  }

  async startWatchParty(): Promise<void> {
    try {
      this.syncWatchPartyMedia();
      await this.watchPartyService.createParty(
        this.watchPartyName || 'Host',
        undefined,
        this.partyVisibility
      );
      this.showWatchPartyPanel = true;
    } catch (error) {
      console.error('Failed to start watch party:', error);
    }
  }

  async joinWatchParty(): Promise<void> {
    try {
      await this.watchPartyService.joinParty(
        this.joinRoomCode,
        this.watchPartyName.trim() || 'Guest'
      );
      this.showJoinInviteModal = false;
      this.showWatchPartyPanel = true;
      this.syncWatchPartyMedia();
    } catch (error) {
      console.error('Failed to join watch party:', error);
    }
  }

  async joinPublicRoom(room: PublicPartyRoom): Promise<void> {
    this.joinRoomCode = room.code;
    this.watchPartyMode = 'join';
    await this.joinWatchParty();
  }

  refreshPublicRooms(): void {
    if (!this.partyLobby.enabled) {
      this.publicPartyRooms = [];
      return;
    }
    this.publicRoomsLoading = true;
    this.watchPartySubs.add(
      this.partyLobby.listPublicRooms().subscribe((rooms) => {
        this.publicPartyRooms = rooms;
        this.publicRoomsLoading = false;
        this.cdr.markForCheck();
      })
    );
  }

  setWatchPartyMode(mode: 'create' | 'join' | 'browse'): void {
    this.watchPartyMode = mode;
    if (mode === 'browse') {
      this.refreshPublicRooms();
    }
  }

  leaveWatchParty(): void {
    this.watchPartyService.leaveParty();
    this.watchPartyCopied = false;
    this.partyChatMessages = [];
    this.partyChatDraft = '';
    this.partyChatUnread = 0;
    this.showFloatingPartyChat = false;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { party: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  sendPartyChat(): void {
    if (!this.watchParty.connected) {
      return;
    }
    const sent = this.watchPartyService.sendChat(this.partyChatDraft);
    if (sent) {
      this.partyChatDraft = '';
    }
  }

  togglePartyChat(): void {
    this.showPartyChat = !this.showPartyChat;
    if (this.showPartyChat) {
      this.partyChatUnread = 0;
      queueMicrotask(() => this.scrollPartyChatToBottom());
    }
  }

  toggleFloatingPartyChat(): void {
    this.showFloatingPartyChat = !this.showFloatingPartyChat;
    if (this.showFloatingPartyChat) {
      this.partyChatUnread = 0;
      queueMicrotask(() => this.scrollPartyChatToBottom());
    }
  }

  private isPartyChatVisible(): boolean {
    if (this.isFullscreen) {
      return this.showFloatingPartyChat;
    }
    return this.showWatchPartyPanel && this.showPartyChat;
  }

  formatChatTime(timestamp: number): string {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  trackPartyChat(_index: number, msg: WatchPartyChatMessage): string {
    return msg.id;
  }

  private scrollPartyChatToBottom(): void {
    const el = this.partyChatScroll?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Push your current time/play state to everyone (fixes drift). */
  syncWatchParty(): void {
    if (!this.watchParty.connected) {
      return;
    }
    this.watchPartyService.broadcastSync(this.currentTime, this.isPlaying);
  }

  async copyPartyInvite(): Promise<void> {
    const invite = this.watchParty.inviteUrl;
    if (!invite) {
      return;
    }

    try {
      await navigator.clipboard.writeText(invite);
      this.watchPartyCopied = true;
      setTimeout(() => {
        this.watchPartyCopied = false;
      }, 2000);
    } catch (error) {
      console.error('Failed to copy invite link:', error);
    }
  }

  private applyWatchPartyCommand(command: WatchPartyCommand): void {
    if (command.media) {
      this.ensureWatchPartyMedia(command.media);
    }

    if (command.action === 'media' || command.action === 'hello') {
      return;
    }

    const time = command.time ?? this.currentTime;

    this.watchPartyService.runAsRemote(() => {
      this.ignorePartyBroadcastUntil = Date.now() + 800;

      switch (command.action) {
        case 'play':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({ command: 'play', time });
          this.isPlaying = true;
          this.currentTime = time;
          break;
        case 'pause':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({ command: 'pause', time });
          this.isPlaying = false;
          this.currentTime = time;
          break;
        case 'seek':
          this.seekTo(time);
          break;
        case 'sync':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({
            command: command.playing ? 'play' : 'pause',
            time,
          });
          this.isPlaying = !!command.playing;
          this.currentTime = time;
          break;
      }
    });
  }

  private ensureWatchPartyMedia(media: {
    mediaType: string;
    id: string;
    season?: number;
    episode?: number;
  }): void {
    const sameTitle =
      media.mediaType === this.mediaType && media.id === this.id;

    if (sameTitle && media.mediaType === 'tv') {
      if (
        media.season != null &&
        media.season !== this.selectedSeason
      ) {
        this.selectedSeason = media.season;
        this.fetchEpisodes(media.season).add(() => {
          if (media.episode != null) {
            this.selectEpisode(media.episode);
          }
        });
        return;
      }

      if (
        media.episode != null &&
        media.episode !== this.selectedEpisode
      ) {
        this.selectEpisode(media.episode);
      }
      return;
    }

    if (sameTitle) {
      return;
    }

    // Different title — navigate and keep party code in the URL for rejoin
    const queryParams = this.watchParty.roomCode
      ? { party: this.watchParty.roomCode }
      : {};

    if (media.mediaType === 'tv' && media.season && media.episode) {
      this.router.navigate(
        ['/frame', media.mediaType, media.id, media.season, media.episode],
        { queryParams }
      );
    } else {
      this.router.navigate(['/frame', media.mediaType, media.id], { queryParams });
    }
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  prevEpisode(): void {
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex > 0) {
      this.selectEpisode(this.episodes[currentIndex - 1].episode_number);
    }
  }

  nextEpisode(): void {
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex < this.episodes.length - 1) {
      this.selectEpisode(this.episodes[currentIndex + 1].episode_number);
    }
  }

  scrollLeft(type: string): void {
    const container = type === 'seasons' ? this.seasonScroll.nativeElement : this.episodeScroll.nativeElement;
    container.scrollBy({ left: -200, behavior: 'smooth' }); // Scroll left by 200px
  }

  scrollRight(type: string): void {
    const container = type === 'seasons' ? this.seasonScroll.nativeElement : this.episodeScroll.nativeElement;
    container.scrollBy({ left: 200, behavior: 'smooth' }); // Scroll right by 200px
  }
}
