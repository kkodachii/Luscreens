import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgForOf,CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-browse',
  standalone: true,
  imports: [NgForOf, CommonModule], // Add NgForOf here
  templateUrl: './browse.component.html',
  styleUrls: ['./browse.component.css'],
})
export class BrowseComponent implements OnInit {
  type: string = ''; // 'movie' or 'series'
  items: any[] = [];

  constructor(
    private route: ActivatedRoute,
    private tmdbService: TmdbService
  ) {}

  ngOnInit(): void {
    // Get the 'type' parameter from the route
    this.route.params.subscribe((params) => {
      this.type = params['type']; // 'movie' or 'series'
      this.fetchData();
    });
  }

  fetchData(): void {
    if (this.type === 'movie') {
      this.tmdbService.getPopularMovies().subscribe(
        (data: any) => {
          this.items = data.results;
        },
        (error) => {
          console.error('Error fetching movies:', error);
        }
      );
    } else if (this.type === 'series') {
      this.tmdbService.getPopularTvSeries().subscribe(
        (data: any) => {
          this.items = data.results;
        },
        (error) => {
          console.error('Error fetching TV shows:', error);
        }
      );
    }
  }
}