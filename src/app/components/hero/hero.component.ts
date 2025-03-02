import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SlicePipe } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-hero',
  standalone: true,
  imports: [CommonModule, SlicePipe, RouterModule],
  templateUrl: './hero.component.html',
  styleUrls: ['./hero.component.css'],
})
export class HeroComponent implements OnInit {
  popularMovies: any[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private tmdbService: TmdbService,
    private sanitizer: DomSanitizer // Used to sanitize the URL
  ) {}

  ngOnInit(): void {
    this.tmdbService.getPopularMovies().subscribe((data: any) => {
      const movies = data.results.slice(0, 5); 
      movies.forEach((movie: any) => {
        this.tmdbService.getMovieImages(movie.id).subscribe((imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); 
          movie.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        });
      });
      this.popularMovies = movies;
    });
  }

  getGenres(genreIds: number[]): string {
    return this.tmdbService.getGenreNames(genreIds);
  }
  playMedia(mediaType: string, id: number): void {
    if (mediaType === 'movie') {
      this.router.navigate(['/frame', mediaType, id]);
    } else if (mediaType === 'tv') {
      // Default to the first season and episode
      this.router.navigate(['/frame', mediaType, id, '1', '1']);
    }
  }
}