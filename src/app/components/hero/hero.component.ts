import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SlicePipe } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-hero',
  standalone: true,
  imports: [CommonModule, SlicePipe],
  templateUrl: './hero.component.html',
})
export class HeroComponent implements OnInit {
  popularMovies: any[] = [];

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.tmdbService.getPopularMovies().subscribe((data: any) => {
      const movies = data.results.slice(0, 5); // Limit to 5 movies for the carousel
      movies.forEach((movie: any) => {
        this.tmdbService.getMovieImages(movie.id).subscribe((imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Prefer English logos
          movie.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        });
      });
      this.popularMovies = movies;
    });
  }

  // Helper method to get genre names
  getGenres(genreIds: number[]): string {
    return this.tmdbService.getGenreNames(genreIds);
  }
}