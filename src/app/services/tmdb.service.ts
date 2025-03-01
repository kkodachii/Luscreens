import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private apiKey = 'c646ab9e5209d5c5c8d42ab3f653b61a';
  private baseUrl = 'https://api.themoviedb.org/3';
  
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
          response.results = response.results.slice(0, 30); 
          return response;
        })
      );
  }

  getPopularSeriesByNetwork(networkId: number): Observable<any> {
    return this.http
      .get(`${this.baseUrl}/discover/tv`, {
        params: {
          api_key: this.apiKey,
          with_networks: networkId.toString(), 
          sort_by: 'popularity.desc', 
          page: '1',
        },
      })
      .pipe(
        map((response: any) => {
          console.log('Netflix Series Response:', response); 
          response.results = response.results.slice(0, 30); 
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
   
   getSeriesByGenre(genreId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/discover/tv`, {
      params: {
        api_key: this.apiKey,
        with_genres: genreId.toString(),
        sort_by: 'popularity.desc',
        page: '1',
      },
    });
  }
    
    getBrowseMovies(genreId: number): Observable<any> {
      return this.http.get(`${this.baseUrl}/discover/movie`, {
        params: {
          api_key: this.apiKey,
          with_genres: genreId.toString(),
          sort_by: 'popularity.desc',
          page: '1',
        },
      });
    }

    getBrowseSeries(genreId: number): Observable<any> {
      return this.http.get(`${this.baseUrl}/discover/tv`, {
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

  
  getTopRatedSeries(): Observable<any> {
    return this.http.get(`${this.baseUrl}/tv/top_rated`, {
      params: { api_key: this.apiKey },
    });
  }
  getGenres(): any[] {
    return this.genres;
  }

  
  getGenreNames(genreIds: number[]): string {
    const genreNames = genreIds
      .map((id) => this.genres.find((genre) => genre.id === id)?.name)
      .filter((name) => !!name); 
    return genreNames.join(', ');
  }

  private movieGenres = [
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

  
  private tvGenres = [
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 10762, name: 'Kids' },
    { id: 9648, name: 'Mystery' },
    { id: 10763, name: 'News' },
    { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 10766, name: 'Soap' },
    { id: 10767, name: 'Talk' },
    { id: 10768, name: 'War & Politics' },
    { id: 37, name: 'Western' },
  ];
  getFilteredItems(type: string, filter: string, genreId?: number, page: number = 1): Observable<any> {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
  
    let params: any = {
      api_key: this.apiKey,
      page: page.toString(),
    };
  
    if (genreId) {
      params.with_genres = genreId.toString();
    }
  
    switch (filter) {
      case 'popular':
        params.sort_by = 'popularity.desc';
        break;
      case 'rated':
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = '100'; 
        break;
      case 'recent':
        params.sort_by = 'release_date.desc';
        break;
      default:
        params.sort_by = 'popularity.desc';
    }
  
    return this.http.get(`${this.baseUrl}/discover/${endpoint}`, { params });
  }
  
  getGenreNamess(genreIds: number[], type: string): string {
    const genres = type === 'movie' ? this.movieGenres : this.tvGenres;
    const genreNames = genreIds
      .map((id) => genres.find((genre) => genre.id === id)?.name)
      .filter((name) => !!name);
    return genreNames.join(', ');
  }
}