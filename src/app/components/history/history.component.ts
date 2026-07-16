import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  ContinueWatchingItem,
  WatchProgressService,
} from '../../services/watch-progress.service';
import { UserLibraryService } from '../../services/user-library.service';

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './history.component.html',
})
export class HistoryComponent implements OnInit, OnDestroy {
  items: ContinueWatchingItem[] = [];
  private sub = new Subscription();
  private readonly watchProgress = inject(WatchProgressService);
  private readonly userLibrary = inject(UserLibraryService);

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

  remove(item: ContinueWatchingItem, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.watchProgress.remove(item.key);
    this.userLibrary.flushToServer();
  }

  clearAll(): void {
    if (confirm('Clear all watch history?')) {
      this.watchProgress.clearAll();
      this.userLibrary.flushToServer();
    }
  }

  private refresh(): void {
    this.items = this.watchProgress.getContinueWatching(100);
  }
}
