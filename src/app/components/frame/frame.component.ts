import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { inject } from '@vercel/analytics';
import Hls from 'hls.js';
import { environment, StreamProvider } from '../../../environments/environment';
import { WatchProgressService } from '../../services/watch-progress.service';
import { AuthService } from '../../services/auth.service';
import { ApiplayerStreamService } from '../../services/apiplayer-stream.service';
import { VidphantomStreamService } from '../../services/vidphantom-stream.service';
import { SubtitleCue, SubtitleService } from '../../services/subtitle.service';
import {
  WatchPartyChatMessage,
  WatchPartyCommand,
  WatchPartyService,
  WatchPartyState,
} from '../../services/watch-party.service';
import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

/** Chromium Document Picture-in-Picture (not on Window by default in TS libs). */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

type PlayerEventName = 'play' | 'pause' | 'seeked' | 'ended' | 'timeupdate' | 'playerstatus';
type PlayerCommand = 'play' | 'pause' | 'seek' | 'getStatus';

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

interface ApiplayerMessage {
  type?: string;
  event?: string;
  action?: string;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  message?: string;
  position?: number;
  percent?: number;
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

  /** CinemaOS uses the same PLAYER_EVENT / { command } bridge as VidFast. */
  private readonly cinemaosOrigins = [
    'https://cinemaos.tech',
    'https://cinemaos.live',
    'https://cinemaos.me',
    'https://cinemaos-v3.vercel.app',
  ];

  /** VidPhantom docs: https://vidphantom.com/ */
  private readonly vidphantomOrigins = [
    'https://vidphantom.com',
    'https://www.vidphantom.com',
    'https://vidphantom.live',
    'https://vidphantom.online',
    'https://vidphantom.site',
    'https://vidphantom.website',
    'https://vidphantom.xyz',
  ];

  private readonly apiplayerOrigins = [
    'https://apiplayer.ru',
    'https://www.apiplayer.ru',
  ];

  /** https://peachify.pro/ → embed host peachify.top */
  private readonly peachifyOrigins = [
    'https://peachify.top',
    'https://www.peachify.top',
    'https://peachify.pro',
    'https://www.peachify.pro',
  ];

  /** https://vidup.to/ — VidFast-style PLAYER_EVENT bridge */
  private readonly vidupOrigins = [
    'https://vidup.to',
    'https://www.vidup.to',
  ];

  /** https://www.videasy.to/docs → player.videasy.net */
  private readonly videasyOrigins = [
    'https://player.videasy.net',
    'https://videasy.net',
    'https://www.videasy.net',
    'https://videasy.to',
    'https://www.videasy.to',
  ];

  private readonly onPlayerMessage = (event: MessageEvent): void => {
    // postMessage can arrive outside Angular; keep scrubber / play state in sync
    this.ngZone.run(() => this.handlePlayerMessage(event));
  };

  embedUrl: SafeResourceUrl | null = null;
  mediaType: string = '';
  id: string = '';
  seasons: any[] = [];
  episodes: any[] = [];
  selectedSeason: number = 1;
  selectedEpisode: number = 1;
  backdropPath: string | null = null;
  posterPath: string | null = null;
  item: { logo_path: string | null } = {
    logo_path: null,
  };

  // New properties for title, rating, release date, and details
  title: string = '';
  rating: number = 0;
  releaseDate: string = '';
  details: string = '';
  isLoading: boolean = true;

  // Custom player state (driven by provider postMessage events)
  isPlaying = false;
  currentTime = 0;
  duration = 0;
  isSeeking = false;
  /** Sticky seek target so CinemaOS can't snap the scrubber / stream back to 0. */
  private lastSeekTarget: number | null = null;
  private seekGuardUntil = 0;
  private seekRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SEEK_GUARD_MS = 5000;
  private static readonly SEEK_RETRY_MS = 350;
  isFullscreen = false;
  /** Overlay controls — visible on tap; auto-hide after 4s while playing. */
  showPlayerControls = true;
  private controlsHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ignore surface toggle briefly after hide / hover-reveal (avoids double-toggle). */
  private controlsToggleSuppressedUntil = 0;
  private static readonly CONTROLS_HIDE_MS = 4000;
  isPictureInPicture = false;
  readonly supportsDocumentPip =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  private pipWindow: Window | null = null;
  private pipPlaceholder: HTMLElement | null = null;

  // Subtitles / provider / server (URL params differ per embed host)
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
  readonly providerOptions: { id: StreamProvider; label: string; recommended?: boolean }[] = [
    { id: 'apiplayer', label: 'ApiPlayer', recommended: true },
    { id: 'vidfast', label: 'VidFast' },
    { id: 'cinemaos', label: 'CinemaOS' },
    { id: 'vidphantom', label: 'VidPhantom' },
    { id: 'peachify', label: 'Peachify' },
    { id: 'vidup', label: 'VidUP' },
    { id: 'videasy', label: 'Videasy' },
  ];
  selectedProvider: StreamProvider =
    (environment as { streamProvider?: StreamProvider }).streamProvider || 'apiplayer';
  /** True after primary provider has been applied for this page. */
  private providerPriorityApplied = false;
  /** User picked a provider in the menu — do not auto-hop to another. */
  private providerLockedByUser = false;
  private providerPriorityPromise: Promise<void> | null = null;
  selectedSubtitle: string | null = null;
  /** Active cue text for CinemaOS (and ApiPlayer fallback) overlay. */
  activeSubtitleText = '';
  isSubtitleLoading = false;
  private subtitleCues: SubtitleCue[] = [];
  private subtitleVttUrl: string | null = null;
  private subtitleLoadToken = 0;
  private cachedImdbId: string | null = null;
  selectedServer: string = environment.streamServer || 'vEdge';
  /** When true, omit `server=` so the embed can pick a working source itself. */
  useAutoServer = true;
  showCcMenu = false;
  showProviderMenu = false;
  showServerMenu = false;
  isPlayerReloading = false;
  playerReloadLabel = 'Loading…';
  private reloadOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cap full-screen reload splash so server/provider switches don't feel stuck. */
  private static readonly RELOAD_OVERLAY_MAX_MS = 2200;
  /** True while the local HLS <video> surface should be mounted (ApiPlayer). */
  apiplayerSurfaceActive = false;
  private pendingSeekSeconds: number | null = null;
  private hlsPlayer: Hls | null = null;
  private apiplayerLoadToken = 0;

  /** Latency probe results for provider rows (ms). `null` = measuring / unknown. */
  providerPingMs: Record<StreamProvider, number | null> = {
    apiplayer: null,
    cinemaos: null,
    vidphantom: null,
    vidfast: null,
    peachify: null,
    vidup: null,
    videasy: null,
  };
  providerPingPending: Record<StreamProvider, boolean> = {
    apiplayer: false,
    cinemaos: false,
    vidphantom: false,
    vidfast: false,
    peachify: false,
    vidup: false,
    videasy: false,
  };
  private readonly providerPingUrls: Record<StreamProvider, string> = {
    apiplayer: 'https://apiplayer.ru/favicon.ico',
    cinemaos: 'https://cinemaos.tech/favicon.ico',
    vidphantom: 'https://vidphantom.com/favicon.ico',
    vidfast: 'https://vidfast.vc/favicon.ico',
    peachify: 'https://peachify.top/favicon.ico',
    vidup: 'https://vidup.to/favicon.ico',
    videasy: 'https://player.videasy.net/favicon.ico',
  };
  private lastProviderPingAt = 0;

  /**
   * Peachify disables parent→player postMessage commands.
   * Play/pause/seek are applied by rebuilding the embed URL (`autoPlay` + `startAt`).
   */
  private peachifyWantAutoPlay = true;
  private peachifyControlTimer: ReturnType<typeof setTimeout> | null = null;
  private peachifyRemountTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Keep `#playerContainer` in the DOM while embedUrl is briefly cleared.
   * Otherwise *ngIf tears down the fullscreen element on server/provider remount.
   */
  private playerSurfaceLocked = false;
  /** Bust iframe cache so autoPlay true/false always remounts. */
  private peachifyEmbedNonce = 0;
  /** Ignore outbound play/pause events while our URL control settles. */
  private peachifyIgnorePlayingUntil = 0;

  /**
   * VidFast / VidUP inbound postMessage is unreliable — same URL remount control as Peachify.
   */
  private vidfastWantAutoPlay = true;
  private vidfastControlTimer: ReturnType<typeof setTimeout> | null = null;
  private vidfastRemountTimer: ReturnType<typeof setTimeout> | null = null;
  private vidfastEmbedNonce = 0;
  private vidfastIgnorePlayingUntil = 0;

  private orientationRaf: number | null = null;
  /** True when using fixed inset-0 fullscreen because requestFullscreen failed (common on iOS web). */
  private cssFullscreenFallback = false;
  /** Portrait phone/tablet viewport — used to force landscape layout in web fullscreen. */
  isPortraitViewport = false;
  /** Avoid reload loops when Peachify reports a mismatched season/episode. */
  private peachifyEpisodeReassertUntil = 0;

  /** Auto-failover: try next server if current one never starts playback. */
  private static readonly SERVER_FAILOVER_MS = 10000;
  private static readonly PEACHIFY_FAILOVER_MS = 6000;
  private static readonly APIPLAYER_FAILOVER_MS = 8000;
  private static readonly AUTO_SERVER_ID = 'auto';
  private serverFailoverTimer: ReturnType<typeof setTimeout> | null = null;
  private serversTriedThisTitle = new Set<string>();
  private providersTriedThisTitle = new Set<StreamProvider>();
  private serverPlaybackOk = false;
  /** Last media time that proved the stream is actually advancing (not just metadata). */
  private lastPlaybackProgressSample = -1;
  /** Embed startAt we requested — static echoes of this must not count as playback. */
  private embedStartAtSeconds = 0;
  /** Skip one failover arm after intentional play/pause/seek remounts. */
  private skipNextFailoverArm = false;

  get isVidfastProvider(): boolean {
    return this.selectedProvider === 'vidfast';
  }

  get isCinemaosProvider(): boolean {
    return this.selectedProvider === 'cinemaos';
  }

  get isVidphantomProvider(): boolean {
    return this.selectedProvider === 'vidphantom';
  }

  get isApiplayerProvider(): boolean {
    return this.selectedProvider === 'apiplayer';
  }

  get isPeachifyProvider(): boolean {
    return this.selectedProvider === 'peachify';
  }

  get isVidupProvider(): boolean {
    return this.selectedProvider === 'vidup';
  }

  get isVideasyProvider(): boolean {
    return this.selectedProvider === 'videasy';
  }


  /**
   * Mobile web often can't lock orientation — rotate the fullscreen surface
   * so portrait phones still get a landscape player.
   */
  get forceLandscapeFullscreen(): boolean {
    return this.isFullscreen && this.isPortraitViewport;
  }

  /** Keep chrome forced-on only for real reload splash. */
  get forceControlsVisible(): boolean {
    return this.isPlayerReloading;
  }


  /** Embed hosts with a real subtitle query param (reload to apply). */
  get usesEmbedSubParam(): boolean {
    return this.isVidfastProvider || this.isVidupProvider || this.isPeachifyProvider;
  }

  /** Providers that accept `server=` (or equivalent) via URL reload. */
  get usesServerParam(): boolean {
    return this.isVidfastProvider || this.isVidupProvider || this.isPeachifyProvider;
  }

  /**
   * Local media + Luscreens controller (ApiPlayer / VidPhantom only).
   */
  get usesLocalHls(): boolean {
    return this.isApiplayerProvider || this.isVidphantomProvider;
  }

  /** Iframe embeds (PLAYER_EVENT and/or progress postMessage). */
  get usesRemoteIframe(): boolean {
    return (
      this.isVidfastProvider ||
      this.isCinemaosProvider ||
      this.isPeachifyProvider ||
      this.isVidupProvider ||
      this.isVideasyProvider
    );
  }

  /**
   * Player chrome is mounted for either embed provider.
   * Stay mounted while remounting (embedUrl briefly null) so fullscreen is not exited.
   */
  get hasPlayerSurface(): boolean {
    return this.usesLocalHls || !!this.embedUrl || this.playerSurfaceLocked;
  }

  get serverOptions(): { id: string; label: string }[] {
    const names = this.serversForProvider(this.selectedProvider);
    return [
      { id: FrameComponent.AUTO_SERVER_ID, label: 'Auto' },
      ...names.map((id) => ({ id, label: id })),
    ];
  }

