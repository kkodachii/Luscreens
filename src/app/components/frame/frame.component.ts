import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders,HttpClientModule } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { inject } from '@vercel/analytics';
import { environment } from '../../../environments/environment';
import {
  WatchPartyChatMessage,
  WatchPartyCommand,
  WatchPartyService,
  WatchPartyState,
} from '../../services/watch-party.service';

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

interface VidFastProgressEntry {
  id: number;
  type: 'movie' | 'tv';
  title?: string;
  poster_path?: string;
  backdrop_path?: string;
  progress?: { watched: number; duration: number };
  last_season_watched?: number;
  last_episode_watched?: number;
  show_progress?: {
    [key: string]: {
      season: number;
      episode: number;
      progress: { watched: number; duration: number };
      last_updated?: number;
    };
  };
  last_updated?: number;
}

type VidFastProgressMap = Record<string, VidFastProgressEntry>;

@Component({
  selector: 'app-frame',
  templateUrl: './frame.component.html',
  imports: [NgIf, FormsModule, NgForOf, CommonModule],
  styleUrls: ['./frame.component.css'],
  standalone: true,
})
export class FrameComponent implements OnInit, OnDestroy {

  private GEMINI_API_KEY = 'AIzaSyA9C9R2DDRprhiaigMjG0LuUJKrat8zZhk';
  private GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

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

