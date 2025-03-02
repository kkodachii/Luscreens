import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { TmdbService } from '../../services/tmdb.service';
import { NgForOf, CommonModule, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-details',
  standalone: true,
  imports: [CommonModule, NgIf, RouterModule],
  templateUrl: './details.component.html',
  styleUrls: ['./details.component.css'],
})

export class DetailsComponent implements OnInit {
  item: any = null; // Movie or TV show details
  cast: any[] = []; // Cast members
  isLoading: boolean = true;
  embedUrl: SafeResourceUrl = '';
  isEmbedVisible: boolean = false;
  
  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private tmdbService: TmdbService,
    private sanitizer: DomSanitizer // Used to sanitize the URL
  ) {}

  ngOnInit(): void {
    const mediaType = this.route.snapshot.paramMap.get('media_type');
    const id = this.route.snapshot.paramMap.get('id');
  
    if (mediaType && id) {
      // Fetch details based on media_type
      if (mediaType === 'movie') {
        this.tmdbService.getMovieDetails(+id).subscribe(
          (data: any) => {
            this.item = data;
            this.fetchCast(mediaType, +id);
            this.fetchLogo(mediaType, +id);
            this.fetchTrailers(mediaType, +id); // Fetch trailers
          },
          (error) => {
            console.error('Error fetching movie details:', error);
            this.isLoading = false;
          }
        );
      } else if (mediaType === 'tv') {
        this.tmdbService.getTvDetails(+id).subscribe(
          (data: any) => {
            this.item = data;
            this.fetchCast(mediaType, +id);
            this.fetchLogo(mediaType, +id);
            this.fetchTrailers(mediaType, +id); // Fetch trailers
          },
          (error) => {
            console.error('Error fetching TV show details:', error);
            this.isLoading = false;
          }
        );
      }
    }
  }
  
  fetchTrailers(mediaType: string, id: number): void {
    this.tmdbService.getVideos(mediaType, id).subscribe(
      (videosData: any) => {
        const videoKey = videosData?.results[0]?.key;
        if (videoKey) {
          // Sanitize the URL to make it safe for use in an iframe
          this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
            `https://www.youtube.com/embed/${videoKey}`
          );
        }
        this.isLoading = false;
      },
      (error) => {
        console.error('Error fetching videos:', error);
        this.isLoading = false;
      }
    );
  }
  
  fetchLogo(mediaType: string, id: number): void {
    if (mediaType === 'movie') {
      // Fetch movie logos
      this.tmdbService.getMovieImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching movie logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else if (mediaType === 'tv') {
      // Fetch TV show logos
      this.tmdbService.getTvImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching TV show logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else {
      console.error('Invalid media type for logo fetching.');
      this.item.logo_path = null;
    }
  }

  fetchCast(mediaType: string, id: number): void {
    this.tmdbService.getCast(mediaType, id).subscribe(
      (castData: any) => {
        this.cast = castData.cast;
        this.isLoading = false;
      },
      (error) => {
        console.error('Error fetching cast:', error);
        this.isLoading = false;
      }
    );
  }
  formatDate(date: string): string {
    if (!date) return 'N/A';
    const options: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', year: 'numeric' };
    return new Date(date).toLocaleDateString('en-US', options);
  }
  
  formatRuntime(runtime: number | number[]): string {
    if (!runtime) return 'N/A';
    const totalMinutes = Array.isArray(runtime) ? runtime[0] : runtime;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  playMedia(): void {
    const mediaType = this.route.snapshot.paramMap.get('media_type');
    const id = this.route.snapshot.paramMap.get('id');

    if (mediaType === 'movie') {
      this.router.navigate(['/frame', mediaType, id]);
    } else if (mediaType === 'tv') {
      // Default to the first season and episode
      this.router.navigate(['/frame', mediaType, id, '1', '1']);
    }
  }
}