  private serversForProvider(provider: StreamProvider): string[] {
    switch (provider) {
      case 'vidfast': {
        const fromEnv = (environment as { streamServers?: string[] }).streamServers ?? [];
        const preferred = environment.streamServer || 'vEdge';
        return [...new Set([preferred, ...fromEnv].filter(Boolean))];
      }
      case 'peachify':
        // https://peachify.pro/ — ?server= on peachify.top
        // Iron often hangs on "LOADING SOURCES" — try it last.
        return ['spider', 'wolf', 'multi', 'dark', 'iron'];
      case 'vidup':
        // Docs expose server= but no public pin list — Auto only
        return [];
      default:
        return [];
    }
  }

  get activeProviderLabel(): string {
    return this.providerOptions.find((p) => p.id === this.selectedProvider)?.label
      ?? this.selectedProvider;
  }

  get activeServerLabel(): string {
    if (this.isApiplayerProvider) {
      return this.activeProviderLabel;
    }
    return this.useAutoServer ? 'Auto' : this.selectedServer || 'Auto';
  }

  /** Guests follow the host; only Sync is shared control. */
  get canControlPartyPlayback(): boolean {
    if (!this.watchParty.connected) {
      return true;
    }
    return this.watchParty.role === 'host';
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
  };
  showWatchPartyPanel = false;
  watchPartyName = '';
  watchPartyCopied = false;
  partyChatMessages: WatchPartyChatMessage[] = [];
  partyChatDraft = '';
  /** Collapsible chat inside the watch-party panel (non-fullscreen). */
  showPartyChat = true;
  /** Floating chat overlay while the player is fullscreen. */
  showFloatingPartyChat = false;
  partyChatUnread = 0;
  private watchPartySubs = new Subscription();
  private routeParamsSub: Subscription | null = null;
  private ignorePartyBroadcastUntil = 0;
  private lastLocalProgressSaveAt = 0;
  private lastClearedRestartAt = 0;
  /** Only auto-correct embed resume for cleared titles during this window. */
  private clearedBootstrapUntil = 0;
  /** True once playback was near 0 or the user scrubbed — stop fighting seeks. */
  private clearedSessionReady = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onFullscreenChange = (): void => {
    // Ignore transient fullscreen loss while the embed remounts (server/provider switch)
    if (this.playerSurfaceLocked && this.isFullscreen && !document.fullscreenElement) {
      return;
    }
    // Keep CSS fallback active when native fullscreen never attached (mobile Safari).
    if (this.cssFullscreenFallback && !document.fullscreenElement) {
      this.isFullscreen = true;
      this.updatePortraitViewport();
      this.revealPlayerControls();
      return;
    }
    this.cssFullscreenFallback = false;
    this.isFullscreen = !!document.fullscreenElement;
    void this.syncFullscreenOrientation(this.isFullscreen);
    this.updatePortraitViewport();
        this.revealPlayerControls();
  };

  private readonly onOrientationOrResize = (): void => {
    // Mobile URL-bar show/hide fires resize constantly — coalesce to one frame.
    if (this.orientationRaf != null) {
      return;
    }
    this.orientationRaf = requestAnimationFrame(() => {
      this.orientationRaf = null;
      const wasPortrait = this.isPortraitViewport;
      this.updatePortraitViewport();
      if (!this.isFullscreen && wasPortrait === this.isPortraitViewport) {
        return;
      }
      this.ngZone.run(() => {
        if (wasPortrait !== this.isPortraitViewport || this.isFullscreen) {
          this.cdr.detectChanges();
        }
      });
    });
  };

  @ViewChild('seasonScroll') seasonScroll!: ElementRef;
  @ViewChild('episodeScroll') episodeScroll!: ElementRef;
  @ViewChild('playerIframe') playerIframe!: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerVideo') playerVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('playerContainer') playerContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('partyChatScroll') partyChatScroll?: ElementRef<HTMLDivElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private tmdbService: TmdbService,
    private watchPartyService: WatchPartyService,
    private watchProgress: WatchProgressService,
    private authService: AuthService,
    private apiplayerStream: ApiplayerStreamService,
    private vidphantomStream: VidphantomStreamService,
    private subtitleService: SubtitleService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  get isGuest(): boolean {
    return !this.authService.isLoggedIn();
  }

  getWatchPartyDisplayName(fallback: string): string {
    const accountName = this.authService.user()?.name?.trim();
    if (accountName) {
      return accountName;
    }
    return this.watchPartyName.trim() || fallback;
  }

  ngOnInit(): void {
    // Initialize Vercel Analytics
    inject();

    window.addEventListener('message', this.onPlayerMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('orientationchange', this.onOrientationOrResize);
    window.addEventListener('resize', this.onOrientationOrResize);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.updatePortraitViewport();
    this.setupWatchParty();
    this.startProgressTimer();
    // Warm provider RTT so the first open can pick lowest-ping primary
    void this.refreshProviderPings(true);

    // Angular reuses this component across /frame/... titles — must react to param changes
    // so watch-party guests (and the host) load the host's new movie.
    this.routeParamsSub = this.route.paramMap.subscribe((params) => {
      this.applyRouteParams(params);
    });

    void this.tryRestoreWatchParty();
  }

  ngOnDestroy(): void {
    this.persistLocalProgress(true);
    this.stopProgressTimer();
    this.clearControlsHideTimer();
    this.clearServerFailoverWatch();
    this.clearPlayerReloading();
    this.clearSeekGuard();
    this.clearSubtitles();
    if (this.peachifyControlTimer != null) {
      clearTimeout(this.peachifyControlTimer);
      this.peachifyControlTimer = null;
    }
    if (this.peachifyRemountTimer != null) {
      clearTimeout(this.peachifyRemountTimer);
      this.peachifyRemountTimer = null;
    }
    if (this.vidfastControlTimer != null) {
      clearTimeout(this.vidfastControlTimer);
      this.vidfastControlTimer = null;
    }
    if (this.vidfastRemountTimer != null) {
      clearTimeout(this.vidfastRemountTimer);
      this.vidfastRemountTimer = null;
    }
    if (this.orientationRaf != null) {
      cancelAnimationFrame(this.orientationRaf);
      this.orientationRaf = null;
    }
    this.cssFullscreenFallback = false;
    this.playerSurfaceLocked = false;
    this.apiplayerLoadToken++;
    this.subtitleLoadToken++;
    this.destroyApiplayerVideo();
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('orientationchange', this.onOrientationOrResize);
    window.removeEventListener('resize', this.onOrientationOrResize);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    void this.syncFullscreenOrientation(false);
    this.closePictureInPicture();
    this.routeParamsSub?.unsubscribe();
    this.routeParamsSub = null;
    this.watchPartySubs.unsubscribe();
    // WatchPartyService is root-scoped and must stay alive when the host changes titles.
    // leaveParty() / beforeunload handle cleanup.
  }

  /**
   * Load (or reload) the frame when the route id/title changes.
   * Without this, SPA navigation keeps the previous movie on screen.
   */
  private applyRouteParams(params: ParamMap): void {
    const mediaType = params.get('media_type') || '';
    const id = params.get('id') || '';
    const seasonParam = params.get('season');
    const episodeParam = params.get('episode');

    if (!mediaType || !id) {
      console.error('Missing required route parameters.');
      return;
    }

    const nextSeason = seasonParam ? +seasonParam : this.selectedSeason;
    const nextEpisode = episodeParam ? +episodeParam : this.selectedEpisode;
    const titleChanged =
      mediaType !== this.mediaType || String(id) !== String(this.id);
    const episodeChanged =
      mediaType === 'tv' &&
      (nextSeason !== this.selectedSeason || nextEpisode !== this.selectedEpisode);

    // Ignore duplicate emissions after the title is already loaded
    if (!titleChanged && !episodeChanged && this.title) {
      return;
    }

    this.mediaType = mediaType;
    this.id = id;
    if (seasonParam) {
      this.selectedSeason = +seasonParam;
    }
    if (episodeParam) {
      this.selectedEpisode = +episodeParam;
    }

    if (titleChanged) {
      // Drop stale title so we don't broadcast the previous movie to the party
      this.title = '';
      this.posterPath = null;
      this.backdropPath = '';
      this.providerLockedByUser = false;
      this.providerPriorityApplied = false;
      this.providerPriorityPromise = null;
      this.resetPlayerState();
      this.resetServerFailoverState();
      this.isLoading = true;
      this.embedUrl = null;
      this.destroyApiplayerVideo();
      this.beginClearedBootstrapIfNeeded();
      if (mediaType === 'movie') {
        this.fetchMovieDetails();
      } else if (mediaType === 'tv') {
        this.fetchTvDetails();
      } else {
        console.error('Invalid media type.');
        this.isLoading = false;
      }
      this.fetchLogo(mediaType, +id);
      return;
    }

    // Same show, different episode — refresh player + party media pin
    if (episodeChanged) {
      this.resetServerFailoverState();
      this.updateEmbedUrl();
      this.syncWatchPartyMedia();
    }
  }

  private readonly onBeforeUnload = (): void => {
    this.persistLocalProgress(true);
    // Release the PeerJS id so a reload can reclaim the same room code quickly
    this.watchPartyService.disconnectKeepingSession();
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
        this.posterPath = data.poster_path ?? null;
        this.title = data.title || 'Unknown Movie'; // Set the title with a fallback
        this.rating = data.vote_average || 0;
        this.releaseDate = data.release_date || 'Unknown Release Date';
        this.details = data.overview || 'No details available.';
        this.isLoading = false; // Mark loading as complete

        this.openPlayer();
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
        this.posterPath = data.poster_path ?? null;
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
        this.syncWatchPartyMedia();
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
    this.resetServerFailoverState();
    this.fetchEpisodes(this.selectedSeason);
  }
  
  selectEpisode(episodeNumber: number): void {
    this.selectedEpisode = episodeNumber;
    this.resetServerFailoverState();
    this.updateEmbedUrl();
  }

  updateEmbedUrl(): void {
    if (this.mediaType === 'tv') {
      this.resetPlayerState();
      this.peachifyWantAutoPlay = true;
      this.vidfastWantAutoPlay = true;
      this.openPlayer();
      this.syncWatchPartyMedia();
    }
  }

  /** Mount local HLS or remote iframe for the active provider. */
  private openPlayer(resumeAt?: number): void {
    void this.openPlayerAsync(resumeAt);
  }

  private async openPlayerAsync(resumeAt?: number): Promise<void> {
    await this.ensureProviderPriority();

    if (this.usesLocalHls) {
      this.embedUrl = null;
      void this.loadLocalHlsVideo(resumeAt);
      return;
    }

    this.destroyApiplayerVideo();
    this.embedUrl = this.buildActiveEmbedUrl(resumeAt);
  }

  private resolveStartAt(resumeAt?: number): number {
    const cleared = this.watchProgress.isSuppressed(this.mediaType, this.id);
    if (cleared) {
      return 0;
    }
    // Explicit 0 must win (Peachify URL control / cleared seek) — don't fall back to saved
    if (resumeAt != null && Number.isFinite(resumeAt) && resumeAt >= 0) {
      return resumeAt;
    }
    return this.getSavedStartAt();
  }

  private buildActiveEmbedUrl(resumeAt?: number): SafeResourceUrl {
    switch (this.selectedProvider) {
      case 'cinemaos':
        return this.buildCinemaosEmbedUrl(resumeAt);
      case 'peachify':
        return this.buildPeachifyEmbedUrl(resumeAt);
      case 'videasy':
        return this.buildVideasyEmbedUrl(resumeAt);
      case 'vidup': {
        const path = this.getEmbedPath();
        return path
          ? this.buildVidupEmbedUrl(path, resumeAt)
          : this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
      }
      case 'vidfast':
      default: {
        const path = this.getEmbedPath();
        return path
          ? this.buildVidfastEmbedUrl(path, resumeAt)
          : this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
      }
    }
  }

  private buildEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    if (this.isCinemaosProvider) {
      return this.buildCinemaosEmbedUrl(resumeAt);
    }
    if (this.isPeachifyProvider) {
      return this.buildPeachifyEmbedUrl(resumeAt);
    }
    if (this.isVideasyProvider) {
      return this.buildVideasyEmbedUrl(resumeAt);
    }
    if (this.isVidupProvider) {
      return this.buildVidupEmbedUrl(path, resumeAt);
    }
    if (this.isApiplayerProvider || this.isVidphantomProvider) {
      return this.buildApiplayerEmbedUrl(path, resumeAt);
    }
    return this.buildVidfastEmbedUrl(path, resumeAt);
  }

