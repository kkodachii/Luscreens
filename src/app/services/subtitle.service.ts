import { Injectable } from '@angular/core';

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

interface OpenSubtitlesResult {
  ISO639?: string;
  SubLanguageID?: string;
  SubDownloadLink?: string;
  SubFileName?: string;
  SubHearingImpaired?: string;
  SubBad?: string;
}

/**
 * Loads public OpenSubtitles tracks and converts them to VTT / cues
 * for the local HLS player and CinemaOS overlay.
 */
@Injectable({ providedIn: 'root' })
export class SubtitleService {
  private readonly restOrigin = 'https://rest.opensubtitles.org';

  async resolveImdbId(options: {
    mediaType: 'movie' | 'tv';
    tmdbId: string;
    tmdbApiKey: string;
    fallbackImdbId?: string | null;
  }): Promise<string | null> {
    if (options.fallbackImdbId?.startsWith('tt')) {
      return options.fallbackImdbId;
    }

    const { mediaType, tmdbId, tmdbApiKey } = options;
    try {
      if (mediaType === 'movie') {
        const res = await fetch(
          `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbApiKey}`
        );
        if (!res.ok) {
          return null;
        }
        const data = (await res.json()) as { imdb_id?: string };
        return data.imdb_id?.startsWith('tt') ? data.imdb_id : null;
      }

      const res = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${tmdbApiKey}`
      );
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { imdb_id?: string };
      return data.imdb_id?.startsWith('tt') ? data.imdb_id : null;
    } catch {
      return null;
    }
  }

  async loadCues(options: {
    imdbId: string;
    lang: string;
    season?: number;
    episode?: number;
  }): Promise<{ cues: SubtitleCue[]; vttUrl: string } | null> {
    const lang = options.lang.toLowerCase().split('-')[0];
    const imdbNumeric = options.imdbId.replace(/^tt/i, '');
    if (!imdbNumeric) {
      return null;
    }

    const searchUrl =
      options.season != null && options.episode != null
        ? `${this.restOrigin}/search/episode-${options.episode}/imdbid-${imdbNumeric}/season-${options.season}`
        : `${this.restOrigin}/search/imdbid-${imdbNumeric}`;

    const searchRes = await fetch(searchUrl, {
      headers: { Accept: 'application/json' },
    });
    if (!searchRes.ok) {
      throw new Error(`Subtitle search failed (${searchRes.status})`);
    }

    const results = (await searchRes.json()) as OpenSubtitlesResult[];
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const match = this.pickBestResult(results, lang);
    if (!match?.SubDownloadLink) {
      return null;
    }

    const fileRes = await fetch(match.SubDownloadLink);
    if (!fileRes.ok) {
      throw new Error(`Subtitle download failed (${fileRes.status})`);
    }

    const buffer = await fileRes.arrayBuffer();
    const srt = await this.decodePossiblyGzipped(buffer);
    if (!this.looksLikeSrt(srt)) {
      throw new Error('Invalid subtitle payload');
    }

    const vtt = this.srtToVtt(srt);
    const cues = this.parseVttCues(vtt);
    const vttUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' }));
    return { cues, vttUrl };
  }

  revokeUrl(url: string | null | undefined): void {
    if (url?.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }

  findActiveCueText(cues: SubtitleCue[], time: number): string {
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (time >= cue.start && time <= cue.end) {
        return cue.text;
      }
    }
    return '';
  }

  private pickBestResult(
    results: OpenSubtitlesResult[],
    lang: string
  ): OpenSubtitlesResult | null {
    const langMap: Record<string, string[]> = {
      en: ['en', 'eng'],
      es: ['es', 'spa', 'spl'],
      fr: ['fr', 'fre', 'fra'],
      de: ['de', 'ger', 'deu'],
      it: ['it', 'ita'],
      pt: ['pt', 'por', 'pob'],
      ja: ['ja', 'jpn'],
      ko: ['ko', 'kor'],
      zh: ['zh', 'chi', 'zho', 'ze'],
    };
    const aliases = langMap[lang] ?? [lang];

    const filtered = results.filter((row) => {
      const code = String(row.ISO639 || row.SubLanguageID || '')
        .toLowerCase()
        .trim();
      if (!aliases.includes(code) && code.slice(0, 2) !== lang) {
        return false;
      }
      if (row.SubBad === '1') {
        return false;
      }
      return !!row.SubDownloadLink;
    });

    if (filtered.length === 0) {
      return null;
    }

    // Prefer non-HI, then first match
    return (
      filtered.find((row) => row.SubHearingImpaired !== '1') ?? filtered[0]
    );
  }

  private async decodePossiblyGzipped(buffer: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buffer);
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!isGzip) {
      return this.decodeText(bytes);
    }

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Gzip subtitles need DecompressionStream support');
    }

    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const decompressed = await new Response(stream).arrayBuffer();
    return this.decodeText(new Uint8Array(decompressed));
  }

  private decodeText(bytes: Uint8Array): string {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  private looksLikeSrt(text: string): boolean {
    return /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}/.test(text);
  }

  private srtToVtt(srt: string): string {
    const normalized = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const body = normalized
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
      .replace(/\{\\an\d+\}/gi, '')
      .replace(/<\/?font[^>]*>/gi, '');
    return `WEBVTT\n\n${body}\n`;
  }

  private parseVttCues(vtt: string): SubtitleCue[] {
    const blocks = vtt.replace(/\r\n/g, '\n').split(/\n\n+/);
    const cues: SubtitleCue[] = [];

    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0 || lines[0].startsWith('WEBVTT')) {
        continue;
      }

      let timingLine = lines[0];
      let textLines = lines.slice(1);
      if (!timingLine.includes('-->') && lines.length > 1) {
        timingLine = lines[1];
        textLines = lines.slice(2);
      }
      if (!timingLine.includes('-->')) {
        continue;
      }

      const [startRaw, endRaw] = timingLine.split('-->').map((part) => part.trim());
      const start = this.parseTimestamp(startRaw);
      const end = this.parseTimestamp(endRaw.split(/\s+/)[0] ?? '');
      if (start == null || end == null || textLines.length === 0) {
        continue;
      }

      cues.push({
        start,
        end,
        text: textLines.join('\n').replace(/<[^>]+>/g, '').trim(),
      });
    }

    return cues;
  }

  private parseTimestamp(value: string): number | null {
    const match = value.match(/(?:(\d+):)?(\d{2}):(\d{2})(?:\.|,)(\d{3})/);
    if (!match) {
      return null;
    }
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const ms = Number(match[4]);
    return hours * 3600 + minutes * 60 + seconds + ms / 1000;
  }
}
