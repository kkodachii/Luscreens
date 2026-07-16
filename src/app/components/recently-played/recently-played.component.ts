import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  ContinueWatchingItem,
  WatchProgressService,
} from '../../services/watch-progress.service';

@Component({
  selector: 'app-recently-played',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './recently-played.component.html',
})
export class RecentlyPlayedComponent implements OnInit, OnDestroy {
  items: ContinueWatchingItem[] = [];
  private sub = new Subscription();

  constructor(private watchProgress: WatchProgressService) {}

  ngOnInit(): void {
    this.refresh();
    this.sub.add(this.watchProgress.progress$.subscribe(() => this.refresh()));
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  formatTime(seconds: number): string {
    return this.watchProgress.formatTime(seconds);
  }

  formatLastWatched(timestamp: number): string {
    if (!timestamp) {
      return '';
    }
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  private refresh(): void {
    this.items = this.watchProgress.getContinueWatching(12);
  }
}
