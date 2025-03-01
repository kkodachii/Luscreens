import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TmdbService } from '../../services/tmdb.service';
import { NgForOf, CommonModule, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-details',
  standalone: true,
  imports: [CommonModule, NgIf],
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
    private tmdbService: TmdbService,
    private sanitizer: DomSanitizer // Used to sanitize the URL
  ) {}

  ngOnInit(): void {
    // Get the media_type and ID from the route parameters
    const mediaType = this.route.snapshot.paramMap.get('media_type');
    const id = this.route.snapshot.paramMap.get('id');

    if (mediaType && id) {
      // Fetch details based on media_type
      if (mediaType === 'movie') {
        this.tmdbService.getMovieDetails(+id).subscribe(
          (data: any) => {
            this.item = data;
            this.fetchCast(mediaType, +id);
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
          },
          (error) => {
            console.error('Error fetching TV show details:', error);
            this.isLoading = false;
          }
        );
      }
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
  embedMedia(): void {
    const mediaType = this.route.snapshot.paramMap.get('media_type');
    const id = this.route.snapshot.paramMap.get('id');

    if (mediaType && id) {
      const playUrl = `https://moviesapi.club/${mediaType}/${id}`;
      this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(playUrl); // Sanitize the URL
      this.isEmbedVisible = true; // Show the embedded video
    }
  }
  closeVideo(): void {
    this.isEmbedVisible = false; // Hide the embedded video
  }
}