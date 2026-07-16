import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  ContinueWatchingItem,
  WatchProgressService,
} from '../../services/watch-progress.service';

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './history.component.html',
})
export class HistoryComponent implements OnInit, OnDestroy {
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

  remove(item: ContinueWatchingItem, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.watchProgress.remove(item.key);
  }

  clearAll(): void {
    if (confirm('Clear all watch history?')) {
      this.watchProgress.clearAll();
    }
  }

  private refresh(): void {
    this.items = this.watchProgress.getContinueWatching(100);
  }
}
