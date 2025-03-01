import { Component, OnInit, HostListener, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgForOf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-browse',
  standalone: true,
  imports: [NgForOf, CommonModule], 
  templateUrl: './browse.component.html',
  styleUrls: ['./browse.component.css'],
})
export class BrowseComponent implements OnInit {
  type: string = ''; 
  items: any[] = [];
  selectedGenreId: number | null = null; 
  selectedFilter: string = 'popular'; 
  isDropdownOpen: boolean = false; 

  currentPage: number = 1; 
  isLoading: boolean = false; 
  hasMoreData: boolean = true; 

  
  movieGenres = [
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

  
  tvGenres = [
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

  visibleGenres: any[] = []; 
  hiddenGenres: any[] = []; 

  constructor(
    private route: ActivatedRoute,
    private tmdbService: TmdbService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    
    this.route.params.subscribe((params) => {
      this.type = params['type']; 
      this.fetchData(); 
      this.calculateVisibleGenres();
      
    });
    this.setupInfiniteScroll();
  }

  setupInfiniteScroll(): void {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && this.hasMoreData && !this.isLoading) {
          this.loadMore();
        }
      });
    });

    const sentinel = document.querySelector('.sentinel');
    if (sentinel) {
      observer.observe(sentinel);
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.calculateVisibleGenres(); 
  }

  calculateVisibleGenres(): void {
    const genres = this.type === 'movie' ? this.movieGenres : this.tvGenres;
    const screenWidth = window.innerWidth;

    
    if (screenWidth < 640) {
      this.visibleGenres = [];
      this.hiddenGenres = genres;
    } else {
      
      let maxVisibleGenres = Math.floor(screenWidth / 120); 
      maxVisibleGenres = Math.max(1, Math.min(maxVisibleGenres, genres.length)); 

      this.visibleGenres = genres.slice(0, maxVisibleGenres);
      this.hiddenGenres = genres.slice(maxVisibleGenres);
    }
  }

  fetchData(): void {
    const genreId = this.selectedGenreId ?? undefined;
    this.isLoading = true;

    this.tmdbService.getFilteredItems(this.type, this.selectedFilter, genreId, this.currentPage).subscribe(
      (data: any) => {
        if (this.currentPage === 1) {
          this.items = data.results; 
        } else {
          this.items = [...this.items, ...data.results]; 
        }
        this.hasMoreData = data.total_pages > this.currentPage; 
        this.isLoading = false;
        this.cdr.detectChanges(); 
      },
      (error) => {
        console.error('Error fetching data:', error);
        this.isLoading = false;
      }
    );
  }
  loadMore(): void {
    if (this.hasMoreData && !this.isLoading) {
      this.currentPage++; 
      this.fetchData();   
    }
  }
  selectGenre(genreId: number): void {
    this.selectedGenreId = genreId; 
    this.resetPagination();         
    this.fetchData();               
    this.isDropdownOpen = false;    
  }

  applyFilter(filter: string): void {
    this.selectedFilter = filter; 
    this.resetPagination();       
    this.fetchData();             
  }

  resetPagination(): void {
    this.currentPage = 1; 
    this.items = [];      
    this.hasMoreData = true; 
  }

  toggleDropdown(): void {
    this.isDropdownOpen = !this.isDropdownOpen; 
  }

  @HostListener('document:click', ['$event'])
  onClickOutside(event: MouseEvent): void {
    const dropdownButton = document.querySelector('.dropdown-button');
    if (
      dropdownButton &&
      !dropdownButton.contains(event.target as Node) &&
      this.isDropdownOpen
    ) {
      this.isDropdownOpen = false; 
    }
  }
}