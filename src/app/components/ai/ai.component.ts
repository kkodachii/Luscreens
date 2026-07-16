import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TmdbService } from '../../services/tmdb.service';
import { OpenRouterService } from '../../services/openrouter.service';
import { RouterModule } from '@angular/router';
import { finalize } from 'rxjs/operators';

@Component({
  selector: 'app-ai',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './ai.component.html',
  styleUrls: ['./ai.component.css'],
  standalone: true,
})
export class AiComponent implements OnInit {
  prompt: string = '';
  query: string = '';
  response: string = '';
  isLoading: boolean = false;
  tmdbResults: any[] = [];
  generatedTitles: string[] = [];

  constructor(
    private tmdbService: TmdbService,
    private openRouter: OpenRouterService,
  ) {}

  ngOnInit(): void {
    this.fetchTopMovies();
  }

  sendMessage(): void {
    if (!this.prompt.trim()) return;

    this.isLoading = true;
    this.query = this.prompt;
    this.response = '';
    this.tmdbResults = [];
    this.generatedTitles = [];

    const prompt = `Suggest ONLY the title of an existing movie or TV show based on the following prompt: "${this.prompt}". Do not include any additional information.`;

    this.openRouter
      .chat(
        prompt,
        'You recommend real movie and TV titles. Reply with only the title text, nothing else.'
      )
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: (generatedText) => {
          this.response = this.extractUniqueTitle(generatedText);
          this.generatedTitles.push(this.response);

          if (this.response !== 'No suggestions found.') {
            this.searchTmdb(this.response);
          }
        },
        error: (error) => {
          console.error('Error fetching AI response:', error);
          this.response = 'An error occurred while fetching the suggestion.';
        },
      });
  }

  regenerate(): void {
    if (!this.prompt.trim()) return;

    this.isLoading = true;
    this.response = '';
    this.tmdbResults = [];

    const excludedTitles = this.generatedTitles.join(', ');
    const prompt = `Suggest ONLY the title of an existing movie or TV show based on the following prompt: "${this.prompt}". Do not include any additional information. Exclude these titles: ${excludedTitles}.`;

    this.openRouter
      .chat(
        prompt,
        'You recommend real movie and TV titles. Reply with only the title text, nothing else.'
      )
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: (generatedText) => {
          this.response = this.extractUniqueTitle(generatedText || 'No suggestions found.');
          this.generatedTitles.push(this.response);

          if (this.response !== 'No suggestions found.') {
            this.searchTmdb(this.response);
          }
        },
        error: (error) => {
          console.error('Error fetching AI response:', error);
          this.response = 'An error occurred while regenerating the suggestion.';
        },
      });
  }

  searchTmdb(query: string): void {
    this.tmdbService.searchMulti(query).subscribe(
      (results) => {
        this.tmdbResults = results.results.filter((item: any) => item.vote_average > 0);
        console.log('Filtered TMDB Results:', this.tmdbResults);
      },
      (error) => {
        console.error('Error fetching TMDB results:', error);
      }
    );
  }

  extractUniqueTitle(title: string): string {
    const cleanedTitle = title
      .replace(/^["'`]+|["'`]+$/g, '')
      .split(/[\n,]/)[0]
      .trim();
    return cleanedTitle || 'No suggestions found.';
  }

  fetchTopMovies(): void {
    this.tmdbService.getTopRatedMovies().subscribe(
      (results) => {
        this.tmdbResults = results.results.slice(0, 20);
        console.log('Top 20 Movies:', this.tmdbResults);
      },
      (error) => {
        console.error('Error fetching top movies:', error);
      }
    );
  }
}
