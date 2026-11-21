import { Injectable } from '@angular/core';

export interface Song {
  id: string;          // id da faixa no Spotify
  title: string;       // título limpo (sem "Remastered" etc.)
  artist: string;
  year: number;        // ano usado no jogo (editável)
  spotifyYear: number; // ano do álbum no Spotify (pode ser de remaster/coletânea)
  mbYear?: number | null; // primeiro lançamento segundo o MusicBrainz
  isrc?: string;
  checked?: boolean;
  off?: boolean;       // fora do baralho
}

export interface Device { id: string; name: string; type: string; is_active: boolean }

export class AuthError extends Error {
  constructor() { super('Você precisa entrar com o Spotify de novo.'); }
}

export const NOT_OWNER =
  'O Spotify só libera as faixas de playlists que são suas ou colaborativas. ' +
  'Abra a playlist no Spotify, use "Adicionar a outra playlist" ou "Duplicar" para criar uma cópia na sua conta e cole o link da cópia.';

/** localStorage com try/catch (modo privado, cotas etc.) */
export const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
  del(k: string): void { try { localStorage.removeItem(k); } catch { /* ignora */ } },
};

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const PLAYBACK_SCOPE = 'user-modify-playback-state';
const SCOPES = `playlist-read-private playlist-read-collaborative user-read-playback-state ${PLAYBACK_SCOPE}`;
const K = { client: 'lds.clientId', verifier: 'lds.verifier', token: 'lds.token', pending: 'lds.pending' };

interface StoredToken { access: string; exp: number; refresh?: string; scope?: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Remove sufixos tipo " - Remastered 2011", "(Ao Vivo)", "- Radio Edit". */
export function cleanTitle(t: string): string {
  return t
    .replace(/\s*[-–]\s*(\d{4}\s+)?(remaster(ed)?|digital remaster|mono|stereo|single version|radio edit|edit|ao vivo|live|versão|version)\b.*$/i, '')
    .replace(/\s*[\(\[][^\)\]]*(remaster|mono|stereo|single version|radio edit)[^\)\]]*[\)\]]/gi, '')
    .trim() || t;
}

interface SpotifyTrack {
  id: string | null;
  type?: string;
  is_local?: boolean;
  name: string;
  artists: { name: string }[];
  album?: { release_date?: string };
  external_ids?: { isrc?: string };
}

@Injectable({ providedIn: 'root' })
export class SpotifyService {
  /** Endereço exato desta página: é o que vai no painel do Spotify como Redirect URI. */
  get redirectUri(): string { return location.origin + location.pathname; }

  get clientId(): string { return store.get(K.client) ?? ''; }
  set clientId(v: string) { store.set(K.client, v.trim()); }

  private read(): StoredToken | null {
    try { return JSON.parse(store.get(K.token) ?? 'null') as StoredToken | null; } catch { return null; }
  }
  private save(j: { access_token: string; expires_in: number; refresh_token?: string; scope?: string }): void {
    const old = this.read();
    store.set(K.token, JSON.stringify({
      access: j.access_token,
      exp: Date.now() + (j.expires_in - 60) * 1000,
      refresh: j.refresh_token ?? old?.refresh,
      scope: j.scope ?? old?.scope,
    } satisfies StoredToken));
  }

  /** Tem sessão (token válido ou refresh token para renovar). */
  get hasSession(): boolean { const t = this.read(); return !!t && (Date.now() < t.exp || !!t.refresh); }
  /** O login atual inclui permissão para controlar o player? */
  get canControlPlayback(): boolean { return (this.read()?.scope ?? '').includes(PLAYBACK_SCOPE); }

  logout(): void { store.del(K.token); }

