import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SlicePipe } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-hero',
  standalone: true,
  imports: [CommonModule, SlicePipe],
  templateUrl: './hero.component.html',
  styleUrls: ['./hero.component.css'],
})
export class HeroComponent implements OnInit {
  popularMovies: any[] = [];
  currentSlide: number = 0; // Track the current slide index
  intervalId: any; // To store the interval ID for auto-sliding
  direction: string = 'right'; // Track the direction of the slide transition

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.tmdbService.getPopularMovies().subscribe((data: any) => {
      const movies = data.results.slice(0, 5); // Limit to 5 movies
      movies.forEach((movie: any) => {
        this.tmdbService.getMovieImages(movie.id).subscribe((imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          movie.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        });
      });
      this.popularMovies = movies;

      // Start auto-sliding after loading movies
      this.startAutoSlide();
    });
  }

  getGenres(genreIds: number[]): string {
    return this.tmdbService.getGenreNames(genreIds);
  }

  changeSlide(index: number): void {
    this.direction = index > this.currentSlide ? 'right' : 'left'; // Determine direction
    this.currentSlide = index; // Change to the selected slide
  }

  nextSlide(): void {
    this.direction = 'right'; // Set direction to right
    this.currentSlide = (this.currentSlide + 1) % this.popularMovies.length; // Move to the next slide
  }

  prevSlide(): void {
    this.direction = 'left'; // Set direction to left
    this.currentSlide = (this.currentSlide - 1 + this.popularMovies.length) % this.popularMovies.length; // Move to the previous slide
  }

  startAutoSlide(): void {
    this.intervalId = setInterval(() => {
      this.nextSlide(); // Automatically move to the next slide every 7 seconds
    }, 7000);
  }

  ngOnDestroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId); // Clear the interval when the component is destroyed
    }
  }
}