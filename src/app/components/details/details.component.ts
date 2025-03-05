import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { TmdbService } from '../../services/tmdb.service';
import { NgForOf, CommonModule, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { HttpClient } from '@angular/common/http';

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
  torrents: any[] | null = null; // Store torrent information
  showTorrentList: boolean = false;
  loadingTorrents: boolean = false;
  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private tmdbService: TmdbService,
    private sanitizer: DomSanitizer, // Used to sanitize the URL
    private http: HttpClient // For fetching torrents
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
            this.fetchTorrentInfo();
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
            this.fetchTorrentInfo();
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
  async fetchTorrentInfo(): Promise<void> {
    this.loadingTorrents = true; // Start loading
    const contentTitle = this.item?.title || this.item?.name || 'Unknown Title';
    const releaseYear = (this.item?.release_date || this.item?.first_air_date || '').substring(0, 4);

    this.torrents = null; // Reset torrent info

    try {
      const corsProxy = 'https://api.allorigins.win/raw?url=';
      let searchQuery = contentTitle;

      if (releaseYear) {
        searchQuery += ` ${releaseYear}`;
      }

      const targetUrl = `https://cloudtorrents.com/search?query=${encodeURIComponent(searchQuery)}&ordering=-se`;
      console.log('Fetching torrents from:', targetUrl);

      const response = await this.http.get(corsProxy + encodeURIComponent(targetUrl), { responseType: 'text' }).toPromise();
      if (!response) throw new Error('Empty response');

      const parser = new DOMParser();
      const doc = parser.parseFromString(response, 'text/html');

      const rows = doc.querySelectorAll('tbody tr');
      console.log('Found rows:', rows.length);

      const qualityTypeMap = new Map();

      rows.forEach((row) => {
        const titleElement = row.querySelector('td:first-child a');
        if (!titleElement) return;

        const title = titleElement?.textContent?.trim() || '';
        if (!this.verifyTorrentTitle(title, contentTitle, releaseYear)) return;

        const magnetElement = row.querySelector('a[href^="magnet:"]');
        if (!magnetElement) return;

        const magnetLink = (magnetElement as HTMLAnchorElement)?.href || '';

        let quality = 'N/A';
        const qualityMatch = title.match(/\b(720p|1080p|2160p|4K)\b/i);
        if (qualityMatch) {
          quality = qualityMatch[1].toUpperCase();
        }

        let type = 'N/A';
        const typeMatch = title.match(/\b(BluRay|WEBDL|WEB-DL|WEBRip|HDRip|BRRip|DVDRip)\b/i);
        if (typeMatch) {
          type = typeMatch[1].replace('WEBDL', 'WEB-DL');
        }

        const sizeElement = row.querySelector('td:nth-child(4)');
        const size = sizeElement?.textContent?.trim() || 'N/A';

        const seedersElement = row.querySelector('td:nth-child(5)');
        const seeders = seedersElement?.textContent ? parseInt(seedersElement.textContent.trim(), 10) : 0;

        const torrent = {
          quality,
          type,
          size,
          seeders,
          magnet: magnetLink,
        };

        const key = `${quality}-${type}`;
        if (!qualityTypeMap.has(key) || qualityTypeMap.get(key).seeders < seeders) {
          qualityTypeMap.set(key, torrent);
        }
      });

      const torrents = Array.from(qualityTypeMap.values());
      torrents.sort((a, b) => {
        const qualityOrder: { [key: string]: number } = {
          '4K': 4,
          '2160P': 3,
          '1080P': 2,
          '720P': 1,
          'N/A': 0,
        };
        const qualityDiff = (qualityOrder[b.quality as keyof typeof qualityOrder] || 0) - 
                             (qualityOrder[a.quality as keyof typeof qualityOrder] || 0);
        if (qualityDiff !== 0) return qualityDiff;
        return b.seeders - a.seeders;
      });

      this.torrents = torrents.slice(0, 4);
      if (this.torrents.length === 0) {
        this.torrents = null;
      }
    } catch (error) {
      console.error('Error fetching torrent info:', error);
      this.torrents = null;
    } finally {
      this.loadingTorrents = false; // Stop loading
    }
  }

  verifyTorrentTitle(torrentTitle: string, contentTitle: string, releaseYear: string): boolean {
    const cleanTorrentTitle = torrentTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanContentTitle = contentTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (!cleanTorrentTitle.includes(cleanContentTitle)) {
      return false;
    }

    if (releaseYear && !torrentTitle.includes(releaseYear)) {
      return false;
    }

    return true;
  }

  downloadFirstTorrent(): void {
    if (this.torrents && this.torrents.length > 0) {
      const firstTorrent = this.torrents[0];
      window.open(firstTorrent.magnet, '_blank');
    } else {
      console.warn('No torrents available to download.');
    }
  }
  toggleTorrentList(): void {
    this.showTorrentList = !this.showTorrentList;
  }
  getUniqueTorrents(): any[] {
    if (!this.torrents) return [];
    const seenQualities = new Set();
    return this.torrents.filter((torrent) => {
      if (seenQualities.has(torrent.quality)) {
        return false;
      }
      seenQualities.add(torrent.quality);
      return true;
    });
  }

  downloadTorrent(magnetLink: string): void {
    window.open(magnetLink, '_blank');
  }
}