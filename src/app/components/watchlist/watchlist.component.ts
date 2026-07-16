import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { WatchlistItem, WatchlistService } from '../../services/watchlist.service';
import { UserLibraryService } from '../../services/user-library.service';

@Component({
  selector: 'app-watchlist',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './watchlist.component.html',
})
export class WatchlistComponent implements OnInit, OnDestroy {
  items: WatchlistItem[] = [];
  private sub = new Subscription();
  private readonly watchlist = inject(WatchlistService);
  private readonly userLibrary = inject(UserLibraryService);

  ngOnInit(): void {
    this.refresh();
    this.sub.add(this.watchlist.list$.subscribe(() => this.refresh()));
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  detailsLink(item: WatchlistItem): (string | number)[] {
    return this.watchlist.detailsLink(item);
  }

  remove(item: WatchlistItem, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.watchlist.removeByKey(item.key);
    this.userLibrary.flushToServer();
  }

  clearAll(): void {
    if (confirm('Clear your entire watchlist?')) {
      this.watchlist.clearAll();
      this.userLibrary.flushToServer();
    }
  }

  private refresh(): void {
    this.items = this.watchlist.getAll();
  }
}
