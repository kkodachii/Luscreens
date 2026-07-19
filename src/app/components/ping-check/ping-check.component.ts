import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { environment, StreamProvider } from '../../../environments/environment';

interface PingTarget {
  id: string;
  label: string;
  url: string;
  group: 'provider' | 'host' | 'custom';
  ms: number | null;
  pending: boolean;
  checkedAt: number | null;
}

/**
 * Temporary diagnostic page — delete this component + route when done.
 * Open at /ping-check
 */
@Component({
  selector: 'app-ping-check',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './ping-check.component.html',
  styleUrls: ['./ping-check.component.css'],
})
export class PingCheckComponent implements OnInit {
  private static readonly TIMEOUT_MS = 4000;

  targets: PingTarget[] = [];
  customUrl = '';
  isPingingAll = false;
  lastRunAt: number | null = null;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.targets = this.buildDefaultTargets();
    void this.pingAll();
  }

  get sortedTargets(): PingTarget[] {
    return [...this.targets].sort((a, b) => {
      const am = a.ms == null || a.ms < 0 ? Number.POSITIVE_INFINITY : a.ms;
      const bm = b.ms == null || b.ms < 0 ? Number.POSITIVE_INFINITY : b.ms;
      return am - bm;
    });
  }

  async pingAll(): Promise<void> {
    this.isPingingAll = true;
    this.cdr.detectChanges();
    await Promise.all(this.targets.map((t) => this.pingTarget(t)));
    this.lastRunAt = Date.now();
    this.isPingingAll = false;
    this.cdr.detectChanges();
  }

  async pingOne(target: PingTarget): Promise<void> {
    await this.pingTarget(target);
    this.cdr.detectChanges();
  }

  addCustomUrl(): void {
    const raw = this.customUrl.trim();
    if (!raw) {
      return;
    }

    let url: string;
    try {
      url = new URL(raw.includes('://') ? raw : `https://${raw}`).href;
    } catch {
      return;
    }

    if (this.targets.some((t) => t.url === url)) {
      this.customUrl = '';
      return;
    }

    const host = new URL(url).hostname;
    this.targets = [
      ...this.targets,
      {
        id: `custom-${Date.now()}`,
        label: host,
        url,
        group: 'custom',
        ms: null,
        pending: false,
        checkedAt: null,
      },
    ];
    this.customUrl = '';
    void this.pingOne(this.targets[this.targets.length - 1]);
  }

  removeCustom(target: PingTarget): void {
    if (target.group !== 'custom') {
      return;
    }
    this.targets = this.targets.filter((t) => t.id !== target.id);
  }

  formatMs(ms: number | null, pending: boolean): string {
    if (pending) {
      return '…';
    }
    if (ms == null) {
      return '—';
    }
    if (ms < 0) {
      return 'fail';
    }
    return `${ms} ms`;
  }

  tone(ms: number | null, pending: boolean): string {
    if (pending || ms == null) {
      return 'tone-muted';
    }
    if (ms < 0) {
      return 'tone-bad';
    }
    if (ms < 200) {
      return 'tone-good';
    }
    if (ms < 500) {
      return 'tone-ok';
    }
    if (ms < 1000) {
      return 'tone-slow';
    }
    return 'tone-bad';
  }

  signalLevel(ms: number | null, pending: boolean): number {
    if (pending) {
      return -1;
    }
    if (ms == null || ms < 0) {
      return 0;
    }
    if (ms < 150) {
      return 4;
    }
    if (ms < 300) {
      return 3;
    }
    if (ms < 600) {
      return 2;
    }
    return 1;
  }

  private buildDefaultTargets(): PingTarget[] {
    const providers: { id: StreamProvider; label: string; url: string }[] = [
      { id: 'apiplayer', label: 'ApiPlayer', url: 'https://apiplayer.ru/favicon.ico' },
      { id: 'cinemaos', label: 'CinemaOS', url: 'https://cinemaos.tech/favicon.ico' },
      { id: 'vidphantom', label: 'VidPhantom', url: 'https://vidphantom.com/favicon.ico' },
      { id: 'vidfast', label: 'VidFast', url: 'https://vidfast.vc/favicon.ico' },
      { id: 'peachify', label: 'Peachify', url: 'https://peachify.top/favicon.ico' },
      { id: 'vidup', label: 'VidUP', url: 'https://vidup.to/favicon.ico' },
      { id: 'videasy', label: 'Videasy', url: 'https://player.videasy.net/favicon.ico' },
      { id: 'movies111', label: '111Movies', url: 'https://player.vidlove.cc/favicon.ico' },
    ];

    const hosts: { id: string; label: string; url: string }[] = [
      { id: 'vidfast-root', label: 'vidfast.vc', url: 'https://vidfast.vc/' },
      { id: 'cinemaos-root', label: 'cinemaos.tech', url: 'https://cinemaos.tech/' },
      { id: 'vidphantom-root', label: 'vidphantom.com', url: 'https://vidphantom.com/' },
      { id: 'apiplayer-root', label: 'apiplayer.ru', url: 'https://apiplayer.ru/' },
      { id: 'peachify-root', label: 'peachify.top', url: 'https://peachify.top/' },
      { id: 'vidup-root', label: 'vidup.to', url: 'https://vidup.to/' },
      { id: 'videasy-root', label: 'player.videasy.net', url: 'https://player.videasy.net/' },
      { id: 'movies111-root', label: 'player.vidlove.cc', url: 'https://player.vidlove.cc/' },
      { id: 'tmdb', label: 'TMDB API', url: 'https://api.themoviedb.org/3/' },
    ];

    const serverPins = (environment.streamServers ?? []).map((name) => ({
      id: `server-${name}`,
      label: `VidFast pin · ${name}`,
      // Same host for all pins — useful to compare against provider ping only
      url: `https://vidfast.vc/favicon.ico?server=${encodeURIComponent(name)}`,
      group: 'host' as const,
    }));

    return [
      ...providers.map((p) => ({
        id: p.id,
        label: p.label,
        url: p.url,
        group: 'provider' as const,
        ms: null,
        pending: false,
        checkedAt: null,
      })),
      ...hosts.map((h) => ({
        ...h,
        group: 'host' as const,
        ms: null,
        pending: false,
        checkedAt: null,
      })),
      ...serverPins.map((s) => ({
        ...s,
        ms: null,
        pending: false,
        checkedAt: null,
      })),
    ];
  }

  private async pingTarget(target: PingTarget): Promise<void> {
    target.pending = true;
    this.cdr.detectChanges();

    const url = `${target.url}${target.url.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const started = performance.now();
    let ms = -1;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PingCheckComponent.TIMEOUT_MS);
      await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      ms = Math.max(1, Math.round(performance.now() - started));
    } catch {
      const elapsed = Math.round(performance.now() - started);
      ms = elapsed > 50 ? elapsed : -1;
    }

    target.ms = ms;
    target.pending = false;
    target.checkedAt = Date.now();
  }
}