  private buildCinemaosEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }

    const path =
      this.mediaType === 'tv'
        ? `player/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
        : `player/${this.id}`;

    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'e50914',
      showTitle: 'false',
      nextButton: this.mediaType === 'tv' ? 'true' : 'false',
      autoNext: this.mediaType === 'tv' ? 'true' : 'false',
    });

    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    this.embedStartAtSeconds = startAt;
    if (startAt > 0) {
      params.set('startTime', String(startAt));
    }

    const url = `https://cinemaos.tech/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private buildVidfastEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    const params = new URLSearchParams({
      autoPlay: this.vidfastWantAutoPlay ? 'true' : 'false',
      theme: 'red',
      title: 'false',
      // Reduce embed chrome so users rely on our custom controls instead
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
      // Force a real navigation on every play/pause/seek remount
      _cb: String(++this.vidfastEmbedNonce),
    });

    // Omit server in Auto mode so VidFast can find a working source itself
    if (!this.useAutoServer && this.selectedServer) {
      params.set('server', this.selectedServer);
    }

    if (this.selectedSubtitle) {
      params.set('sub', this.selectedSubtitle);
    }

    const startAt = this.resolveStartAt(resumeAt);
    // Always set startAt — omitting it lets VidFast resume from its own iframe cache
    // (which brought back cleared history timestamps).
    const flooredStart = Math.max(0, Math.floor(startAt));
    this.embedStartAtSeconds = flooredStart;
    params.set('startAt', String(flooredStart));

    if (this.mediaType === 'tv') {
      params.set('nextButton', 'true');
      params.set('autoNext', 'true');
    }

    const url = `https://vidfast.vc/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** https://vidup.to/ — same shape as VidFast (URL remount control). */
  private buildVidupEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    const params = new URLSearchParams({
      autoPlay: this.vidfastWantAutoPlay ? 'true' : 'false',
      theme: 'e50914',
      title: 'false',
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
      _cb: String(++this.vidfastEmbedNonce),
    });
    if (!this.useAutoServer && this.selectedServer) {
      params.set('server', this.selectedServer);
    }
    if (this.selectedSubtitle) {
      params.set('sub', this.selectedSubtitle);
    }
    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    this.embedStartAtSeconds = startAt;
    params.set('startAt', String(startAt));
    if (this.mediaType === 'tv') {
      params.set('nextButton', 'true');
      params.set('autoNext', 'true');
    }
    const url = `https://vidup.to/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /**
   * https://peachify.pro/ → https://peachify.top/embed/...
   * Parent→player commands are disabled; Luscreens controls via autoPlay + startAt reloads.
   * TV auto-next is off so season/episode stay locked to our picker.
   */
  private buildPeachifyEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }

    const season = Math.max(1, Math.floor(Number(this.selectedSeason) || 1));
    const episode = Math.max(1, Math.floor(Number(this.selectedEpisode) || 1));
    const path =
      this.mediaType === 'tv'
        ? `embed/tv/${this.id}/${season}/${episode}`
        : `embed/movie/${this.id}`;

    const params = new URLSearchParams({
      accent: 'e50914',
      // Hide Peachify chrome — Luscreens owns controls
      servers: 'hide',
      pip: 'hide',
      cast: 'hide',
      fullscreen: 'hide',
      volume: 'hide',
      captions: 'hide',
      quality: 'hide',
      rewind: 'hide',
      forward: 'hide',
      timegroup: 'hide',
      timeslider: 'hide',
      settings: 'hide',
      // Pin this exact S/E — Peachify's internal browser can otherwise drift
      ep: this.mediaType === 'tv' ? `s${season}e${episode}` : 'movie',
      // Force a real navigation on every play/pause/server switch
      _cb: String(++this.peachifyEmbedNonce),
    });

    // Docs: autoPlay defaults to true — only pass false to disable.
    // Explicit autoPlay=true after a pause remount is less reliable than omitting it.
    if (!this.peachifyWantAutoPlay) {
      params.set('autoPlay', 'false');
    }

    const peachifyPins = this.serversForProvider('peachify');
    // Always pin a source. Peachify's omit-server race often sticks on Iron
    // ("LOADING SOURCES" / others Waiting) and never recovers on its own.
    const pin = this.useAutoServer
      ? peachifyPins[0]
      : peachifyPins.includes(this.selectedServer)
        ? this.selectedServer
        : peachifyPins[0];
    if (pin) {
      params.set('server', pin);
    }

    // Docs expect subtitle labels (e.g. English), not ISO codes
    if (this.selectedSubtitle) {
      const subLabel =
        this.subtitleOptions.find((o) => o.code === this.selectedSubtitle)?.label ??
        this.selectedSubtitle;
      params.set('sub', subLabel);
    }

    // Always pin start — Peachify otherwise restores its own peachifyProgress cache
    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    this.embedStartAtSeconds = startAt;
    params.set('startAt', String(startAt));
    params.set('progress', String(startAt));
    params.set('t', String(startAt));

    if (this.mediaType === 'tv') {
      // Luscreens owns next/prev — Peachify auto-next was jumping to wrong episodes
      params.set('autoNext', 'false');
      params.set('showNextBtn', 'false');
    }

    const url = `https://peachify.top/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** https://www.videasy.to/docs → player.videasy.net */
  private buildVideasyEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }
    const path =
      this.mediaType === 'tv'
        ? `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
        : `movie/${this.id}`;
    const params = new URLSearchParams({
      color: 'e50914',
      overlay: 'false',
    });
    if (this.mediaType === 'tv') {
      params.set('nextEpisode', 'true');
      params.set('autoplayNextEpisode', 'true');
    }
    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    this.embedStartAtSeconds = startAt;
    if (startAt > 0) {
      params.set('progress', String(startAt));
    }
    const url = `https://player.videasy.net/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }


  private buildApiplayerEmbedUrl(path: string, _resumeAt?: number): SafeResourceUrl {
    // Kept for reference / provider switch fallback; ApiPlayer plays via direct HLS.
    const params = new URLSearchParams({
      autoplay: '1',
      resume: '0',
    });
    if (this.selectedSubtitle) {
      params.set('lang', this.selectedSubtitle);
    }
    if (this.mediaType === 'tv') {
      params.set('autonext', '1');
    }
    const url = `https://apiplayer.ru/embed/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private async loadLocalHlsVideo(resumeAt?: number): Promise<void> {
    if (!this.id || !this.mediaType || !this.usesLocalHls) {
      return;
    }

    const provider = this.selectedProvider;
    const loadToken = ++this.apiplayerLoadToken;
    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.destroyApiplayerVideo(false);
    this.apiplayerSurfaceActive = true;
    this.cdr.detectChanges();

    try {
      const mediaType = this.mediaType === 'tv' ? 'tv' : 'movie';
      const season = this.mediaType === 'tv' ? this.selectedSeason : undefined;
      const episode = this.mediaType === 'tv' ? this.selectedEpisode : undefined;

      let masterUrl: string;
      let mediaKind: 'hls' | 'mp4' = 'hls';
      if (provider === 'vidphantom') {
        const stream = await this.vidphantomStream.resolveStream({
          mediaType,
          id: this.id,
          season,
          episode,
        });
        masterUrl = stream.masterUrl;
      } else {
        const stream = await this.apiplayerStream.resolveStream({
          mediaType,
          id: this.id,
          season,
          episode,
        });
        if (stream.imdbId) {
          this.cachedImdbId = stream.imdbId;
        }
        masterUrl = stream.masterUrl;
      }

      if (loadToken !== this.apiplayerLoadToken || this.selectedProvider !== provider) {
        return;
      }

      await this.attachHlsToVideo(masterUrl, resumeAt, mediaKind);

      if (loadToken !== this.apiplayerLoadToken) {
        return;
      }

      this.clearPlayerReloading();
      this.beginClearedBootstrapIfNeeded();
      // Local stream attached — don't wait for play events or failover will steal the provider.
      this.serverPlaybackOk = true;
      this.clearServerFailoverWatch();
      if (this.selectedSubtitle) {
        void this.applySubtitleSelection(this.selectedSubtitle, false);
      }
      this.cdr.detectChanges();
    } catch (error) {
      console.error(`${provider} stream failed:`, error);
      if (loadToken !== this.apiplayerLoadToken) {
        return;
      }
      this.providersTriedThisTitle.add(provider);
      const next = this.nextFailoverProvider(provider);
      if (next) {
        this.selectedProvider = next;
        if (next === 'vidfast' || next === 'vidup' || next === 'peachify') {
          this.useAutoServer = true;
        }
        this.reloadPlayer(
          resumeAt ?? this.currentTime,
          `Trying ${this.activeProviderLabel}…`
        );
        return;
      }
      this.showNoServerFound();
      this.showNoServerFound();
    }
  }

  /**
   * Priority: #1 ApiPlayer, #2 VidFast, then remaining by lowest ping.
   * Failed / unknown pings sort last among the ping-ranked group.
   */
  private getProviderFailoverOrder(): StreamProvider[] {
    const byPing: StreamProvider[] = [
      'apiplayer',
      'vidfast',
      'cinemaos',
      'vidphantom',
      'peachify',
      'vidup',
      'videasy',
    ];
    const ranked = [...byPing].sort((a, b) => {
      const am =
        this.providerPingMs[a] == null || this.providerPingMs[a]! < 0
          ? Number.POSITIVE_INFINITY
          : this.providerPingMs[a]!;
      const bm =
        this.providerPingMs[b] == null || this.providerPingMs[b]! < 0
          ? Number.POSITIVE_INFINITY
          : this.providerPingMs[b]!;
      return am - bm;
    });
    return ranked;
  }

  /** Apply default provider once; pings order failover. */
  private ensureProviderPriority(): Promise<void> {
    if (!this.providerPriorityPromise) {
      this.providerPriorityPromise = this.resolveProviderPriority();
    }
    return this.providerPriorityPromise;
  }

  private async resolveProviderPriority(): Promise<void> {
    // Warm pings for failover order (non-blocking for primary)
    void this.refreshProviderPings(true);
    if (this.providerPriorityApplied) {
      return;
    }
    this.providerPriorityApplied = true;
    this.selectedProvider =
      (environment as { streamProvider?: StreamProvider }).streamProvider || 'apiplayer';
    this.cdr.detectChanges();
  }

  private nextFailoverProvider(from: StreamProvider): StreamProvider | null {
    const order = this.getProviderFailoverOrder();
    const start = Math.max(0, order.indexOf(from));
    for (let i = 1; i < order.length; i++) {
      const candidate = order[(start + i) % order.length];
      if (!this.providersTriedThisTitle.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private attachHlsToVideo(
    masterUrl: string,
    resumeAt?: number,
    mediaKind: 'hls' | 'mp4' = 'hls'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryAttach = (attempt: number): void => {
        const video = this.playerVideo?.nativeElement;
        if (!video) {
          if (attempt < 10) {
            setTimeout(() => tryAttach(attempt + 1), 50);
            return;
          }
          reject(new Error('Video element not ready'));
          return;
        }

        const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
        const onReady = (): void => {
          video.muted = false;
          video.volume = 1;
          if (startAt > 5) {
            video.currentTime = startAt;
          }
          void video.play().catch(() => {
            // Autoplay may be blocked until the user taps — controller still works.
          });
          resolve();
        };

        if (mediaKind === 'mp4' || /\.mp4(\?|$)/i.test(masterUrl)) {
          video.src = masterUrl;
          video.addEventListener('loadedmetadata', () => onReady(), { once: true });
          video.addEventListener('error', () => reject(new Error('MP4 playback failed')), {
            once: true,
          });
          return;
        }

        if (Hls.isSupported()) {
          const hls = new Hls({
            // Workers can decode audio-only / black frames under our overlay stack
            enableWorker: false,
            lowLatencyMode: false,
            startLevel: -1,
            capLevelToPlayerSize: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            backBufferLength: 30,
            fragLoadPolicy: {
              default: {
                maxTimeToFirstByteMs: 15000,
                maxLoadTimeMs: 60000,
                timeoutRetry: {
                  maxNumRetry: 3,
                  retryDelayMs: 500,
                  maxRetryDelayMs: 4000,
                },
                errorRetry: {
                  maxNumRetry: 3,
                  retryDelayMs: 500,
                  maxRetryDelayMs: 4000,
                },
              },
            },
          });
          this.hlsPlayer = hls;
          let settled = false;
          let blackRecoveries = 0;
          const finish = (err?: unknown): void => {
            if (settled) {
              return;
            }
            settled = true;
            video.removeEventListener('loadeddata', onFrame);
            video.removeEventListener('playing', onFrame);
            if (err) {
              reject(err);
              return;
            }
            onReady();
          };
          // Wait for a real video frame — timer/audio alone can look "playing" with a black screen
          const onFrame = (): void => {
            if (video.videoWidth > 0) {
              finish();
            }
          };
          hls.loadSource(masterUrl);
          hls.attachMedia(video);
          video.addEventListener('loadeddata', onFrame);
          video.addEventListener('playing', onFrame);
          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            const levels = data.levels || [];
            // Prefer a level that clearly has video resolution
            const pick = levels.findIndex((l) => (l.height || 0) >= 360);
            const fallback = levels.findIndex((l) => (l.height || 0) > 0);
            const start = pick >= 0 ? pick : fallback >= 0 ? fallback : 0;
            if (levels.length) {
              hls.startLevel = start;
              hls.currentLevel = start;
            }
            void video.play().catch(() => undefined);
            // If still black, bump quality / recover decoder (don't fake "ready")
            const nudge = (): void => {
              if (settled) {
                return;
              }
              if (video.videoWidth > 0) {
                finish();
                return;
              }
              if (blackRecoveries < 2 && levels.length > 1) {
                blackRecoveries += 1;
                const next = Math.min(levels.length - 1, start + blackRecoveries);
                try {
                  hls.currentLevel = next;
                  hls.recoverMediaError();
                  video.currentTime = Math.max(0, video.currentTime) + 0.05;
                  void video.play().catch(() => undefined);
                } catch {
                  // ignore
                }
                setTimeout(nudge, 2500);
                return;
              }
              finish(new Error('HLS started without a video frame'));
            };
            setTimeout(nudge, 3500);
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              finish(data);
            }
          });
          return;
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = masterUrl;
          video.addEventListener('loadedmetadata', () => onReady(), { once: true });
          video.addEventListener('error', () => reject(new Error('Native HLS failed')), {
            once: true,
          });
          return;
        }

        reject(new Error('HLS is not supported in this browser'));
      };

      tryAttach(0);
    });
  }

  private destroyApiplayerVideo(clearSurface = true): void {
    if (this.hlsPlayer) {
      this.hlsPlayer.destroy();
      this.hlsPlayer = null;
    }
    const video = this.playerVideo?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (clearSurface) {
      this.apiplayerSurfaceActive = false;
    }
  }

  onVideoPlay(): void {
    this.onPlayerEvent({
      event: 'play',
      currentTime: this.playerVideo?.nativeElement.currentTime ?? this.currentTime,
      duration: this.playerVideo?.nativeElement.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: true,
      muted: !!this.playerVideo?.nativeElement.muted,
      volume: this.playerVideo?.nativeElement.volume ?? 1,
    });
  }

  onVideoPause(): void {
    this.onPlayerEvent({
      event: 'pause',
      currentTime: this.playerVideo?.nativeElement.currentTime ?? this.currentTime,
      duration: this.playerVideo?.nativeElement.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: false,
      muted: !!this.playerVideo?.nativeElement.muted,
      volume: this.playerVideo?.nativeElement.volume ?? 1,
    });
  }

  onVideoTimeUpdate(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.onPlayerEvent({
      event: 'timeupdate',
      currentTime: video.currentTime,
      duration: video.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: !video.paused,
      muted: video.muted,
      volume: video.volume,
    });
  }

  onVideoSeeked(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.onPlayerEvent({
      event: 'seeked',
      currentTime: video.currentTime,
      duration: video.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: !video.paused,
      muted: video.muted,
      volume: video.volume,
    });
  }

  onVideoEnded(): void {
    const video = this.playerVideo?.nativeElement;
    this.onPlayerEvent({
      event: 'ended',
      currentTime: video?.currentTime ?? this.currentTime,
      duration: video?.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: false,
      muted: !!video?.muted,
      volume: video?.volume ?? 1,
    });
  }

  onVideoLoadedMetadata(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.duration = Number.isFinite(video.duration) ? video.duration : this.duration;
    this.markServerPlaybackOk(true);
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
    const time = resumeAt ?? this.currentTime;
    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;
    this.playerReloadLabel = label;
    this.isPlayerReloading = true;
    // Keep provider/server menus reachable while the new source boots
    this.showPlayerControls = true;
    this.clearControlsHideTimer();
    this.armReloadOverlayTimeout();

    if (this.usesLocalHls) {
      void this.loadLocalHlsVideo(time > 5 ? time : undefined);
      this.ensureFullscreenPreserved(stayFullscreen);
      return;
    }

    this.destroyApiplayerVideo();
    // Keep previous frame painted under the overlay; swap src on next tick
    this.playerSurfaceLocked = true;
    setTimeout(() => {
      this.openPlayer(time > 5 ? time : undefined);
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 50);
  }

  private armReloadOverlayTimeout(): void {
    if (this.reloadOverlayTimer != null) {
      clearTimeout(this.reloadOverlayTimer);
    }
    this.reloadOverlayTimer = setTimeout(() => {
      this.reloadOverlayTimer = null;
      if (this.isPlayerReloading) {
        this.isPlayerReloading = false;
        this.cdr.detectChanges();
      }
    }, FrameComponent.RELOAD_OVERLAY_MAX_MS);
  }

  private clearPlayerReloading(): void {
    if (this.reloadOverlayTimer != null) {
      clearTimeout(this.reloadOverlayTimer);
      this.reloadOverlayTimer = null;
    }
    this.isPlayerReloading = false;
  }

  onPlayerIframeLoad(): void {
    this.beginClearedBootstrapIfNeeded();
    this.requestPlayerStatus();
    this.clearPlayerReloading();
    // Server/provider remounts request autoPlay — keep UI in sync while the embed boots.
    // Early `playing:false` from the host must not leave a paused center button.
    if (this.isPeachifyProvider && this.peachifyWantAutoPlay) {
      this.isPlaying = true;
      this.peachifyIgnorePlayingUntil = Math.max(
        this.peachifyIgnorePlayingUntil,
        Date.now() + 3500
      );
    } else if (
      (this.isVidfastProvider || this.isVidupProvider) &&
      this.vidfastWantAutoPlay
    ) {
      this.isPlaying = true;
      this.vidfastIgnorePlayingUntil = Math.max(
        this.vidfastIgnorePlayingUntil,
        Date.now() + 3500
      );
    }
    if (this.skipNextFailoverArm) {
      this.skipNextFailoverArm = false;
      // Only suppress failover when we already had working playback (play/pause/seek remount).
      if (this.serverPlaybackOk) {
        this.clearServerFailoverWatch();
      } else {
        this.armServerFailoverWatch();
      }
    } else {
      this.armServerFailoverWatch();
    }
    // CinemaOS autoPlay starts muted by design. Do NOT unmute on load timers —
    // unmuted autoplay without a gesture pauses the embed and our failover then
    // hops to another provider mid-watch. Unmute happens on user play/tap instead.
    if (this.selectedSubtitle && !this.usesEmbedSubParam) {
      void this.applySubtitleSelection(this.selectedSubtitle, false);
    }
  }

  toggleCcMenu(): void {
    this.showCcMenu = !this.showCcMenu;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.revealPlayerControls();
  }

  toggleProviderMenu(): void {
    this.showProviderMenu = !this.showProviderMenu;
    this.showServerMenu = false;
    this.showCcMenu = false;
    this.revealPlayerControls();
    if (this.showProviderMenu) {
      void this.refreshProviderPings();
    }
  }

  toggleServerMenu(): void {
    if (!this.usesServerParam) {
      return;
    }
    this.showServerMenu = !this.showServerMenu;
    this.showProviderMenu = false;
    this.showCcMenu = false;
    this.revealPlayerControls();
  }

  /** pointerup so the click-shield can't swallow the gesture after the menu opens. */
  onServerMenuPick(event: Event, serverId: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectServer(serverId);
    this.revealPlayerControls();
  }

  /** 0–4 bars from RTT; 0 = error / unknown while idle. */
  getProviderSignalLevel(provider: StreamProvider): number {
    if (this.providerPingPending[provider]) {
      return -1;
    }
    const ms = this.providerPingMs[provider];
    if (ms == null || ms < 0) {
      return 0;
    }
    if (ms < 120) {
      return 4;
    }
    if (ms < 250) {
      return 3;
    }
    if (ms < 450) {
      return 2;
    }
    return 1;
  }

  formatProviderPing(provider: StreamProvider): string {
    if (this.providerPingPending[provider]) {
      return '…';
    }
    const ms = this.providerPingMs[provider];
    if (ms == null) {
      return '—';
    }
    if (ms < 0) {
      return 'fail';
    }
    return `${ms}ms`;
  }

  providerPingTone(provider: StreamProvider): string {
    const level = this.getProviderSignalLevel(provider);
    if (level >= 4) {
      return 'text-emerald-400';
    }
    if (level === 3) {
      return 'text-lime-400';
    }
    if (level === 2) {
      return 'text-amber-400';
    }
    if (level === 1) {
      return 'text-orange-400';
    }
    if (level === -1) {
      return 'text-white/40';
    }
    return 'text-red-400';
  }

  private async refreshProviderPings(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastProviderPingAt < 8000) {
      // Still refresh UI if we have nothing yet
      const missing = this.providerOptions.some(
        (p) => this.providerPingMs[p.id] == null && !this.providerPingPending[p.id]
      );
      if (!missing) {
        return;
      }
    }
    this.lastProviderPingAt = now;

    await Promise.all(
      this.providerOptions.map((provider) => this.pingProvider(provider.id))
    );
    this.cdr.detectChanges();
  }

  private async pingProvider(provider: StreamProvider): Promise<void> {
    this.providerPingPending[provider] = true;

    const url = `${this.providerPingUrls[provider]}?_=${Date.now()}`;
    const started = performance.now();
    let ms = -1;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      ms = Math.max(1, Math.round(performance.now() - started));
    } catch {
      // Abort / network error — still record elapsed if the attempt ran briefly
      const elapsed = Math.round(performance.now() - started);
      ms = elapsed > 50 ? elapsed : -1;
    }

    this.providerPingMs[provider] = ms;
    this.providerPingPending[provider] = false;
  }

  selectSubtitle(code: string | null): void {
    if (this.selectedSubtitle === code) {
      this.showCcMenu = false;
      return;
    }
    this.selectedSubtitle = code;
    this.showCcMenu = false;

    // VidFast (`sub=`) — soft-reload; clear our overlay so it doesn't stack on embed CC.
    if (this.usesEmbedSubParam) {
      this.clearSubtitles(false);
      this.reloadPlayer(
        this.currentTime,
        code ? 'Applying subtitles…' : 'Turning off subtitles…'
      );
      return;
    }

    // ApiPlayer / VidPhantom / CinemaOS: load cues ourselves (overlay only).
    void this.applySubtitleSelection(code);
  }

  /** Scrubber max — never 0 or the range input can only seek to 0. */
  get seekBarMax(): number {
    if (this.duration > 1) {
      return this.duration;
    }
    return Math.max(this.currentTime + 600, 7200);
  }

  selectProvider(provider: StreamProvider): void {
    if (this.selectedProvider === provider) {
      this.showProviderMenu = false;
      return;
    }
    this.providerPriorityApplied = true; // keep manual choice
    this.providerLockedByUser = true;
    this.selectedProvider = provider;
    this.peachifyWantAutoPlay = true;
    this.vidfastWantAutoPlay = true;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.resetServerFailoverState();
    // Prefer Auto when entering a host with its own server pins
    if (this.usesServerParam) {
      this.useAutoServer = true;
      const pins = this.serversForProvider(provider);
      if (pins.length && !pins.includes(this.selectedServer)) {
        this.selectedServer = pins[0];
      }
    }
    // Embed `sub=` hosts — drop our cue overlay so it doesn't double up
    if (this.usesEmbedSubParam) {
      this.clearSubtitles(false);
    }

    if (provider === 'peachify') {
      this.peachifyWantAutoPlay = true;
      this.isPlaying = true;
      this.playerReloadLabel = `Switching to ${this.activeProviderLabel}…`;
      this.remountPeachifyEmbed(Math.max(0, Math.floor(this.currentTime)));
      return;
    }

    this.reloadPlayer(
      this.currentTime,
      `Switching to ${this.activeProviderLabel}…`
    );
  }

  selectServer(server: string): void {
    if (!this.usesServerParam) {
      this.showServerMenu = false;
      return;
    }
    const wantsAuto = server === FrameComponent.AUTO_SERVER_ID;
    if (wantsAuto) {
      if (this.useAutoServer) {
        this.showServerMenu = false;
        return;
      }
      this.useAutoServer = true;
    } else {
      if (!this.useAutoServer && this.selectedServer === server) {
        this.showServerMenu = false;
        return;
      }
      this.useAutoServer = false;
      this.selectedServer = server;
    }
    this.showServerMenu = false;
    this.resetServerFailoverState();

    // Peachify / VidFast need a full iframe remount or ?server= is ignored
    if (this.isPeachifyProvider) {
      this.peachifyWantAutoPlay = true;
      this.isPlaying = true;
      this.playerReloadLabel = wantsAuto
        ? 'Finding a server…'
        : `Switching to ${server}…`;
      this.remountPeachifyEmbed(Math.max(0, Math.floor(this.currentTime)));
      return;
    }
    if (this.isVidfastProvider || this.isVidupProvider) {
      this.vidfastWantAutoPlay = true;
      this.isPlaying = true;
      this.playerReloadLabel = wantsAuto
        ? 'Finding a server…'
        : `Switching to ${server}…`;
      this.remountVidfastEmbed(Math.max(0, Math.floor(this.currentTime)));
      return;
    }

    this.reloadPlayer(
      this.currentTime,
      wantsAuto ? 'Finding a server…' : `Switching to ${server}…`
    );
  }

  private resetServerFailoverState(): void {
    this.clearServerFailoverWatch();
    this.serversTriedThisTitle.clear();
    this.providersTriedThisTitle.clear();
    this.serverPlaybackOk = false;
    this.lastPlaybackProgressSample = -1;
    this.embedStartAtSeconds = 0;
  }

  private switchProviderForFailover(next: StreamProvider): boolean {
    // Keep the user's manual provider pick — only cycle servers under it.
    if (this.providerLockedByUser) {
      return false;
    }
    this.selectedProvider = next;
    if (next === 'peachify' || next === 'vidfast' || next === 'vidup') {
      this.useAutoServer = true;
      this.peachifyWantAutoPlay = true;
      this.vidfastWantAutoPlay = true;
    }
    return true;
  }

  private clearServerFailoverWatch(): void {
    if (this.serverFailoverTimer != null) {
      clearTimeout(this.serverFailoverTimer);
      this.serverFailoverTimer = null;
    }
  }

  private armServerFailoverWatch(): void {
    this.clearServerFailoverWatch();
    if (this.serverPlaybackOk) {
      return;
    }

    this.providersTriedThisTitle.add(this.selectedProvider);

    // HLS / iframe hosts without server pins: try the next provider
    if (this.usesLocalHls || !this.usesServerParam) {
      this.serverFailoverTimer = setTimeout(() => {
        if (this.serverPlaybackOk) {
          return;
        }
        if (this.providerLockedByUser) {
          this.showNoServerFound();
          return;
        }
        const next = this.nextFailoverProvider(this.selectedProvider);
        if (!next || !this.switchProviderForFailover(next)) {
          this.showNoServerFound();
          return;
        }
        this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
      }, FrameComponent.APIPLAYER_FAILOVER_MS);
      return;
    }

    // Peachify Auto pins the first preferred source — mark that pin tried too so
    // failover does not immediately retry the same hung source.
    if (this.isPeachifyProvider && this.useAutoServer) {
      const softPin = this.serversForProvider('peachify')[0];
      if (softPin) {
        this.serversTriedThisTitle.add(softPin);
      }
      this.serversTriedThisTitle.add(FrameComponent.AUTO_SERVER_ID);
    } else {
      const triedKey = this.useAutoServer
        ? FrameComponent.AUTO_SERVER_ID
        : this.selectedServer;
      if (triedKey) {
        this.serversTriedThisTitle.add(triedKey);
      }
    }

    this.serverFailoverTimer = setTimeout(() => {
      if (this.serverPlaybackOk) {
        return;
      }
      this.tryNextServerFailover();
    }, this.isPeachifyProvider
      ? FrameComponent.PEACHIFY_FAILOVER_MS
      : FrameComponent.SERVER_FAILOVER_MS);
  }

  private markServerPlaybackOk(force = false): void {
    if (this.serverPlaybackOk) {
      return;
    }
    // Duration / startAt alone are not enough — VidFast error shells still report them.
    if (!force) {
      return;
    }
    this.serverPlaybackOk = true;
    this.clearServerFailoverWatch();
    this.clearPlayerReloading();
  }

  /** Confirm the stream is really moving (filters out 500 error pages / startAt echoes). */
  private notePlaybackProgress(reportedTime: number, eventName?: string): void {
    if (!Number.isFinite(reportedTime)) {
      return;
    }
    const name = String(eventName || '').toLowerCase();
    const isProgressEvent =
      name === 'timeupdate' || name === 'play' || name === 'seeked' || name === 'playerstatus';
    if (!isProgressEvent && name !== '') {
      return;
    }

    // CinemaOS / Videasy: a real play (+ duration) means the stream is up —
    // don't wait for a second tick or the 8s provider hop steals the session.
    if (
      (this.isCinemaosProvider || this.isVideasyProvider) &&
      name === 'play' &&
      this.duration > 1
    ) {
      this.lastPlaybackProgressSample = reportedTime;
      this.markServerPlaybackOk(true);
      return;
    }

    if (this.lastPlaybackProgressSample < 0) {
      this.lastPlaybackProgressSample = reportedTime;
      return;
    }

    // Require the clock to advance — Peachify/VidFast dump resume startAt + duration
    // while stuck on "LOADING SOURCES" / error shells; that must not cancel failover.
    const advancedFromSample =
      reportedTime > this.lastPlaybackProgressSample + 0.75;
    const advancedPastResume =
      reportedTime > this.embedStartAtSeconds + 0.9 &&
      this.lastPlaybackProgressSample <= this.embedStartAtSeconds + 0.5;

    if (advancedFromSample || advancedPastResume) {
      this.lastPlaybackProgressSample = reportedTime;
      this.markServerPlaybackOk(true);
      return;
    }

    this.lastPlaybackProgressSample = Math.max(this.lastPlaybackProgressSample, reportedTime);
  }

  private showNoServerFound(): void {
    this.playerReloadLabel = 'No working server found';
    this.isPlayerReloading = true;
    this.showPlayerControls = true;
    this.armReloadOverlayTimeout();
  }

  /** Current server pin never started — try next pin, then Auto, then next provider. */
  private tryNextServerFailover(force = false): void {
    if (this.serverPlaybackOk && !force) {
      return;
    }
    // Once a provider has actually played, never auto-hop away — only the user can.
    if (this.serverPlaybackOk && force) {
      return;
    }
    this.serverPlaybackOk = false;
    this.clearServerFailoverWatch();

    if (!this.usesServerParam) {
      if (this.providerLockedByUser) {
        this.showNoServerFound();
        return;
      }
      const next = this.nextFailoverProvider(this.selectedProvider);
      if (next && this.switchProviderForFailover(next)) {
        this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
        return;
      }
      this.showNoServerFound();
      return;
    }

    const pinnedServers = this.serverOptions
      .map((s) => s.id)
      .filter((id) => id !== FrameComponent.AUTO_SERVER_ID);

    // Prefer Auto first when nothing has been tried yet (VidFast/VidUP race).
    // Peachify skips this — its omit-server race hangs on dead sources.
    if (
      !this.isPeachifyProvider &&
      !this.serversTriedThisTitle.has(FrameComponent.AUTO_SERVER_ID)
    ) {
      this.useAutoServer = true;
      this.serversTriedThisTitle.add(FrameComponent.AUTO_SERVER_ID);
      this.reloadPlayer(this.currentTime, 'Finding a working server…');
      return;
    }

    const nextPinned = pinnedServers.find((id) => !this.serversTriedThisTitle.has(id));
    if (nextPinned) {
      this.useAutoServer = false;
      this.selectedServer = nextPinned;
      this.serversTriedThisTitle.add(nextPinned);
      this.reloadPlayer(this.currentTime, `Trying ${nextPinned}…`);
      return;
    }

    if (this.providerLockedByUser) {
      this.showNoServerFound();
      return;
    }

    const next = this.nextFailoverProvider(this.selectedProvider);
    if (next && this.switchProviderForFailover(next)) {
      this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
      return;
    }

    this.showNoServerFound();
  }

  private resetPlayerState(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.clearSeekGuard();
    this.clearSubtitles();
    this.cachedImdbId = null;
    this.beginClearedBootstrapIfNeeded();
  }

  private async applySubtitleSelection(
    code: string | null,
    showOverlay = true
  ): Promise<void> {
    const loadToken = ++this.subtitleLoadToken;
    this.clearSubtitles(false);

    if (!code) {
      this.isSubtitleLoading = false;
      this.cdr.detectChanges();
      return;
    }

    if (showOverlay) {
      this.playerReloadLabel = 'Loading subtitles…';
      this.isPlayerReloading = true;
    }
    this.isSubtitleLoading = true;
    this.cdr.detectChanges();

    try {
      const imdbId = await this.subtitleService.resolveImdbId({
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        tmdbId: this.id,
        tmdbApiKey: environment.tmdbApiKey,
        fallbackImdbId: this.cachedImdbId,
      });

      if (loadToken !== this.subtitleLoadToken) {
        return;
      }
      if (!imdbId) {
        throw new Error('No IMDb id for subtitles');
      }
      this.cachedImdbId = imdbId;

      const loaded = await this.subtitleService.loadCues({
        imdbId,
        lang: code,
        season: this.mediaType === 'tv' ? this.selectedSeason : undefined,
        episode: this.mediaType === 'tv' ? this.selectedEpisode : undefined,
      });

      if (loadToken !== this.subtitleLoadToken) {
        return;
      }
      if (!loaded) {
        throw new Error('No subtitles found');
      }

      this.subtitleCues = loaded.cues;
      this.subtitleVttUrl = loaded.vttUrl;
      // Overlay only — never enable native <track> (that stacked a second cue on screen)
      this.removeNativeSubtitleTracks();
      this.syncSubtitleOverlay();
    } catch (error) {
      console.error('Subtitle load failed:', error);
      if (loadToken === this.subtitleLoadToken) {
        this.selectedSubtitle = null;
        this.clearSubtitles(false);
      }
    } finally {
      if (loadToken === this.subtitleLoadToken) {
        this.isSubtitleLoading = false;
        if (showOverlay) {
          this.clearPlayerReloading();
        }
        this.cdr.detectChanges();
      }
    }
  }

  private removeNativeSubtitleTracks(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    Array.from(video.querySelectorAll('track[data-luscreens-sub="1"]')).forEach((el) => {
      el.remove();
    });
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (track.kind === 'subtitles' || track.kind === 'captions') {
        track.mode = 'disabled';
      }
    }
  }

  private syncSubtitleOverlay(): void {
    // VidFast uses embed `sub=` — never draw our overlay on top of theirs
    if (this.usesEmbedSubParam || !this.selectedSubtitle || this.subtitleCues.length === 0) {
      if (this.activeSubtitleText) {
        this.activeSubtitleText = '';
      }
      return;
    }
    this.activeSubtitleText = this.subtitleService.findActiveCueText(
      this.subtitleCues,
      this.currentTime
    );
  }

  private clearSubtitles(_keepSelection = true): void {
    this.activeSubtitleText = '';
    this.subtitleCues = [];
    this.subtitleService.revokeUrl(this.subtitleVttUrl);
    this.subtitleVttUrl = null;
    this.removeNativeSubtitleTracks();
  }

  private beginClearedBootstrapIfNeeded(): void {
    this.lastClearedRestartAt = 0;
    if (this.id && this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      this.clearedBootstrapUntil = Date.now() + 10000;
      this.clearedSessionReady = false;
      return;
    }
    this.clearedBootstrapUntil = 0;
    this.clearedSessionReady = true;
  }

  private handlePlayerMessage(event: MessageEvent): void {
    if (!event.data) {
      return;
    }

    const type = String(event.data?.type || '');

    // Live ApiPlayer build emits player:* / ended (docs' mplayer inbound API is not shipped)
    if (
      type === 'mplayer' ||
      type === 'player:timeupdate' ||
      type === 'player:play' ||
      type === 'player:pause' ||
      type === 'ended' ||
      type.startsWith('player:')
    ) {
      this.handleApiplayerMessage(event);
      return;
    }

    this.handleRemoteIframeMessage(event);
  }

  private isVidfastOrigin(origin: string): boolean {
    return this.vidfastOrigins.includes(origin) || /vidfast\./i.test(origin || '');
  }

  private isCinemaosOrigin(origin: string): boolean {
    return this.cinemaosOrigins.includes(origin) || /cinemaos\./i.test(origin || '');
  }

  private isVidphantomOrigin(origin: string): boolean {
    return this.vidphantomOrigins.includes(origin) || /vidphantom\./i.test(origin || '');
  }

  private isPeachifyOrigin(origin: string): boolean {
    return this.peachifyOrigins.includes(origin) || /peachify\./i.test(origin || '');
  }

  private isVidupOrigin(origin: string): boolean {
    return this.vidupOrigins.includes(origin) || /vidup\./i.test(origin || '');
  }


  private isVideasyOrigin(origin: string): boolean {
    return this.videasyOrigins.includes(origin) || /videasy\./i.test(origin || '');
  }

  private isRemoteIframeOrigin(origin: string): boolean {
    return (
      this.isVidfastOrigin(origin) ||
      this.isCinemaosOrigin(origin) ||
      this.isVidphantomOrigin(origin) ||
      this.isPeachifyOrigin(origin) ||
      this.isVidupOrigin(origin) ||
      this.isVideasyOrigin(origin)
    );
  }

  private isApiplayerOrigin(origin: string): boolean {
    return this.apiplayerOrigins.includes(origin) || /apiplayer\./i.test(origin || '');
  }

  private handleApiplayerMessage(event: MessageEvent): void {
    if (event.origin && !this.isApiplayerOrigin(event.origin)) {
      return;
    }

    const payload = event.data as ApiplayerMessage;
    const type = String(payload?.type || '').toLowerCase();

    // Documented mplayer envelope (if a future build ships it)
    if (type === 'mplayer') {
      this.handleApiplayerMplayerEnvelope(payload);
      return;
    }

    // Shipped player.min.js outbound events
    if (type === 'player:timeupdate') {
      this.onPlayerEvent({
        event: 'timeupdate',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: true,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'player:play') {
      this.onPlayerEvent({
        event: 'play',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: true,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'player:pause') {
      this.onPlayerEvent({
        event: 'pause',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: false,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'ended') {
      this.onPlayerEvent({
        event: 'ended',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: false,
        muted: false,
        volume: 1,
      });
    }
  }

  private handleApiplayerMplayerEnvelope(payload: ApiplayerMessage): void {
    const eventName = String(payload.event || '').toLowerCase();

    if (eventName === 'error') {
      if (this.usesLocalHls && !this.serverPlaybackOk && !this.providerLockedByUser) {
        const failed = this.selectedProvider;
        const next = this.nextFailoverProvider(failed);
        if (next && this.switchProviderForFailover(next)) {
          this.providersTriedThisTitle.add(failed);
          this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
        }
      }
      return;
    }

    const playing =
      eventName === 'play'
        ? true
        : eventName === 'pause' || eventName === 'ended'
          ? false
          : payload.paused === false
            ? true
            : this.isPlaying;

    const mappedEvent: PlayerEventName =
      eventName === 'play' ||
      eventName === 'pause' ||
      eventName === 'ended' ||
      eventName === 'timeupdate'
        ? eventName
        : 'playerstatus';

    this.onPlayerEvent({
      event: mappedEvent,
      currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
      duration: Number(payload.duration ?? this.duration) || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing,
      muted: !!payload.muted,
      volume: Number(payload.volume ?? 1),
    });
  }

  private handleRemoteIframeMessage(event: MessageEvent): void {
    if (!this.isRemoteIframeOrigin(event.origin || '')) {
      return;
    }

    // Videasy often posts a JSON string (progress / timestamp)
    let payload: unknown = event.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const envelope = payload as Record<string, unknown>;
    const type = envelope?.['type'] || envelope?.['eventType'] || envelope?.['event'];
    const data =
      (envelope?.['data'] as Record<string, unknown> | undefined) ??
      (envelope?.['payload'] as Record<string, unknown> | undefined) ??
      envelope;

    // Videasy progress payload: { id, type, progress, timestamp, duration, season, episode }
    if (
      this.isVideasyOrigin(event.origin || '') &&
      data &&
      typeof data === 'object' &&
      ('timestamp' in data || 'progress' in data) &&
      'duration' in data
    ) {
      const ts = Number((data as { timestamp?: number }).timestamp);
      const dur = Number((data as { duration?: number }).duration);
      this.onPlayerEvent({
        event: 'timeupdate',
        currentTime: Number.isFinite(ts) ? ts : this.currentTime,
        duration: Number.isFinite(dur) ? dur : this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: this.isPlaying,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'PLAYER_EVENT' && data) {
      const raw =
        data &&
        typeof data === 'object' &&
        'data' in data &&
        typeof (data as { data?: unknown }).data === 'object' &&
        (data as { data: { event?: unknown } }).data?.event != null
          ? ((data as { data: Record<string, unknown> }).data as Record<string, unknown>)
          : (data as Record<string, unknown>);
      const eventData = { ...(raw as unknown as PlayerEventData) };
      const name = String(eventData.event || raw['event'] || '').toLowerCase();
      if (name === 'time') {
        eventData.event = 'timeupdate';
      } else if (name === 'complete') {
        eventData.event = 'ended';
      } else if (
        name === 'play' ||
        name === 'pause' ||
        name === 'seeked' ||
        name === 'ended' ||
        name === 'timeupdate'
      ) {
        eventData.event = name;
      }
      if (typeof eventData.playing !== 'boolean') {
        const normalized = String(eventData.event || '').toLowerCase();
        if (normalized === 'play') {
          eventData.playing = true;
        } else if (normalized === 'pause' || normalized === 'ended') {
          eventData.playing = false;
        }
      }
      this.onPlayerEvent(eventData);
      this.cdr.detectChanges();
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      return;
    }

    if (type === 'PLAYER_NEXT_EPISODE') {
      this.nextEpisode();
      return;
    }

    const errorType = String(type || '').toLowerCase();
    if (
      errorType.includes('error') ||
      errorType === 'playback_error' ||
      errorType === 'player_error'
    ) {
      // CinemaOS (and other iframes) emit soft/transient error messages while
      // buffering or unmuting — never steal a working stream mid-playback.
      if (this.serverPlaybackOk || this.providerLockedByUser) {
        return;
      }
      if (this.usesServerParam) {
        this.tryNextServerFailover(true);
      } else {
        const failed = this.selectedProvider;
        this.providersTriedThisTitle.add(failed);
        const next = this.nextFailoverProvider(failed);
        if (next && this.switchProviderForFailover(next)) {
          this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
        }
      }
      return;
    }

    const loose = data as unknown as PlayerEventData;
    if (
      data &&
      typeof data === 'object' &&
      ('currentTime' in data || 'event' in data) &&
      (loose.event || loose.playing !== undefined)
    ) {
      this.onPlayerEvent(loose);
    }
  }

  private onPlayerEvent(data: PlayerEventData): void {
    const reportedTime = Number(data.currentTime);
    const hasReportedTime = Number.isFinite(reportedTime);
    const now = Date.now();
    const seekGuardActive =
      this.lastSeekTarget != null && now < this.seekGuardUntil;

    if (seekGuardActive && hasReportedTime) {
      this.handleSeekGuardUpdate(reportedTime, data.event);
    } else if (!this.isSeeking || data.event === 'seeked') {
      if (hasReportedTime) {
        // Keep prior time when embed briefly reports 0 after a real seek.
        if (!(reportedTime < 1 && this.currentTime > 8 && data.event !== 'seeked')) {
          this.currentTime = reportedTime;
        }
      }
    }

    const reportedDuration = Number(data.duration);
    if (Number.isFinite(reportedDuration) && reportedDuration > 1) {
      this.duration = reportedDuration;
    }
    const wasPlaying = this.isPlaying;
    const peachifyLockPlaying = this.isPeachifyProvider && Date.now() < this.peachifyIgnorePlayingUntil;
    const vidfastLockPlaying =
      (this.isVidfastProvider || this.isVidupProvider) &&
      Date.now() < this.vidfastIgnorePlayingUntil;
    if (typeof data.playing === 'boolean' && !peachifyLockPlaying && !vidfastLockPlaying) {
      this.isPlaying = data.playing;
    }

    // Peachify may restore a different S/E from its own progress cache — pin ours
    if (this.reassertPeachifyEpisodeIfDrifted(data)) {
      return;
    }

    // Cleared titles: VidFast may ignore startAt=0 and jump to its own cached time
    if (this.enforceClearedRestart()) {
      return;
    }

    const eventName = String(data.event || '').toLowerCase();
    if (eventName === 'error' || eventName === 'playbackerror') {
      // Don't yank a healthy CinemaOS/VidFast session for a one-off buffer error.
      if (this.serverPlaybackOk || this.providerLockedByUser) {
        return;
      }
      this.serverPlaybackOk = false;
      this.lastPlaybackProgressSample = -1;
      this.tryNextServerFailover(true);
      return;
    }

    if (hasReportedTime) {
      this.notePlaybackProgress(reportedTime, data.event);
    }

    switch (data.event) {
      case 'play':
        if (!peachifyLockPlaying && !vidfastLockPlaying) {
          this.isPlaying = true;
        }
        // CinemaOS / Videasy play events are trustworthy — lock failover immediately.
        if (this.isCinemaosProvider || this.isVideasyProvider) {
          this.markServerPlaybackOk(true);
        }
        // CinemaOS forces muted=true on autoPlay — lift only on a real user gesture.
        // Unmuting from here (or iframe load timers) can pause the embed and trip failover.
        this.broadcastWatchPartyEvent('play', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'pause':
        if (!peachifyLockPlaying && !vidfastLockPlaying) {
          this.isPlaying = false;
        }
        this.broadcastWatchPartyEvent('pause', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'ended':
        this.isPlaying = false;
        this.clearSeekGuard();
        this.persistLocalProgress(true);
        // Peachify auto-next is off — advance with Luscreens episode list
        if (this.isPeachifyProvider && this.mediaType === 'tv') {
          this.nextEpisode();
        }
        break;
      case 'seeked':
        if (
          this.lastSeekTarget == null ||
          Math.abs((hasReportedTime ? reportedTime : this.currentTime) - this.lastSeekTarget) <= 2.5
        ) {
          this.clearSeekGuard();
        }
        this.broadcastWatchPartyEvent('seeked', this.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'timeupdate':
        this.syncSubtitleOverlay();
        this.persistLocalProgress(false);
        break;
      case 'playerstatus':
        this.syncSubtitleOverlay();
        this.persistLocalProgress(false);
        break;
      default:
        // Still persist when we get timed updates without a named event
        if (typeof data.currentTime === 'number' && data.currentTime > 0) {
          this.persistLocalProgress(false);
        }
        break;
    }

    if (wasPlaying !== this.isPlaying) {
      this.onPlaybackStateChanged();
    }
  }

  private handleSeekGuardUpdate(reportedTime: number, event?: string): void {
    const target = this.lastSeekTarget ?? this.currentTime;
    const delta = Math.abs(reportedTime - target);

    if (delta <= 1.75) {
      this.currentTime = reportedTime;
      this.clearSeekGuard();
      return;
    }

    // Hold UI on the scrub target while the embed catches up / fights us.
    this.currentTime = target;
    this.isSeeking = true;

    // CinemaOS sometimes ignores the first seek or snaps to 0 — re-issue.
    const snappedToStart = reportedTime < 1.5 && target > 5;
    const drifted = delta > 3;
    if ((snappedToStart || drifted) && (event === 'timeupdate' || event === 'seeked' || event === 'playerstatus')) {
      this.scheduleSeekRetry(target);
    }
  }

  private scheduleSeekRetry(target: number): void {
    if (this.seekRetryTimer != null) {
      return;
    }
    this.seekRetryTimer = setTimeout(() => {
      this.seekRetryTimer = null;
      if (this.lastSeekTarget == null || Date.now() > this.seekGuardUntil) {
        return;
      }
      this.postPlayerCommand('seek', target);
    }, FrameComponent.SEEK_RETRY_MS);
  }

  private clearSeekGuard(): void {
    this.isSeeking = false;
    this.lastSeekTarget = null;
    this.seekGuardUntil = 0;
    if (this.seekRetryTimer != null) {
      clearTimeout(this.seekRetryTimer);
      this.seekRetryTimer = null;
    }
  }

  /**
   * Cleared titles only: once, briefly after load, snap embed-cache resume back to 0.
   * Never runs after the user seeks or after we have seen a near-zero start.
   */
  private enforceClearedRestart(): boolean {
    if (!this.id || !this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      return false;
    }
    if (this.currentTime <= 8) {
      this.clearedSessionReady = true;
      return false;
    }
    // User scrubbing / skip buttons / already past bootstrap — allow free seeking
    if (this.isSeeking || this.clearedSessionReady || Date.now() > this.clearedBootstrapUntil) {
      return false;
    }
    const now = Date.now();
    if (now - this.lastClearedRestartAt < 1500) {
      this.currentTime = 0;
      return true;
    }
    this.lastClearedRestartAt = now;
    this.currentTime = 0;
    this.postPlayerCommand('seek', 0);
    return true;
  }

  private persistLocalProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLocalProgressSaveAt < 3000) {
      return;
    }
    if (!this.id) {
      return;
    }

    if (this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      // Wait until we confirmed a fresh start (or user took control via seek)
      if (!this.clearedSessionReady) {
        return;
      }
      if (this.currentTime < 15) {
        return;
      }
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

  /**
   * Same Luscreens controller for every provider:
   * - ApiPlayer / VidPhantom → direct <video> / HLS commands
   * - Peachify / VidFast / VidUP → URL reload (`autoPlay` + `startAt`)
   * - CinemaOS / Videasy → iframe postMessage { command }
   */
  private postPlayerCommand(command: PlayerCommand, time?: number): void {
    if (this.usesLocalHls) {
      this.controlApiplayerVideo(command, time);
      return;
    }

    if (this.isPeachifyProvider) {
      this.controlPeachifyViaUrl(command, time);
      return;
    }

    // VidFast / VidUP: inbound postMessage is ignored by the live player — remount instead
    if (this.isVidfastProvider || this.isVidupProvider) {
      this.controlVidfastViaUrl(command, time);
      return;
    }

    const contentWindow = this.getPlayerContentWindow();
    if (!contentWindow) {
      return;
    }

    if (command === 'play') {
      this.unmuteRemotePlayer();
    }

    this.dispatchRemotePlayerCommand(contentWindow, command, time);

    if (
      this.isCinemaosProvider &&
      (command === 'play' || command === 'pause' || command === 'seek')
    ) {
      setTimeout(() => {
        const win = this.getPlayerContentWindow();
        if (win) {
          this.dispatchRemotePlayerCommand(win, command, time);
        }
      }, 250);
    }
  }

  /** Prefer ViewChild; fall back to a live DOM query after *ngIf remounts. */
  private getPlayerContentWindow(): Window | null {
    const fromRef = this.playerIframe?.nativeElement?.contentWindow ?? null;
    if (fromRef) {
      return fromRef;
    }
    const iframe = this.playerContainer?.nativeElement?.querySelector(
      'iframe.player-embed'
    ) as HTMLIFrameElement | null;
    return iframe?.contentWindow ?? null;
  }

  /**
   * VidFast docs accept object + JSON-stringified envelopes.
   * Seek uses both `time` and `value` because hosts disagree on the field name.
   */
  private dispatchRemotePlayerCommand(
    win: Window,
    command: PlayerCommand,
    time?: number
  ): void {
    const at = time ?? this.currentTime;
    const payloads: unknown[] = [
      this.toRemoteIframeCommand(command, time),
      { command },
      { type: 'PLAYER_COMMAND', command },
      { type: 'command', command },
      JSON.stringify({ command }),
    ];

    if (command === 'seek') {
      payloads.push(
        { command: 'seek', time: at },
        { command: 'seek', value: at },
        { command: 'seek', seconds: at },
        { type: 'PLAYER_COMMAND', command: 'seek', time: at },
        { type: 'PLAYER_COMMAND', command: 'seek', value: at },
        JSON.stringify({ command: 'seek', time: at }),
        JSON.stringify({ command: 'seek', value: at })
      );
    } else if (time != null) {
      payloads.push(
        { command, time: at },
        JSON.stringify({ command, time: at })
      );
    } else {
      payloads.push(JSON.stringify({ command }));
    }

    const origins = ['*', ...this.remoteCommandOrigins()];
    for (const payload of payloads) {
      for (const origin of origins) {
        try {
          win.postMessage(payload, origin);
        } catch {
          // ignore closed / mismatched target
        }
      }
    }
  }

  private remoteCommandOrigins(): string[] {
    if (this.isVidfastProvider) {
      return this.vidfastOrigins;
    }
    if (this.isVidupProvider) {
      return this.vidupOrigins;
    }
    if (this.isCinemaosProvider) {
      return this.cinemaosOrigins;
    }
    if (this.isVideasyProvider) {
      return this.videasyOrigins;
    }
    return [];
  }

  /** If Peachify's PLAYER_EVENT S/E ≠ our picker, force the embed path back. */
  private reassertPeachifyEpisodeIfDrifted(data: PlayerEventData): boolean {
    if (!this.isPeachifyProvider || this.mediaType !== 'tv') {
      return false;
    }
    const season = Math.floor(Number(data.season));
    const episode = Math.floor(Number(data.episode));
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return false;
    }
    if (season === this.selectedSeason && episode === this.selectedEpisode) {
      return false;
    }
    const now = Date.now();
    if (now < this.peachifyEpisodeReassertUntil) {
      return true;
    }
    this.peachifyEpisodeReassertUntil = now + 4000;
    this.peachifyWantAutoPlay = this.isPlaying || this.peachifyWantAutoPlay;
    this.embedUrl = this.buildPeachifyEmbedUrl(
      Math.max(0, Math.floor(this.currentTime))
    );
    this.cdr.detectChanges();
    return true;
  }

  /**
   * Peachify has no inbound command bridge — rebuild embed with autoPlay + startAt.
   * Must tear down the iframe (`embedUrl = null`) or browsers keep the old playback.
   * Do not touch `isPlaying` here — `togglePlayPause` already flips it once.
   */
  private controlPeachifyViaUrl(command: PlayerCommand, time?: number): void {
    if (command === 'getStatus') {
      return;
    }

    const at = Math.max(0, Math.floor(time ?? this.currentTime));

    if (command === 'play') {
      this.peachifyWantAutoPlay = true;
    } else if (command === 'pause') {
      this.peachifyWantAutoPlay = false;
    }

    this.currentTime = at;
    this.lastSeekTarget = at;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.peachifyIgnorePlayingUntil = Date.now() + 2800;

    // Still try postMessage in case the host re-enables inbound control
    this.tryPeachifyPostMessage(command, at);

    if (this.peachifyControlTimer != null) {
      clearTimeout(this.peachifyControlTimer);
      this.peachifyControlTimer = null;
    }

    const delayMs = command === 'seek' ? 220 : 0;
    const apply = (): void => {
      this.peachifyControlTimer = null;
      this.remountPeachifyEmbed(at);
    };

    if (delayMs > 0) {
      this.peachifyControlTimer = setTimeout(apply, delayMs);
    } else {
      apply();
    }
  }

  /**
   * VidFast / VidUP — rebuild embed with autoPlay + startAt (postMessage is ignored).
   * Tear down the iframe so browsers always navigate.
   */
  private controlVidfastViaUrl(command: PlayerCommand, time?: number): void {
    if (command === 'getStatus') {
      return;
    }

    const at = Math.max(0, Math.floor(time ?? this.currentTime));

    if (command === 'play') {
      this.vidfastWantAutoPlay = true;
    } else if (command === 'pause') {
      this.vidfastWantAutoPlay = false;
    }
    // seek keeps current autoPlay intent (playing stays playing)

    this.currentTime = at;
    this.lastSeekTarget = at;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.vidfastIgnorePlayingUntil = Date.now() + 2800;

    // Best-effort postMessage in case a host build starts honoring it
    const win = this.getPlayerContentWindow();
    if (win) {
      this.dispatchRemotePlayerCommand(win, command, at);
    }

    if (this.vidfastControlTimer != null) {
      clearTimeout(this.vidfastControlTimer);
      this.vidfastControlTimer = null;
    }

    const delayMs = command === 'seek' ? 180 : 0;
    const apply = (): void => {
      this.vidfastControlTimer = null;
      this.remountVidfastEmbed(at);
    };

    if (delayMs > 0) {
      this.vidfastControlTimer = setTimeout(apply, delayMs);
    } else {
      apply();
    }
  }

  private remountVidfastEmbed(startAt: number): void {
    if (!this.isVidfastProvider && !this.isVidupProvider) {
      return;
    }
    if (this.vidfastRemountTimer != null) {
      clearTimeout(this.vidfastRemountTimer);
      this.vidfastRemountTimer = null;
    }

    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;
    const path = this.getEmbedPath();
    if (!path) {
      return;
    }

    const hadPlayback = this.serverPlaybackOk;
    const wantPlay = this.vidfastWantAutoPlay;
    this.skipNextFailoverArm = hadPlayback;
    this.clearServerFailoverWatch();
    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.showPlayerControls = true;
    this.armReloadOverlayTimeout();
    this.destroyApiplayerVideo();

    if (wantPlay) {
      this.vidfastIgnorePlayingUntil = Date.now() + 5000;
      this.isPlaying = true;
      // Destroy + recreate in the same click turn (no setTimeout) so autoPlay
      // keeps the user gesture. In-place src updates leave the embed paused.
      this.playerSurfaceLocked = true;
      this.embedUrl = null;
      this.cdr.detectChanges();
      this.embedUrl = this.isVidupProvider
        ? this.buildVidupEmbedUrl(path, startAt)
        : this.buildVidfastEmbedUrl(path, startAt);
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
      return;
    }

    this.playerSurfaceLocked = true;
    this.embedUrl = null;
    this.cdr.detectChanges();

    this.vidfastRemountTimer = setTimeout(() => {
      this.vidfastRemountTimer = null;
      if (!this.isVidfastProvider && !this.isVidupProvider) {
        this.playerSurfaceLocked = false;
        return;
      }
      this.embedUrl = this.isVidupProvider
        ? this.buildVidupEmbedUrl(path, startAt)
        : this.buildVidfastEmbedUrl(path, startAt);
      this.isPlaying = this.vidfastWantAutoPlay;
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 30);
  }

  /** Tear down + rebuild so `autoPlay` / `startAt` changes always take effect. */
  private remountPeachifyEmbed(startAt: number): void {
    if (!this.isPeachifyProvider) {
      return;
    }
    if (this.peachifyRemountTimer != null) {
      clearTimeout(this.peachifyRemountTimer);
      this.peachifyRemountTimer = null;
    }

    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;
    const hadPlayback = this.serverPlaybackOk;
    const wantPlay = this.peachifyWantAutoPlay;

    this.skipNextFailoverArm = hadPlayback;
    this.clearServerFailoverWatch();
    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.showPlayerControls = true;
    this.armReloadOverlayTimeout();
    this.destroyApiplayerVideo();

    if (wantPlay) {
      this.peachifyIgnorePlayingUntil = Date.now() + 5000;
      this.isPlaying = true;
      // Must destroy the iframe (not just change src) or Peachify keeps the old
      // paused session. Do it in the same click turn — setTimeout drops the
      // user gesture and browsers block autoPlay after a server pick.
      this.playerSurfaceLocked = true;
      this.embedUrl = null;
      this.cdr.detectChanges();
      this.embedUrl = this.buildPeachifyEmbedUrl(startAt);
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
      return;
    }

    // Pause path: full teardown so autoPlay=false always sticks
    this.playerSurfaceLocked = true;
    this.embedUrl = null;
    this.cdr.detectChanges();

    this.peachifyRemountTimer = setTimeout(() => {
      this.peachifyRemountTimer = null;
      if (!this.isPeachifyProvider) {
        this.playerSurfaceLocked = false;
        return;
      }
      this.embedUrl = this.buildPeachifyEmbedUrl(startAt);
      this.isPlaying = this.peachifyWantAutoPlay;
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 30);
  }

  /** Re-enter fullscreen if a remount dropped the native fullscreen element. */
  private ensureFullscreenPreserved(shouldBeFullscreen: boolean): void {
    if (!shouldBeFullscreen) {
      return;
    }
    this.isFullscreen = true;
    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }
    if (document.fullscreenElement === container) {
      return;
    }
    if (this.cssFullscreenFallback) {
      return;
    }
    // Best-effort restore (may no-op without a user gesture on some browsers)
    void container.requestFullscreen?.().catch(() => {
      this.cssFullscreenFallback = true;
      this.isFullscreen = true;
      this.cdr.detectChanges();
    });
  }

  private tryPeachifyPostMessage(command: PlayerCommand, time: number): void {
    const win = this.playerIframe?.nativeElement?.contentWindow;
    if (!win) {
      return;
    }
    const payloads: unknown[] = [
      { command },
      { command, time },
      { type: 'PLAYER_COMMAND', command, time },
      { type: 'command', command, time },
      JSON.stringify({ command }),
      JSON.stringify({ command, time }),
    ];
    if (command === 'seek') {
      payloads.push(
        { command: 'seek', time },
        { command: 'seek', value: time },
        { command: 'seek', seconds: time }
      );
    }
    for (const payload of payloads) {
      try {
        win.postMessage(payload, '*');
        win.postMessage(payload, 'https://peachify.top');
      } catch {
        // ignore cross-origin / closed frame
      }
    }
  }

  /**
   * Unmute iframe / local HLS after a user gesture (or CinemaOS muted autoPlay).
   * Keep payloads minimal — flooding alternate command shapes can confuse VidFast.
   */
  private unmuteRemotePlayer(): void {
    if (this.usesLocalHls) {
      const video = this.playerVideo?.nativeElement;
      if (video) {
        video.muted = false;
        video.volume = 1;
      }
      return;
    }
    const contentWindow = this.getPlayerContentWindow();
    if (!contentWindow) {
      return;
    }
    const payloads: unknown[] = [
      { command: 'mute', muted: false },
      { command: 'volume', level: 1 },
      JSON.stringify({ command: 'mute', muted: false }),
      JSON.stringify({ command: 'volume', level: 1 }),
    ];
    for (const payload of payloads) {
      try {
        contentWindow.postMessage(payload, '*');
      } catch {
        // ignore cross-origin / closed frame
      }
    }
  }

  private controlApiplayerVideo(command: PlayerCommand, time?: number): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    switch (command) {
      case 'play':
        video.muted = false;
        video.volume = 1;
        void video.play().catch(() => undefined);
        break;
      case 'pause':
        video.pause();
        break;
      case 'seek':
        video.currentTime = Math.max(0, time ?? this.currentTime);
        break;
      case 'getStatus':
        this.onPlayerEvent({
          event: 'playerstatus',
          currentTime: video.currentTime,
          duration: video.duration || this.duration,
          tmdbId: +this.id || 0,
          mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
          season: this.selectedSeason,
          episode: this.selectedEpisode,
          playing: !video.paused,
          muted: video.muted,
          volume: video.volume,
        });
        break;
    }
  }

  private toRemoteIframeCommand(
    command: PlayerCommand,
    time?: number
  ): Record<string, unknown> {
    if (command === 'seek') {
      return { command: 'seek', time: time ?? this.currentTime };
    }
    if (command === 'getStatus') {
      return { command: 'getStatus' };
    }
    return { command, ...(time != null ? { time } : {}) };
  }

  togglePlayPause(): void {
    if (!this.canControlPartyPlayback) {
      this.revealPlayerControls();
      return;
    }
    const nextPlaying = !this.isPlaying;
    // Peachify / VidFast / VidUP: set autoPlay intent before remount
    if (this.isPeachifyProvider) {
      this.peachifyWantAutoPlay = nextPlaying;
      this.isPlaying = nextPlaying;
      this.postPlayerCommand(nextPlaying ? 'play' : 'pause');
      this.onPlaybackStateChanged();
      return;
    }
    if (this.isVidfastProvider || this.isVidupProvider) {
      this.vidfastWantAutoPlay = nextPlaying;
      this.isPlaying = nextPlaying;
      this.postPlayerCommand(nextPlaying ? 'play' : 'pause');
      this.onPlaybackStateChanged();
      return;
    }
    this.unmuteRemotePlayer();
    this.postPlayerCommand(nextPlaying ? 'play' : 'pause');
    // Optimistic UI so controls don't hide before the player event arrives
    this.isPlaying = nextPlaying;
    this.onPlaybackStateChanged();
  }

  get seekProgressPercent(): string {
    const max = this.seekBarMax;
    if (!max || max <= 0) {
      return '0%';
    }
    const pct = Math.min(100, Math.max(0, (this.currentTime / max) * 100));
    return `${pct}%`;
  }

  /**
   * One tap outside the center toggles controls (show ↔ hide).
   * Uses pointerup so mobile doesn't get mousemove-show + click-hide.
   */
  onPlayerSurfacePointerUp(event: PointerEvent): void {
    if (this.isPlayerReloading) {
      return;
    }
    // Don't steal taps meant for provider / server / CC menus
    if (this.showServerMenu || this.showProviderMenu || this.showCcMenu) {
      return;
    }
    // Center button handles play/pause; ignore bubbled pointerup from it
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.player-center-hit')) {
      return;
    }
    // Only primary button / touch / pen
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (Date.now() < this.controlsToggleSuppressedUntil) {
      return;
    }

    event.preventDefault();
    if (this.showPlayerControls) {
      this.hidePlayerControls();
      return;
    }
    this.revealPlayerControls();
    // Swallow the synthetic click that follows touch/pen
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  /** Center hit only: toggle play/pause. */
  onCenterPlayPauseTap(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.isPlayerReloading) {
      return;
    }
    // User gesture — safe to unmute muted autoplay (VidFast / CinemaOS / etc.)
    this.unmuteRemotePlayer();
    this.revealPlayerControls();
    if (!this.canControlPartyPlayback) {
      return;
    }
    this.togglePlayPause();
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  /**
   * Hover: keep chrome alive while visible.
   * On fine pointers only, hover can reveal — but suppress the trailing click toggle.
   */
  onPlayerSurfaceMove(event?: MouseEvent): void {
    if (Date.now() < this.controlsToggleSuppressedUntil) {
      return;
    }
    if (this.showPlayerControls) {
      this.scheduleControlsHide();
      return;
    }
    // Touch devices synthesize mousemove before click — never auto-reveal there
    const finePointer =
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!finePointer) {
      return;
    }
    // Ignore moves with no buttons that are part of a drag; simple hover reveal
    if (event && event.buttons !== 0) {
      return;
    }
    this.revealPlayerControls();
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  revealPlayerControls(): void {
    this.showPlayerControls = true;
    this.scheduleControlsHide();
    this.cdr.detectChanges();
  }

  hidePlayerControls(): void {
    this.clearControlsHideTimer();
    this.showCcMenu = false;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.showPlayerControls = false;
    // Ignore trailing mousemove / ghost click from the same gesture
    this.controlsToggleSuppressedUntil = Date.now() + 400;
    this.cdr.detectChanges();
  }

  private onPlaybackStateChanged(): void {
    if (!this.isPlaying) {
      this.showPlayerControls = true;
      this.clearControlsHideTimer();
      return;
    }
    this.scheduleControlsHide();
  }

  private scheduleControlsHide(): void {
    this.clearControlsHideTimer();
    if (
      !this.isPlaying ||
      this.forceControlsVisible ||
      this.showCcMenu ||
      this.showProviderMenu ||
      this.showServerMenu
    ) {
      return;
    }
    this.controlsHideTimer = setTimeout(() => {
      if (
        this.isPlaying &&
        !this.forceControlsVisible &&
        !this.showCcMenu &&
        !this.showProviderMenu &&
        !this.showServerMenu
      ) {
        this.showPlayerControls = false;
        this.cdr.detectChanges();
      }
    }, FrameComponent.CONTROLS_HIDE_MS);
  }

  private clearControlsHideTimer(): void {
    if (this.controlsHideTimer != null) {
      clearTimeout(this.controlsHideTimer);
      this.controlsHideTimer = null;
    }
  }

  seekTo(time: number): void {
    // Guests may still apply host/sync remote seeks
    if (
      !this.canControlPartyPlayback &&
      !this.watchPartyService.isApplyingRemote
    ) {
      return;
    }
    const max = this.duration > 1 ? this.duration : Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(time, max));
    // Ignore accidental 0 seeks from a range input before duration is known
    if (clamped < 0.5 && this.currentTime > 8 && this.duration <= 1) {
      return;
    }
    this.isSeeking = true;
    this.clearedSessionReady = true; // user took control — never snap seek back to 0
    this.lastSeekTarget = clamped;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.currentTime = clamped;
    this.postPlayerCommand('seek', clamped);
    // CinemaOS may miss the first postMessage before the video element is ready
    if (this.isCinemaosProvider) {
      this.scheduleSeekRetry(clamped);
      setTimeout(() => this.postPlayerCommand('seek', clamped), 700);
    }
  }

  onSeekInput(event: Event): void {
    if (!this.canControlPartyPlayback) {
      return;
    }
    const value = Number((event.target as HTMLInputElement).value);
    this.isSeeking = true;
    this.clearedSessionReady = true;
    this.lastSeekTarget = value;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.currentTime = value;
    this.syncSubtitleOverlay();
  }

  onSeekChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.seekTo(value);
  }

  skipBy(seconds: number): void {
    this.seekTo(this.currentTime + seconds);
  }

  requestPlayerStatus(): void {
    this.postPlayerCommand('getStatus');
  }

  async toggleFullscreen(): Promise<void> {
    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }

    try {
      if (document.fullscreenElement || this.cssFullscreenFallback || this.isFullscreen) {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        this.cssFullscreenFallback = false;
        this.isFullscreen = false;
        await this.syncFullscreenOrientation(false);
      } else {
        try {
          await container.requestFullscreen();
          this.cssFullscreenFallback = false;
          this.isFullscreen = true;
        } catch {
          // Mobile web (esp. iOS): element fullscreen often unsupported — CSS cover instead.
          this.cssFullscreenFallback = true;
          this.isFullscreen = true;
        }
        // Lock after enter so the user-gesture still counts on Android Chrome.
        await this.syncFullscreenOrientation(true);
      }
      this.updatePortraitViewport();
      this.revealPlayerControls();
      // Fullscreen often opens while already playing — ensure the hide timer arms.
      if (this.isFullscreen && this.isPlaying) {
        this.onPlaybackStateChanged();
      }
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  }


  private isMobilePlayerViewport(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return (
      window.matchMedia('(max-width: 900px)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    );
  }


  private updatePortraitViewport(): void {
    if (typeof window === 'undefined') {
      this.isPortraitViewport = false;
      return;
    }
    this.isPortraitViewport = window.matchMedia('(orientation: portrait)').matches;
  }

  /**
   * Prefer real landscape lock (Capacitor + Screen Orientation API).
   * Mobile web (esp. iOS) often blocks lock — `forceLandscapeFullscreen` CSS covers that case.
   */
  private async syncFullscreenOrientation(fullscreen: boolean): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        if (fullscreen) {
          await ScreenOrientation.lock({ orientation: 'landscape' });
        } else {
          await ScreenOrientation.unlock();
        }
      } catch {
        // Orientation lock may be unavailable on some devices.
      }
      return;
    }

    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
      unlock?: () => void;
    };
    try {
      if (fullscreen) {
        if (typeof orientation?.lock === 'function') {
          await orientation.lock('landscape');
        }
      } else if (typeof orientation?.unlock === 'function') {
        orientation.unlock();
      }
    } catch {
      // Expected on iOS Safari / insecure contexts — CSS rotate fallback is used instead.
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
        this.cdr.detectChanges();
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
    const inviteCode = partyFromUrl?.trim().toUpperCase() || '';

    // Already connected from a previous frame (SPA navigation) — keep peer, just sync media
    if (this.watchPartyService.isInParty) {
      this.showWatchPartyPanel = true;
      if (saved?.displayName) {
        this.watchPartyName = saved.displayName;
      }
      // Host owns the room title; guests only update local session state
      this.syncWatchPartyMedia();
      return;
    }

    // Invite link for a different room wins over a stale session
    if (
      inviteCode &&
      saved &&
      saved.roomCode.toUpperCase() !== inviteCode
    ) {
      this.watchPartyService.openJoinModal(inviteCode);
      this.showWatchPartyPanel = false;
      return;
    }

    if (saved) {
      this.showWatchPartyPanel = true;
      this.watchPartyName = saved.displayName || '';

      try {
        const restored = await this.watchPartyService.restoreSession();
        if (restored) {
          this.syncWatchPartyMedia();
        } else if (saved.role === 'guest') {
          // Host may still be reconnecting — open header join modal to retry
          this.watchPartyService.openJoinModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
          this.showWatchPartyPanel = false;
        }
      } catch (error) {
        console.error('Failed to restore watch party:', error);
        if (saved.role === 'guest') {
          this.watchPartyService.openJoinModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
          this.showWatchPartyPanel = false;
        }
      }
      return;
    }

    if (inviteCode) {
      this.watchPartyService.openJoinModal(inviteCode);
      this.showWatchPartyPanel = false;
    }
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
    if (!this.title?.trim() || !this.id || !this.mediaType) {
      return;
    }
    // Guests keep local session media in sync after navigating to the host title,
    // but never broadcast (host is source of truth).
    this.watchPartyService.setMediaState({
      mediaType: this.mediaType,
      id: String(this.id),
      season: this.mediaType === 'tv' ? this.selectedSeason : undefined,
      episode: this.mediaType === 'tv' ? this.selectedEpisode : undefined,
      title: this.title,
      posterPath: this.posterPath,
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
      await this.watchPartyService.createParty(this.getWatchPartyDisplayName('Host'));
      // Ensure media is stored/broadcast now that the party is live
      this.syncWatchPartyMedia();
      this.showWatchPartyPanel = true;
    } catch (error) {
      console.error('Failed to start watch party:', error);
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
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand('play', time);
          this.isPlaying = true;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'pause':
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand('pause', time);
          this.isPlaying = false;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'seek':
          this.seekTo(time);
          break;
        case 'sync':
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand(command.playing ? 'play' : 'pause', time);
          this.isPlaying = !!command.playing;
          this.currentTime = time;
          this.onPlaybackStateChanged();
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
      media.mediaType === this.mediaType &&
      String(media.id) === String(this.id);

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
    if (!this.canControlPartyPlayback) {
      return;
    }
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex > 0) {
      this.selectEpisode(this.episodes[currentIndex - 1].episode_number);
    }
  }

  nextEpisode(): void {
    if (!this.canControlPartyPlayback) {
      return;
    }
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