  async login(pendingPlaylist = ''): Promise<void> {
    if (!this.clientId) throw new Error('Configure o Client ID do Spotify primeiro.');
    const verifier = randomString(64);
    store.set(K.verifier, verifier);
    store.set(K.pending, pendingPlaylist);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      redirect_uri: this.redirectUri,
    });
    location.href = `${AUTH_URL}?${params}`;
  }

  private async tokenRequest(body: URLSearchParams): Promise<void> {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Falha ao obter o token do Spotify (${r.status}). ${detail}`);
    }
    this.save(await r.json());
  }

  /** Trata a volta do login. Devolve o link de playlist que estava pendente, se houver (ou '' se não havia). */
  async handleRedirect(): Promise<string | null> {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    const err = q.get('error');
    if (!code && !err) return null;
    history.replaceState(null, '', location.pathname);
    if (err) throw new Error(`Login não concluído (${err}).`);

    await this.tokenRequest(new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: store.get(K.verifier) ?? '',
    }));
    store.del(K.verifier);
    const pending = store.get(K.pending) ?? '';
    store.del(K.pending);
    return pending;
  }

  /** Token válido, renovando com o refresh token quando expira (partidas longas). */
  private async accessToken(): Promise<string> {
    const t = this.read();
    if (t && Date.now() < t.exp) return t.access;
    if (t?.refresh) {
      try {
        await this.tokenRequest(new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: t.refresh, client_id: this.clientId,
        }));
        return this.read()!.access;
      } catch { this.logout(); }
    }
    throw new AuthError();
  }

  private async request(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const token = await this.accessToken();
    const r = await fetch(path.startsWith('http') ? path : API + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (r.status === 401) {
      // token revogado/expirado fora de hora: tenta renovar uma vez
      const t = this.read();
      if (t && attempt === 0) { store.set(K.token, JSON.stringify({ ...t, exp: 0 })); return this.request(path, init, 1); }
      this.logout();
      throw new AuthError();
    }
    if (r.status === 429 && attempt < 3) {
      const wait = Number(r.headers.get('Retry-After') ?? '2');
      await sleep((wait || 2) * 1000);
      return this.request(path, init, attempt + 1);
    }
    return r;
  }

  private async api<T>(path: string): Promise<T> {
    const r = await this.request(path);
    if (r.status === 403) throw new Error(NOT_OWNER);
    if (r.status === 404) throw new Error('Playlist não encontrada. Confira o link.');
    if (!r.ok) throw new Error(`O Spotify respondeu com erro ${r.status}.`);
    return r.json() as Promise<T>;
  }

  static parsePlaylistId(input: string): string | null {
    const s = input.trim();
    const m = s.match(/playlist[\/:]([A-Za-z0-9]{22})/) ?? s.match(/^([A-Za-z0-9]{22})$/);
    return m ? m[1] : null;
  }

  async loadPlaylist(id: string, onProgress: (n: number) => void): Promise<{ name: string; songs: Song[] }> {
    const meta = await this.api<{ name?: string }>(`/playlists/${id}?fields=name`);
    const songs: Song[] = [];
    const seen = new Set<string>();
    let next: string | null = `/playlists/${id}/items?limit=50&offset=0`;

    while (next) {
      const page: { items?: { item?: SpotifyTrack | null; track?: SpotifyTrack | null }[]; next: string | null } =
        await this.api(next);
      if (!page.items) throw new Error(NOT_OWNER);
      for (const it of page.items) {
        const t = it.item ?? it.track; // "item" é o nome novo; "track" por compatibilidade
        if (!t || !t.id || t.is_local || (t.type && t.type !== 'track') || seen.has(t.id)) continue;
        seen.add(t.id);
        const y = parseInt((t.album?.release_date ?? '').slice(0, 4), 10) || 0;
        songs.push({
          id: t.id,
          title: cleanTitle(t.name),
          artist: t.artists.map((a) => a.name).join(', '),
          year: y,
          spotifyYear: y,
          isrc: t.external_ids?.isrc,
        });
      }
      onProgress(songs.length);
      next = page.next;
    }
    return { name: meta.name ?? 'Playlist', songs };
  }

  // ---------- Spotify Connect (controle do app do Spotify) ----------

  private async player(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<Response> {
    const r = await this.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.ok) return r;
    let reason = '';
    try { reason = ((await r.json()) as { error?: { reason?: string } }).error?.reason ?? ''; } catch { /* sem corpo */ }
    if (r.status === 404 || reason === 'NO_ACTIVE_DEVICE') {
      throw new Error('O Spotify não encontrou o aparelho. Abra o app do Spotify, toque qualquer música por um segundo, volte aqui e tente de novo.');
    }
    if (reason === 'PREMIUM_REQUIRED') throw new Error('Controlar o player exige uma conta Spotify Premium.');
    if (r.status === 403) throw new Error('O Spotify recusou o comando. Entre de novo para liberar o controle do player.');
    throw new Error(`O Spotify respondeu com erro ${r.status} ao controlar o player.`);
  }

  async devices(): Promise<Device[]> {
    const r = await this.player('GET', '/me/player/devices');
    const j = (await r.json()) as { devices?: Device[] };
    return (j.devices ?? []).filter((d) => !!d.id);
  }

  async playTrack(trackId: string, deviceId: string, positionMs = 0): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.player('PUT', `/me/player/play${q}`, { uris: [`spotify:track:${trackId}`], position_ms: positionMs });
  }

  async pause(deviceId: string): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    try { await this.player('PUT', `/me/player/pause${q}`); } catch { /* já pausado: o Spotify responde 403 */ }
  }
}
