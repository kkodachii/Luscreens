import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders,HttpClientModule } from '@angular/common/http';
import { inject } from '@vercel/analytics';
import { environment } from '../../../environments/environment';

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
  isMuted = false;
  volume = 1;
  currentTime = 0;
  duration = 0;
  isSeeking = false;
  isFullscreen = false;

  private readonly onFullscreenChange = (): void => {
    this.isFullscreen = !!document.fullscreenElement;
  };
  

  @ViewChild('seasonScroll') seasonScroll!: ElementRef;
  @ViewChild('episodeScroll') episodeScroll!: ElementRef;
  @ViewChild('playerIframe') playerIframe!: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerContainer') playerContainer!: ElementRef<HTMLDivElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private tmdbService: TmdbService,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    // Initialize Vercel Analytics
    inject();

    window.addEventListener('message', this.onPlayerMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);

    this.mediaType = this.route.snapshot.paramMap.get('media_type') || '';
    this.id = this.route.snapshot.paramMap.get('id') || '';

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
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
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
          this.selectedSeason = this.seasons[0].season_number;
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
          this.selectedEpisode = this.episodes[0].episode_number;
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
    }
  }

  private buildEmbedUrl(path: string): SafeResourceUrl {
    const server = environment.streamServer || 'vEdge';
    const startAt = this.getSavedStartAt();
    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'red',
      title: 'false',
      server,
      // Reduce embed chrome so users rely on our custom controls instead
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
    });

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
    this.isMuted = data.muted ?? this.isMuted;
    this.volume = data.volume ?? this.volume;

    switch (data.event) {
      case 'play':
        this.isPlaying = true;
        break;
      case 'pause':
        this.isPlaying = false;
        break;
      case 'ended':
        this.isPlaying = false;
        break;
      case 'seeked':
        this.isSeeking = false;
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

  toggleMute(): void {
    const nextMuted = !this.isMuted;
    this.isMuted = nextMuted;
    this.postPlayerCommand({ command: 'mute', muted: nextMuted });
  }

  onVolumeInput(event: Event): void {
    const level = Number((event.target as HTMLInputElement).value);
    this.volume = level;
    this.isMuted = level === 0;
    this.postPlayerCommand({ command: 'volume', level });
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
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
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
