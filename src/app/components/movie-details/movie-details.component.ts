import { Component, Input } from '@angular/core';
import { NgIf } from '@angular/common'; // Import NgIf
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-details',
  standalone: true,
  imports: [NgIf], // Add NgIf here
  templateUrl: './movie-details.component.html',
})
export class MovieDetailsComponent {
  @Input() movieId!: number;
  movie: any;

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.tmdbService.getMovieDetails(this.movieId).subscribe((data: any) => {
      this.movie = data;
    });
  }
}