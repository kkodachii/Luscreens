import { Component, OnInit } from '@angular/core'; // Import OnInit
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search.component.html',
  styleUrls: ['./search.component.css'],
})
export class SearchComponent implements OnInit {
  query: string = ''; // User input for search
  results: any[] = []; // Search results or popular movies
  isLoading: boolean = false; // Loading state

  isFilterDropdownOpen: boolean = false; // Track dropdown visibility
  selectedFilter: string = 'all'; // Default filter: 'all', 'movie', or 'tv'

  private debounceTimer: any; // Timer for debouncing

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    // Fetch popular movies on component initialization
    this.fetchPopularMovies();
  }

  toggleFilterDropdown(): void {
    this.isFilterDropdownOpen = !this.isFilterDropdownOpen;
  }

  setFilter(filter: string): void {
    this.selectedFilter = filter; // Set the selected filter
    this.isFilterDropdownOpen = false; // Close the dropdown
    this.search(); // Trigger a new search with the updated filter
  }

  onQueryChange(): void {
    // Clear the previous timer
    clearTimeout(this.debounceTimer);

    // Set a new timer to delay the API call
    this.debounceTimer = setTimeout(() => {
      this.search();
    }, 300); // Adjust the delay (e.g., 300ms)
  }

  search(): void {
    if (!this.query.trim()) {
      // If the query is empty, fetch popular movies
      this.fetchPopularMovies();
      return;
    }

    this.isLoading = true;
    this.results = [];

    // Fetch search results from TMDB API
    this.tmdbService.searchMulti(this.query).subscribe(
      (data: any) => {
        // Filter results based on the selected filter
        this.results = data.results
          .filter((item: any) => {
            if (this.selectedFilter === 'all') {
              return item.media_type !== 'person'; // Exclude people
            } else {
              return item.media_type === this.selectedFilter; // Include only the selected type
            }
          })
          .filter((item: any) => item.vote_average > 0); // Include only items with ratings
        this.isLoading = false;
      },
      (error) => {
        console.error('Error fetching search results:', error);
        this.isLoading = false;
      }
    );
  }

  fetchPopularMovies(): void {
    this.isLoading = true;
    this.results = [];

    // Fetch popular movies from TMDB API
    this.tmdbService.getnolimitPopularMovies().subscribe(
      (data: any) => {
        this.results = data.results.map((item: any) => ({
          ...item,
          media_type: 'movie', // Ensure the media type is set to 'movie'
        }));
        this.isLoading = false;
      },
      (error) => {
        console.error('Error fetching popular movies:', error);
        this.isLoading = false;
      }
    );
  }
}