import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private apiKey = 'c646ab9e5209d5c5c8d42ab3f653b61a';
  private baseUrl = 'https://api.themoviedb.org/3';

  // Genre mapping
  private genres = [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Science Fiction' },
    { id: 10770, name: 'TV Movie' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' },
  ];

  constructor(private http: HttpClient) {}

  getPopularMovies(): Observable<any> {
    return this.http
      .get(`${this.baseUrl}/movie/popular`, {
        params: { api_key: this.apiKey },
      })
      .pipe(
        map((response: any) => {
          // Limit the results to 10 movies
          response.results = response.results.slice(0, 10);
          return response;
        })
      );
  }
  getMovieDetails(movieId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/movie/${movieId}`, {
      params: { api_key: this.apiKey },
    });
  }

  // New Method: Fetch movie images (including logos)
  getMovieImages(movieId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/movie/${movieId}/images`, {
      params: { api_key: this.apiKey },
    });
  }

  getPopularTvSeries(): Observable<any> {
    return this.http
      .get(`${this.baseUrl}/tv/popular`, {
        params: { api_key: this.apiKey },
      })
      .pipe(
        map((response: any) => {
          response.results = response.results.slice(0, 30); // Limit to 10 TV series
          return response;
        })
      );
  }

  getPopularSeriesByNetwork(networkId: number): Observable<any> {
    return this.http
      .get(`${this.baseUrl}/discover/tv`, {
        params: {
          api_key: this.apiKey,
          with_networks: networkId.toString(), // Filter for Netflix
          sort_by: 'popularity.desc', // Sort by popularity
          page: '1',
        },
      })
      .pipe(
        map((response: any) => {
          console.log('Netflix Series Response:', response); // Log response
          response.results = response.results.slice(0, 30); // Limit to 10 series
          return response;
        })
      );
  }
  getMoviesByGenre(genreId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/discover/movie`, {
      params: {
        api_key: this.apiKey,
        with_genres: genreId.toString(),
        sort_by: 'popularity.desc',
        page: '1',
      },
    });
  }
  getTopRatedMovies(): Observable<any> {
    return this.http.get(`${this.baseUrl}/movie/top_rated`, {
      params: { api_key: this.apiKey },
    });
  }

  // Fetch Top-Rated TV Series
  getTopRatedSeries(): Observable<any> {
    return this.http.get(`${this.baseUrl}/tv/top_rated`, {
      params: { api_key: this.apiKey },
    });
  }

  // Method to map genre IDs to names
  getGenreNames(genreIds: number[]): string {
    const genreNames = genreIds
      .map((id) => this.genres.find((genre) => genre.id === id)?.name)
      .filter((name) => !!name); // Remove undefined values
    return genreNames.join(', ');
  }
}