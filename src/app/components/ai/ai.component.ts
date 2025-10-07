import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpHeaders,HttpClientModule } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TmdbService } from '../../services/tmdb.service';
import { RouterModule, Router, NavigationEnd } from '@angular/router';


@Component({
  selector: 'app-ai',
  imports:[CommonModule,FormsModule, RouterModule],
  templateUrl: './ai.component.html',
  styleUrls: ['./ai.component.css'],
  standalone: true,
})

export class AiComponent implements OnInit {
  prompt: string = '';
  query: string = ''; // Tracks the search query
  response: string = '';
  isLoading: boolean = false;
  tmdbResults: any[] = []; // Store TMDB search results
  generatedTitles: string[] = [];

  private GEMINI_API_KEY = 'AIzaSyA9C9R2DDRprhiaigMjG0LuUJKrat8zZhk'; // Replace with your API key
  private GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  constructor(private http: HttpClient, private tmdbService: TmdbService) {}

  ngOnInit(): void {
    // Fetch top 20 movies on component load
    this.fetchTopMovies();
  }

  sendMessage(): void {
    if (!this.prompt.trim()) return;

    this.isLoading = true;
    this.query = this.prompt;
    this.response = ''; // Clear previous response
    this.tmdbResults = []; // Clear previous TMDB 
    this.generatedTitles = [];

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: `Suggest ONLY the title of an existing movie or TV show based on the following prompt: "${this.prompt}". Do not include any additional information.`,
            },
          ],
        },
      ],
    };

    this.http
      .post<any>(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        requestBody
      )
      .subscribe(
        (data) => {
          const generatedText =
            data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No suggestions found.';
          this.response = this.extractUniqueTitle(generatedText); // Ensure unique title
          this.generatedTitles.push(this.response); // Add to generated titles array

          if (this.response !== 'No suggestions found.') {
            this.searchTmdb(this.response);
          }
        },
        (error) => {
          console.error('Error fetching AI response:', error);
          this.response = 'An error occurred while fetching the suggestion.';
        }
      )
      .add(() => {
        this.isLoading = false; // Stop loading state
      });
  }
  regenerate(): void {
    if (!this.prompt.trim()) return;

    this.isLoading = true;
    this.response = ''; // Clear previous response
    this.tmdbResults = []; // Clear previous TMDB results

    const excludedTitles = this.generatedTitles.join(', ');
    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: `Suggest ONLY the title of an existing movie or TV show based on the following prompt: "${this.prompt}". Do not include any additional information. Exclude these titles: ${excludedTitles}.`,
            },
          ],
        },
      ],
    };

    this.http
      .post<any>(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        requestBody
      )
      .subscribe(
        (data) => {
          const generatedText =
            data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No suggestions found.';
          this.response = this.extractUniqueTitle(generatedText); // Ensure unique title
          this.generatedTitles.push(this.response); // Add to generated titles array

          if (this.response !== 'No suggestions found.') {
            this.searchTmdb(this.response);
          }
        },
        (error) => {
          console.error('Error fetching AI response:', error);
          this.response = 'An error occurred while regenerating the suggestion.';
        }
      )
      .add(() => {
        this.isLoading = false; // Stop loading state
      });
  }

  searchTmdb(query: string): void {
    this.tmdbService.searchMulti(query).subscribe(
      (results) => {
        // Filter results to include only movies/series with ratings
        this.tmdbResults = results.results.filter((item: any) => item.vote_average > 0);

        console.log('Filtered TMDB Results:', this.tmdbResults);
      },
      (error) => {
        console.error('Error fetching TMDB results:', error);
      }
    );
  }

  extractUniqueTitle(title: string): string {
    // Remove duplicates and extra commas/spaces
    const cleanedTitle = title.split(',')[0].trim();
    return cleanedTitle;
  }

  fetchTopMovies(): void {
    this.tmdbService.getTopRatedMovies().subscribe(
      (results) => {
        this.tmdbResults = results.results.slice(0, 20); // Limit to top 20 movies
        console.log('Top 20 Movies:', this.tmdbResults);
      },
      (error) => {
        console.error('Error fetching top movies:', error);
      }
    );
  }
}
