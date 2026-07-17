import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, finalize, map, switchMap } from 'rxjs/operators';
import { TmdbService } from '../../services/tmdb.service';
import { OpenRouterService } from '../../services/openrouter.service';

interface AiMediaResult {
  id: number;
  media_type: 'movie' | 'tv' | string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
}

@Component({
  selector: 'app-ai',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './ai.component.html',
  styleUrls: ['./ai.component.css'],
  standalone: true,
})
export class AiComponent implements OnInit, OnDestroy {
  readonly maxPromptLength = 400;
  readonly examplePrompts = [
    'Mind-bending sci-fi movies like Inception',
    'Cozy slice-of-life shows after a long day',
    'Gritty 90s crime thrillers',
    'Feel-good comedy TV shows',
    'Dark fantasy with great visuals',
    'Epic historical dramas',
  ];

  prompt = '';
  query = '';
  response = '';
  errorMessage = '';
  usedFallback = false;
  isLoading = false;
  hasSearched = false;
  tmdbResults: AiMediaResult[] = [];
  generatedTitles: string[] = [];

  /** Decorative backdrop slideshow (not interactive). */
  bgUrls: string[] = [];
  bgIndex = 0;
  private bgTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private tmdbService: TmdbService,
    private openRouter: OpenRouterService
  ) {}

  ngOnInit(): void {
    this.loadBackdropSlider();
  }

  ngOnDestroy(): void {
    this.stopBackdropSlider();
  }

  get promptLength(): number {
    return this.prompt.length;
  }

  get canSubmit(): boolean {
    return !!this.prompt.trim() && !this.isLoading;
  }

  get resultsHeading(): string {
    if (this.isLoading) {
      return 'Generating suggestions…';
    }
    if (!this.hasSearched) {
      return 'Suggestions';
    }
    if (this.tmdbResults.length > 0) {
      return this.usedFallback
        ? `Matches for “${this.query}”`
        : `Suggested for “${this.query}”`;
    }
    return `No results for “${this.query}”`;
  }

  onPromptChange(value: string): void {
    this.prompt = value.slice(0, this.maxPromptLength);
  }

  useExample(example: string): void {
    // Only fill the text field — generate when the user clicks Get suggestions
    this.prompt = example.slice(0, this.maxPromptLength);
  }

  sendMessage(): void {
    if (!this.canSubmit) {
      return;
    }
    this.generatedTitles = [];
    this.runRecommendation([]);
  }

  regenerate(): void {
    if (!this.prompt.trim() || this.isLoading) {
      return;
    }
    this.runRecommendation(this.generatedTitles);
  }

  private loadBackdropSlider(): void {
    this.tmdbService.getnolimitPopularMovies().subscribe({
      next: (res: { results?: AiMediaResult[] }) => {
        const urls = (res.results || [])
          .map((m) => m.backdrop_path || m.poster_path)
          .filter((path): path is string => !!path)
          .slice(0, 8)
          .map((path) => `https://image.tmdb.org/t/p/original${path}`);

        this.bgUrls = urls;
        this.bgIndex = 0;
        this.startBackdropSlider();
      },
      error: () => {
        this.bgUrls = [];
      },
    });
  }

  private startBackdropSlider(): void {
    this.stopBackdropSlider();
    if (this.bgUrls.length < 2) {
      return;
    }
    this.bgTimer = setInterval(() => {
      this.bgIndex = (this.bgIndex + 1) % this.bgUrls.length;
    }, 6000);
  }

  private stopBackdropSlider(): void {
    if (this.bgTimer != null) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
  }

  private runRecommendation(exclude: string[]): void {
    this.isLoading = true;
    this.hasSearched = true;
    this.query = this.prompt.trim();
    this.response = '';
    this.errorMessage = '';
    this.usedFallback = false;
    this.tmdbResults = [];

    this.openRouter
      .recommendTitles(this.query, exclude)
      .pipe(
        catchError((err: Error) => {
          console.warn('AI recommend failed, using TMDB search fallback:', err?.message || err);
          this.usedFallback = true;
          this.errorMessage = '';
          return of([] as string[]);
        }),
        switchMap((titles) => {
          if (titles.length > 0) {
            this.generatedTitles = [...this.generatedTitles, ...titles];
            this.response = titles.join(', ');
            return this.searchTitlesOnTmdb(titles);
          }
          this.response = this.query;
          return this.searchTmdbQuery(this.query);
        }),
        finalize(() => {
          this.isLoading = false;
        })
      )
      .subscribe({
        next: (results) => {
          this.tmdbResults = results;
          if (!results.length && !this.errorMessage) {
            this.errorMessage = this.usedFallback
              ? 'No matching movies or shows found. Try a simpler prompt (e.g. “space adventure”).'
              : 'No matching movies or shows found for that suggestion. Try more ideas.';
          }
        },
        error: (error) => {
          console.error('AI search failed:', error);
          this.errorMessage =
            error?.message || 'Something went wrong while searching. Please try again.';
          this.tmdbResults = [];
        },
      });
  }

  private searchTitlesOnTmdb(titles: string[]) {
    if (!titles.length) {
      return of([] as AiMediaResult[]);
    }
    return forkJoin(titles.map((title) => this.searchTmdbQuery(title))).pipe(
      map((groups) => this.mergeUniqueResults(groups.flat()))
    );
  }

  private searchTmdbQuery(query: string) {
    return this.tmdbService.searchMulti(query).pipe(
      map((results: { results?: AiMediaResult[] }) =>
        this.filterMediaResults(results?.results || [])
      ),
      catchError((error) => {
        console.error('Error fetching TMDB results:', error);
        return of([] as AiMediaResult[]);
      })
    );
  }

  private filterMediaResults(results: AiMediaResult[]): AiMediaResult[] {
    return results.filter((item) => {
      if (!item?.id) {
        return false;
      }
      if (item.media_type !== 'movie' && item.media_type !== 'tv') {
        return false;
      }
      const rating = Number(item.vote_average) || 0;
      const popularity = Number(item.popularity) || 0;
      return rating > 0 || popularity > 1;
    });
  }

  private mergeUniqueResults(results: AiMediaResult[]): AiMediaResult[] {
    const seen = new Set<string>();
    const merged: AiMediaResult[] = [];
    for (const item of results) {
      const key = `${item.media_type}:${item.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(item);
    }
    return merged.slice(0, 24);
  }
}
