import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  PartyLobbyService,
  PublicPartyRoom,
} from '../../services/party-lobby.service';

@Component({
  selector: 'app-public-parties',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './public-parties.component.html',
})
export class PublicPartiesComponent implements OnInit, OnDestroy {
  rooms: PublicPartyRoom[] = [];
  loading = false;
  joiningCode: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private sub = new Subscription();

  constructor(
    public partyLobby: PartyLobbyService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.refresh();
    this.poll = setInterval(() => this.refresh(), 12_000);
  }

  ngOnDestroy(): void {
    if (this.poll) {
      clearInterval(this.poll);
    }
    this.sub.unsubscribe();
  }

  refresh(): void {
    if (!this.partyLobby.enabled) {
      this.rooms = [];
      this.loading = false;
      return;
    }
    this.loading = true;
    this.sub.add(
      this.partyLobby.listPublicRooms().subscribe((rooms) => {
        this.rooms = rooms;
        this.loading = false;
      })
    );
  }

  async joinRoom(room: PublicPartyRoom): Promise<void> {
    this.joiningCode = room.code;
    const queryParams = { party: room.code };

    try {
      if (room.mediaType && room.mediaId) {
        if (room.mediaType === 'tv' && room.season && room.episode) {
          await this.router.navigate(
            ['/frame', room.mediaType, room.mediaId, room.season, room.episode],
            { queryParams }
          );
        } else {
          await this.router.navigate(['/frame', room.mediaType, room.mediaId], {
            queryParams,
          });
        }
        return;
      }
      // No media metadata — send them home with the invite so they can open a title
      await this.router.navigate(['/'], { queryParams });
    } finally {
      this.joiningCode = null;
    }
  }

  episodeLabel(room: PublicPartyRoom): string {
    if (room.mediaType === 'tv' && room.season && room.episode) {
      return `S${room.season}E${room.episode}`;
    }
    return room.mediaType === 'movie' ? 'Movie' : 'Watch party';
  }
}
