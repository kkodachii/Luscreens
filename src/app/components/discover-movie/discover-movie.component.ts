import { Component, OnInit, ViewChild, ElementRef  } from '@angular/core';
import { NgForOf } from '@angular/common'; // Import NgForOf
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-discover-movie',
  standalone: true,
  imports: [NgForOf], // Add NgForOf here
  templateUrl: './discover-movie.component.html',
  styleUrls: ['./discover-movie.component.css'],
})


export class DiscoverMovieComponent implements OnInit {
  movies: any[] = [];
  isLoading: boolean = true;
  showError: boolean = false;

  genres = [
    { id: 35, name: 'Comedy' },
    { id: 28, name: 'Action' },
    { id: 27, name: 'Horror' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Sci-Fi' },
    { id: 18, name: 'Drama' },
    { id: 16, name: 'Animation' },
  ];
  selectedGenreId: number = 35;

  @ViewChild('carousel') carousel!: ElementRef;

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.loadMovies(this.selectedGenreId);
  }

  loadMovies(genreId: number): void {
    this.isLoading = true;
    this.showError = false;

    this.tmdbService.getMoviesByGenre(genreId).subscribe(
      (data: any) => {
        this.movies = data.results.slice(0, 30); // Limit to 10 movies
        this.isLoading = false;
      },
      (error) => {
        console.error('Error fetching movies by genre:', error);
        this.isLoading = false;
        this.showError = true;
      }
    );
  }

  selectGenre(genreId: number): void {
    this.selectedGenreId = genreId;
    this.loadMovies(genreId);
  }

  scrollLeft() {
    this.carousel.nativeElement.scrollBy({ left: -200, behavior: 'smooth' });
  }

  // Scroll Right
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  
}