  activeSection: string = 'plot'; 
  plot: string = ''; 
  summary: string = ''; 
  endingExplanation: string = ''; 
  
  
  cachedContent: {
    [season: number]: {
      [episode: number]: { plot: string; summary: string; ending: string };
    };
  } = {};

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
  isSeasonEpisodeLoading: boolean = false;
  userQuestion: string = ''; // Stores the user's question
  aiResponse: string = ''; // Stores the AI-generated response
  isAIResponding: boolean = false; // Tracks whether the AI is processing a request
  chatHistory: { sender: 'user' | 'ai'; text: string }[] = [];

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
  };
  showWatchPartyPanel = false;
  showJoinInviteModal = false;
  watchPartyMode: 'create' | 'join' = 'create';
  watchPartyName = '';
  joinRoomCode = '';
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
    private http: HttpClient,
    private watchPartyService: WatchPartyService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // Initialize Vercel Analytics
    inject();

    window.addEventListener('message', this.onPlayerMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.setupWatchParty();

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
    this.fetchContent('plot');

    void this.tryRestoreWatchParty();
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.closePictureInPicture();
    this.watchPartySubs.unsubscribe();
    // Keep session so a full page reload can rejoin the same party
    this.watchPartyService.disconnectKeepingSession();
  }

  
  setActiveSection(section: string): void {
    this.activeSection = section;

    // Fetch content only if it hasn't been cached yet
    if (
      (section === 'plot' && !this.plot) ||
      (section === 'summary' && !this.summary) ||
      (section === 'ending' && !this.endingExplanation)
    ) {
      this.fetchContent(section);
    }

    // Clear chat history when switching to "Ask AI"
    if (section === 'ask') {
      this.chatHistory = [{ sender: 'ai', text: 'Note: Only 2023 movies/series below can answer.' }];
    }
  }
  fetchContent(section: string): void {
    if (this.isLoading) {
      console.warn('Still loading title... Please wait.');
      return;
    }

    const title = this.title || 'Unknown Title'; // Use the fetched title or a fallback
    let prompt = '';

    // Check if content is already cached for the current season/episode
    if (this.mediaType === 'tv') {
      if (
        this.cachedContent[this.selectedSeason] &&
        this.cachedContent[this.selectedSeason][this.selectedEpisode]
      ) {
        const cached = this.cachedContent[this.selectedSeason][this.selectedEpisode];
        if (section === 'plot' && cached.plot) {
          this.plot = cached.plot;
          return;
        } else if (section === 'summary' && cached.summary) {
          this.summary = cached.summary;
          return;
        } else if (section === 'ending' && cached.ending) {
          this.endingExplanation = cached.ending;
          return;
        }
      }
    }

    // Define prompts for each section based on the knowledge base
    switch (section) {
      case 'plot':
        if (this.mediaType === 'tv') {
          prompt = `Provide a detailed plot summary for Season ${this.selectedSeason} of the TV show "${title}". Include information about its storyline, characters, and key events. 2-3 paragraphs only.`;
        } else {
          prompt = `Provide a detailed plot summary for the movie "${title}". Include information about its storyline, characters, and key events. 2-3 paragraphs only.`;
        }
        break;

      case 'summary':
        if (this.mediaType === 'tv') {
          prompt = `Provide a concise summary of Episode ${this.selectedEpisode}, Season ${this.selectedSeason} of the TV show "${title}". Highlight its main themes, genre, and overall narrative. 2-3 paragraphs only.`;
        } else {
          prompt = `Provide a concise summary of the movie "${title}". Highlight its main themes, genre, and overall narrative. 2-3 paragraphs only.`;
        }
        break;

      case 'ending':
        if (this.mediaType === 'tv') {
          prompt = `Explain the ending of Episode ${this.selectedEpisode}, Season ${this.selectedSeason} of the TV show "${title}" in detail. Discuss the resolution, character arcs, and any significant plot twists. 2-3 paragraphs only.`;
        } else {
          prompt = `Explain the ending of the movie "${title}" in detail. Discuss the resolution, character arcs, and any significant plot twists. 2-3 paragraphs only.`;
        }
        break;

      default:
        console.error('Invalid section:', section);
        return;
    }

    // Call the Gemini API
    this.http
      .post(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }]
        }
      )
      .subscribe(
        (response: any) => {
          // Extract the generated text from the response
          const generatedText = response?.candidates?.[0]?.content?.parts?.[0]?.text || 'No content available.';
          // Cache the content based on the section
          if (this.mediaType === 'tv') {
            if (!this.cachedContent[this.selectedSeason]) {
              this.cachedContent[this.selectedSeason] = {};
            }
            if (!this.cachedContent[this.selectedSeason][this.selectedEpisode]) {
              this.cachedContent[this.selectedSeason][this.selectedEpisode] = {
                plot: '',
                summary: '',
                ending: '',
              };
            }
            if (section === 'plot') {
              this.plot = generatedText;
              this.cachedContent[this.selectedSeason][this.selectedEpisode].plot = generatedText;
            } else if (section === 'summary') {
              this.summary = generatedText;
              this.cachedContent[this.selectedSeason][this.selectedEpisode].summary = generatedText;
            } else if (section === 'ending') {
              this.endingExplanation = generatedText;
              this.cachedContent[this.selectedSeason][this.selectedEpisode].ending = generatedText;
            }
          } else {
            if (section === 'plot') {
              this.plot = generatedText;
            } else if (section === 'summary') {
              this.summary = generatedText;
            } else if (section === 'ending') {
              this.endingExplanation = generatedText;
            }
          }
        },
        (error) => {
          console.error('Error fetching content from Gemini API:', error);
          // Fallback content in case of an error
          if (section === 'plot') {
            this.plot = 'Failed to load plot.';
          } else if (section === 'summary') {
            this.summary = 'Failed to load summary.';
          } else if (section === 'ending') {
            this.endingExplanation = 'Failed to load ending explanation.';
          }
        }
      );
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

        // Fetch initial content after loading is complete
        this.fetchContent('plot');
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

        // Fetch initial content after loading is complete
        this.fetchContent('plot');
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
    this.isSeasonEpisodeLoading = true; // Start loading
    this.selectedSeason = seasonNumber;
  
    // Use .add() to execute logic after the observable completes
    this.fetchEpisodes(this.selectedSeason).add(() => {
      this.isSeasonEpisodeLoading = false; // Stop loading after episodes are fetched
      this.fetchContent(this.activeSection); // Refetch content for the new season
    });
  }
  
  selectEpisode(episodeNumber: number): void {
    this.isSeasonEpisodeLoading = true; // Start loading
    this.selectedEpisode = episodeNumber;
    this.updateEmbedUrl();
  
    setTimeout(() => {
      this.isSeasonEpisodeLoading = false; // Stop loading after a short delay
      this.fetchContent(this.activeSection); // Refetch content for the new episode
    }, 500); // Simulate a slight delay for UX purposes
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
    if (!this.vidfastOrigins.includes(event.origin) || !event.data) {
      return;
    }

    const { type, data } = event.data;

    if (type === 'PLAYER_EVENT' && data) {
      this.onPlayerEvent(data as PlayerEventData);
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      this.saveVidFastProgress(data as VidFastProgressMap);
    }
  }

  private onPlayerEvent(data: PlayerEventData): void {
    if (!this.isSeeking || data.event === 'seeked') {
      this.currentTime = data.currentTime ?? this.currentTime;
    }

    this.duration = data.duration ?? this.duration;
    this.isPlaying = data.playing ?? this.isPlaying;

    switch (data.event) {
      case 'play':
        this.isPlaying = true;
        this.broadcastWatchPartyEvent('play', data.currentTime);
        break;
      case 'pause':
        this.isPlaying = false;
        this.broadcastWatchPartyEvent('pause', data.currentTime);
        break;
      case 'ended':
        this.isPlaying = false;
        break;
      case 'seeked':
        this.isSeeking = false;
        this.broadcastWatchPartyEvent('seeked', data.currentTime);
        break;
      case 'timeupdate':
      case 'playerstatus':
        break;
    }
  }

  private saveVidFastProgress(progressMap: VidFastProgressMap): void {
    try {
      localStorage.setItem('vidFastProgress', JSON.stringify(progressMap));
    } catch (error) {
      console.error('Failed to save VidFast progress:', error);
    }
  }

  private getVidFastProgress(): VidFastProgressMap {
    try {
      const raw = localStorage.getItem('vidFastProgress');
      return raw ? (JSON.parse(raw) as VidFastProgressMap) : {};
    } catch {
      return {};
    }
  }

  private getProgressKey(): string {
    const prefix = this.mediaType === 'tv' ? 't' : 'm';
    return `${prefix}${this.id}`;
  }

  private getSavedStartAt(): number {
    const entry = this.getVidFastProgress()[this.getProgressKey()];
    if (!entry) {
      return 0;
    }

    let watched = 0;
    let total = 0;

    if (this.mediaType === 'tv') {
      const episodeKey = `s${this.selectedSeason}e${this.selectedEpisode}`;
      const episodeProgress = entry.show_progress?.[episodeKey]?.progress;
      watched = episodeProgress?.watched ?? 0;
      total = episodeProgress?.duration ?? 0;
    } else {
      watched = entry.progress?.watched ?? 0;
      total = entry.progress?.duration ?? 0;
    }

    // Don't resume near the very start or end
    if (watched < 30 || (total > 0 && watched / total > 0.95)) {
      return 0;
    }

    return watched;
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
      await this.watchPartyService.createParty(this.watchPartyName || 'Host');
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

  askAI(): void {
    if (!this.userQuestion.trim()) {
      console.warn('User question is empty.');
      return;
    }

    this.isAIResponding = true; // Start loading
    const title = this.title || 'Unknown Title'; // Use the fetched title or a fallback
    const prompt = `
  You are an expert assistant answering questions about the ${this.mediaType} "${title}".
  - Answer the following question: "${this.userQuestion}"
  - Be formal and concise in your response.
  - If the question is not related to this ${this.mediaType}, respond with: "I'd love to help, but I'm only answering movie/series-related questions!"
`;

    // Call the Gemini API
    this.http
      .post(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }]
        }
      )
      .subscribe(
        (response: any) => {
          // Extract the generated text from the response
          this.aiResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response available.';
          this.chatHistory.push({ sender: 'ai', text: this.aiResponse }); // Add AI's response to chat history
          this.scrollToBottom(); // Scroll to the bottom after adding the AI response
          this.isAIResponding = false; // Stop loading
        },
        (error) => {
          console.error('Error fetching AI response:', error);
          this.chatHistory.push({ sender: 'ai', text: 'Failed to get AI response.' }); // Add error message to chat history
          this.scrollToBottom(); // Scroll to the bottom after adding the error message
          this.isAIResponding = false; // Stop loading
        }
      );
  }

  sendMessage(): void {
    if (!this.userQuestion.trim()) {
      console.warn('User question is empty.');
      return;
    }
  
    // Add user's message to chat history
    this.chatHistory.push({ sender: 'user', text: this.userQuestion });
  
    // Call the AI and show loading spinner
    this.isAIResponding = true;
    const title = this.title || 'Unknown Title'; // Use the fetched title or a fallback
  
    // Refined prompt for better clarity
    const prompt = `
      You are an expert assistant answering questions about the ${this.mediaType} "${title}".
      - Answer the following question: "${this.userQuestion}"
      - Be formal and concise in your response.
      - If the question is not related to this ${this.mediaType}, respond with: "Sorry, but your question doesn't seem related to this movies or series!"
    `;
  
    // Call the Gemini API
    this.http
      .post(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }]
        }
      )
      .subscribe(
        (response: any) => {
          // Extract the generated text from the response
          let aiResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response available.';
  
          // Post-process the response to ensure relevance
          if (!this.isResponseRelevant(aiResponse)) {
            aiResponse = "Sorry, but your question doesn't seem related to this movies or series!";
          }
  
          // Add AI's response to chat history
          this.chatHistory.push({ sender: 'ai', text: aiResponse });
          this.scrollToBottom(); // Scroll to the bottom after adding the AI response
          this.isAIResponding = false; // Stop loading
        },
        (error) => {
          console.error('Error fetching AI response:', error);
          this.chatHistory.push({ sender: 'ai', text: 'Failed to get AI response.' }); // Add error message to chat history
          this.scrollToBottom(); // Scroll to the bottom after adding the error message
          this.isAIResponding = false; // Stop loading
        }
      );
  
    // Clear the input field
    this.userQuestion = '';
  }
  
  // Helper function to check if the response is relevant
  isResponseRelevant(response: string): boolean {
    const fallbackMessage = "Sorry, but your question doesn't seem related to this movies or series!";
    const irrelevantKeywords = ['not related', 'unrelated', 'cannot answer'];
  
    // Check if the response contains the fallback message or irrelevant keywords
    if (response.includes(fallbackMessage)) {
      return false;
    }
  
    // Check for irrelevant keywords
    for (const keyword of irrelevantKeywords) {
      if (response.toLowerCase().includes(keyword)) {
        return false;
      }
    }
  
    return true;
  }
  scrollToBottom(): void {
    const chatContainer = document.querySelector('.chat-container');
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }
}
