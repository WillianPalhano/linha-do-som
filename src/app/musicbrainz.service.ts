import { Injectable } from '@angular/core';
import type { Song } from './spotify.service';

const MB = 'https://musicbrainz.org/ws/2';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MbRecording { score?: number; 'first-release-date'?: string }

/**
 * O Spotify costuma mostrar o ano do álbum (remaster, coletânea, "Greatest Hits").
 * O MusicBrainz agrupa remasters na mesma gravação e informa o primeiro lançamento.
 * Limite de uso: 1 requisição por segundo.
 */
@Injectable({ providedIn: 'root' })
export class MusicBrainzService {
  private last = 0;

  private async get<T>(path: string): Promise<T | null> {
    const wait = this.last + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    const r = await fetch(`${MB}${path}`, { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (r.status === 503) { await sleep(2000); return this.get<T>(path); }
    if (!r.ok) return null;
    return r.json() as Promise<T>;
  }

  private static yearOf(d?: string): number | null {
    const y = parseInt((d ?? '').slice(0, 4), 10);
    return y >= 1900 && y <= new Date().getFullYear() ? y : null;
  }

  private static lucene(s: string): string {
    return s.replace(/([+\-!(){}\[\]^"~*?:\\\/]|&&|\|\|)/g, '\\$1');
  }

  async originalYear(song: Song): Promise<number | null> {
    const years: number[] = [];

    if (song.isrc) {
      const j = await this.get<{ recordings?: MbRecording[] }>(`/isrc/${encodeURIComponent(song.isrc)}?fmt=json`);
      for (const rec of j?.recordings ?? []) {
        const y = MusicBrainzService.yearOf(rec['first-release-date']);
        if (y) years.push(y);
      }
    }

    if (!years.length) {
      const artist = song.artist.split(',')[0].trim();
      const q = `recording:"${MusicBrainzService.lucene(song.title)}" AND artist:"${MusicBrainzService.lucene(artist)}"`;
      const j = await this.get<{ recordings?: MbRecording[] }>(
        `/recording?fmt=json&limit=15&query=${encodeURIComponent(q)}`,
      );
      for (const rec of j?.recordings ?? []) {
        if ((rec.score ?? 0) < 90) continue;
        const y = MusicBrainzService.yearOf(rec['first-release-date']);
        if (y) years.push(y);
      }
    }

    return years.length ? Math.min(...years) : null;
  }
}
