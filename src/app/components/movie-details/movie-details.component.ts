import { Component, Input } from '@angular/core';
import { NgIf , CommonModule } from '@angular/common'; 
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-details',
  standalone: true,
  imports: [NgIf , CommonModule], 
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