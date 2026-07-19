import { Component, AfterViewInit, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeaderComponent } from './components/header/header.component';
import { initFlowbite } from 'flowbite';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { UserLibraryService } from './services/user-library.service';
import { AiBubblePreferenceService } from './services/ai-bubble-preference.service';
import { CapacitorInitService } from './services/capacitor-init.service';

interface AiBubblePosition {
  left: number;
  top: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterModule, HeaderComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements AfterViewInit {
  private static readonly AI_BUBBLE_POS_KEY = 'luscreensAiBubblePos';
  private static readonly DRAG_THRESHOLD_PX = 8;

  title = 'web-app';
  isBrowseRouteActive = false;
  isDefaultRoute = true;
  isHomeRouteActive = false;
  isDetailsRoute = false;
  isFrameRoute = false;
  isAiRoute = false;
  /** Custom position after user drags; null = default bottom-right. */
  aiBubblePos: AiBubblePosition | null = this.readAiBubblePos();
  isAiBubbleDragging = false;

  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginLeft = 0;
  private dragOriginTop = 0;
  private dragMoved = false;
  private fabWidth = 112;
  private fabHeight = 44;

  private readonly _userLibrary = inject(UserLibraryService);
  private readonly aiBubblePref = inject(AiBubblePreferenceService);
  private readonly capacitorInit = inject(CapacitorInitService);

  constructor(private router: Router) {
    void this.capacitorInit.init();
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const url = event.urlAfterRedirects || event.url;
        this.isDefaultRoute = url === '/' || url.startsWith('/?');
        this.isHomeRouteActive = this.isDefaultRoute;
        this.isBrowseRouteActive = url.startsWith('/browse');
        this.isDetailsRoute = url.startsWith('/details');
        this.isFrameRoute = url.startsWith('/frame');
        this.isAiRoute = url.startsWith('/ai');
        this.resetScrollPosition();
      }
    });
  }

  get showAiBubble(): boolean {
    return (
      !this.aiBubblePref.isHidden() &&
      !this.isFrameRoute &&
      !this.isAiRoute
    );
  }

  get aiBubbleStyle(): Record<string, string> {
    if (this.aiBubblePos) {
      return {
        left: `${this.aiBubblePos.left}px`,
        top: `${this.aiBubblePos.top}px`,
        right: 'auto',
        bottom: 'auto',
      };
    }
    return {
      right: '1rem',
      bottom: '1.25rem',
      left: 'auto',
      top: 'auto',
    };
  }

  onAiBubblePointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return;
    }
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
      return;
    }

    const rect = target.getBoundingClientRect();
    this.fabWidth = rect.width;
    this.fabHeight = rect.height;
    this.dragPointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOriginLeft = rect.left;
    this.dragOriginTop = rect.top;
    this.dragMoved = false;
    this.isAiBubbleDragging = false;

    target.setPointerCapture?.(event.pointerId);
  }

  @HostListener('document:pointermove', ['$event'])
  onAiBubblePointerMove(event: PointerEvent): void {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) {
      return;
    }

    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    if (
      !this.dragMoved &&
      Math.hypot(dx, dy) < AppComponent.DRAG_THRESHOLD_PX
    ) {
      return;
    }

    this.dragMoved = true;
    this.isAiBubbleDragging = true;
    event.preventDefault();

    const maxLeft = Math.max(8, window.innerWidth - this.fabWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - this.fabHeight - 8);
    this.aiBubblePos = {
      left: Math.min(maxLeft, Math.max(8, this.dragOriginLeft + dx)),
      top: Math.min(maxTop, Math.max(8, this.dragOriginTop + dy)),
    };
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  onAiBubblePointerUp(event: PointerEvent): void {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) {
      return;
    }

    const didDrag = this.dragMoved;
    this.dragPointerId = null;
    this.isAiBubbleDragging = false;

    if (didDrag && this.aiBubblePos) {
      this.persistAiBubblePos(this.aiBubblePos);
    }
  }

  openAiSearch(event: Event): void {
    if (this.dragMoved) {
      event.preventDefault();
      event.stopPropagation();
      this.dragMoved = false;
      return;
    }
    void this.router.navigate(['/ai']);
  }

  private readAiBubblePos(): AiBubblePosition | null {
    try {
      const raw = sessionStorage.getItem(AppComponent.AI_BUBBLE_POS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as AiBubblePosition;
      if (
        typeof parsed?.left === 'number' &&
        typeof parsed?.top === 'number' &&
        Number.isFinite(parsed.left) &&
        Number.isFinite(parsed.top)
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private persistAiBubblePos(pos: AiBubblePosition): void {
    try {
      sessionStorage.setItem(
        AppComponent.AI_BUBBLE_POS_KEY,
        JSON.stringify(pos)
      );
    } catch {
      // ignore
    }
  }

  resetScrollPosition(): void {
    const container = document.querySelector('.custom-scrollbar');
    if (container) {
      container.scrollTop = 0;
    }
  }

  ngAfterViewInit(): void {
    initFlowbite();
  }
}
