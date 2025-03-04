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

  private GEMINI_API_KEY = 'AIzaSyBIaly87RD4LviGrnhPCG9TGBbDLmnte68'; // Replace with your API key
  private GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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
    this.tmdbResults = []; // Clear previous TMDB results

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
          // Extract the AI's response
          const generatedText =
            data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No suggestions found.';
          this.response = generatedText.trim(); // Trim whitespace for cleaner output

          // Search TMDB using the AI-generated title
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