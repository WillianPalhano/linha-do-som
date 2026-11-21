import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { AuthError, Device, Song, SpotifyService, store } from './spotify.service';
import { MusicBrainzService } from './musicbrainz.service';

interface Player { name: string; tl: Song[]; tokens: number }
interface Game {
  players: Player[];
  deck: Song[];
  cur: number;
  card: Song | null;
  sel: number | null;
  phase: 'guess' | 'reveal';
  ok: boolean;
  placedId: string | null;
  bonus: boolean;
  winner: string | null;
}

const COLORS = ['#ff4f9a', '#2fd6c3', '#ffd23f', '#ff9f43', '#a78bfa'];
const LIB = 'lds.library';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  private sp = inject(SpotifyService);
  private mb = inject(MusicBrainzService);
  private san = inject(DomSanitizer);

  readonly redirectUri = this.sp.redirectUri;
  clientId = signal(this.sp.clientId);
  showSettings = signal(!this.sp.clientId);
  loggedIn = signal(this.sp.hasSession);
  canControl = signal(this.sp.canControlPlayback);

  /** connect = toca a faixa inteira no app do Spotify; embed = player embutido (prévia no celular) */
  audioMode = signal<'connect' | 'embed'>((store.get('lds.audio') as 'connect' | 'embed') || 'connect');
  devices = signal<Device[]>([]);
  deviceId = signal(store.get('lds.device') ?? '');
  deviceName = signal(store.get('lds.deviceName') ?? '');
  playMsg = signal('');
  playing = signal(false);
  embedNonce = signal(0);

  playlistInput = signal('');
  playlistName = signal('');
  songs = signal<Song[]>([]);
  busy = signal('');
  error = signal('');
  checking = signal(false);
  checkProgress = signal('');
  private stopRequested = false;
  showList = signal(false);

  names = signal<string[]>(this.readJson<string[]>('lds.names') ?? ['Jogador 1', 'Jogador 2']);
  goal = signal(10);
  startTokens = signal(2);

  game = signal<Game | null>(null);
  maskOpen = signal(Number(store.get('lds.mask')) || 72);

  activeSongs = computed(() => this.songs().filter((s) => !s.off && s.year > 0));
  current = computed(() => { const g = this.game(); return g ? g.players[g.cur] : null; });
  embedUrl = computed<SafeResourceUrl | null>(() => {
    const c = this.game()?.card;
    return c
      ? this.san.bypassSecurityTrustResourceUrl(`https://open.spotify.com/embed/track/${c.id}?utm_source=generator&theme=0&n=${this.embedNonce()}`)
      : null;
  });
  diffCount = computed(() => this.songs().filter((s) => s.mbYear && s.mbYear !== s.spotifyYear).length);
  /** Só as faixas com "remaster" no nome passam pela conferência de ano. */
  uncheckedCount = computed(() => this.songs().filter((s) => s.remaster && !s.checked).length);
  remasterCount = computed(() => this.songs().filter((s) => s.remaster).length);

  constructor() {
    const lib = this.readJson<{ name: string; input: string; songs: Song[] }>(LIB);
    if (lib) { this.playlistName.set(lib.name); this.playlistInput.set(lib.input); this.songs.set(lib.songs); }
    void this.finishLogin();
  }

  // ---------- util ----------
  private readJson<T>(k: string): T | null {
    try { return JSON.parse(store.get(k) ?? 'null') as T | null; } catch { return null; }
  }
  private saveLib(): void {
    store.set(LIB, JSON.stringify({ name: this.playlistName(), input: this.playlistInput(), songs: this.songs() }));
  }
  private fail(e: unknown): void {
    if (e instanceof AuthError) this.loggedIn.set(false);
    this.error.set(e instanceof Error ? e.message : String(e));
    this.busy.set('');
  }
  val(e: Event): string { return (e.target as HTMLInputElement).value; }
  color(y: number): string { return COLORS[Math.floor(y / 10) % COLORS.length]; }

  // ---------- Spotify ----------
  private async finishLogin(): Promise<void> {
    try {
      const pending = await this.sp.handleRedirect();
      this.loggedIn.set(this.sp.hasSession);
      this.canControl.set(this.sp.canControlPlayback);
      if (pending) { this.playlistInput.set(pending); await this.load(); }
    } catch (e) { this.fail(e); }
  }

  saveClientId(v: string): void {
    this.sp.clientId = v;
    this.clientId.set(v.trim());
  }

  async login(): Promise<void> {
    this.error.set('');
    if (!this.clientId()) { this.showSettings.set(true); this.error.set('Cole o Client ID do seu app do Spotify.'); return; }
    try { await this.sp.login(this.playlistInput()); } catch (e) { this.fail(e); }
  }

  logout(): void { this.sp.logout(); this.loggedIn.set(false); this.canControl.set(false); }

  // ---------- som ----------
  setAudioMode(m: 'connect' | 'embed'): void { this.audioMode.set(m); store.set('lds.audio', m); }

  async findDevices(): Promise<void> {
    this.playMsg.set('Procurando aparelhos…');
    try {
      const list = await this.sp.devices();
      this.devices.set(list);
      if (!list.length) {
        this.playMsg.set('Nenhum aparelho encontrado. Abra o app do Spotify neste celular, toque qualquer música por um segundo e procure de novo.');
        return;
      }
      const keep = list.find((d) => d.id === this.deviceId()) ?? list.find((d) => d.is_active) ?? (list.length === 1 ? list[0] : null);
      if (keep) this.chooseDevice(keep);
      this.playMsg.set('');
    } catch (e) { this.playMsg.set(e instanceof Error ? e.message : String(e)); if (e instanceof AuthError) this.loggedIn.set(false); }
  }

  chooseDevice(d: Device): void {
    this.deviceId.set(d.id); this.deviceName.set(d.name);
    store.set('lds.device', d.id); store.set('lds.deviceName', d.name);
  }

  async playCurrent(): Promise<void> {
    const c = this.game()?.card;
    if (!c) return;
    this.playMsg.set('');
    try {
      await this.sp.playTrack(c.id, this.deviceId());
      this.playing.set(true);
    } catch (e) {
      this.playing.set(false);
      this.playMsg.set(e instanceof Error ? e.message : String(e));
    }
  }

  async pausePlayback(): Promise<void> {
    this.playing.set(false);
    await this.sp.pause(this.deviceId());
  }

  reloadEmbed(): void { this.embedNonce.update((n) => n + 1); }

  copied = signal(false);
  async copyRedirect(): Promise<void> {
    try { await navigator.clipboard.writeText(this.redirectUri); this.copied.set(true); setTimeout(() => this.copied.set(false), 2000); }
    catch { /* o usuário pode copiar à mão */ }
  }

  async load(): Promise<void> {
    this.error.set('');
    const id = SpotifyService.parsePlaylistId(this.playlistInput());
    if (!id) { this.error.set('Não reconheci o link. Use o "Compartilhar → Copiar link da playlist" do Spotify.'); return; }
    if (!this.sp.hasSession) { await this.login(); return; }
    try {
      this.busy.set('Carregando playlist…');
      const r = await this.sp.loadPlaylist(id, (n) => this.busy.set(`Carregando… ${n} músicas`));
      if (!r.songs.length) throw new Error('A playlist não tem faixas de música.');
      this.playlistName.set(r.name);
      this.songs.set(r.songs);
      this.saveLib();
      this.busy.set('');
      if (this.uncheckedCount()) void this.checkYears();
    } catch (e) { this.fail(e); }
  }

  // ---------- anos ----------
  async checkYears(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.stopRequested = false;
    const list = this.songs();
    const todo = list.filter((s) => s.remaster && !s.checked);
    let done = 0;
    for (const s of todo) {
      if (this.stopRequested) break;
      this.checkProgress.set(`Conferindo anos originais… ${done}/${todo.length}`);
      try {
        const y = await this.mb.originalYear(s);
        s.mbYear = y;
        if (y && (s.year === s.spotifyYear || !s.year)) s.year = Math.min(y, s.spotifyYear || y);
      } catch { /* sem rede? deixa o ano do Spotify */ }
      s.checked = true;
      done++;
      this.songs.set([...list]);
      if (done % 10 === 0) this.saveLib();
    }
    this.saveLib();
    this.checking.set(false);
    this.checkProgress.set('');
  }

  stopCheck(): void { this.stopRequested = true; }

  setYear(s: Song, v: string): void {
    const y = parseInt(v, 10);
    if (y >= 1900 && y <= 2100) { s.year = y; this.songs.set([...this.songs()]); this.saveLib(); }
  }
  toggleSong(s: Song): void { s.off = !s.off; this.songs.set([...this.songs()]); this.saveLib(); }

  // ---------- jogadores ----------
  setName(i: number, v: string): void {
    const n = [...this.names()]; n[i] = v; this.names.set(n); store.set('lds.names', JSON.stringify(n));
  }
  addPlayer(): void { if (this.names().length < 10) this.setName(this.names().length, `Jogador ${this.names().length + 1}`); }
  removePlayer(i: number): void {
    const n = this.names().filter((_, j) => j !== i); this.names.set(n); store.set('lds.names', JSON.stringify(n));
  }
  setMask(v: string): void { this.maskOpen.set(+v); store.set('lds.mask', v); }

  // ---------- jogo ----------
  private shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  private touch(): void { this.game.update((g) => (g ? { ...g } : g)); }

  start(): void {
    this.error.set('');
    const players = this.names().map((n) => n.trim()).filter(Boolean);
    const pool = this.activeSongs();
    if (!players.length) { this.error.set('Adicione pelo menos um jogador.'); return; }
    if (pool.length < players.length + 3) { this.error.set(`Poucas músicas: precisa de pelo menos ${players.length + 3}.`); return; }
    if (this.audioMode() === 'connect' && !this.canControl()) { this.error.set('Entre de novo com o Spotify para liberar o controle do player (passo 3).'); return; }
    if (this.audioMode() === 'connect' && !this.deviceId()) { this.error.set('Escolha o aparelho onde a música vai tocar (passo 3).'); return; }
    const deck = this.shuffle(pool.map((s) => ({ ...s })));
    this.game.set({
      players: players.map((name) => ({ name, tl: [deck.pop()!], tokens: Math.max(0, this.startTokens()) })),
      deck, cur: 0, card: null, sel: null, phase: 'guess', ok: false, placedId: null, bonus: false, winner: null,
    });
    this.draw();
    window.scrollTo({ top: 0 });
  }

  private draw(): void {
    const g = this.game();
    if (!g) return;
    if (!g.deck.length) { this.finish(); return; }
    g.card = g.deck.pop()!;
    g.sel = null; g.phase = 'guess'; g.bonus = false; g.placedId = null;
    this.playMsg.set('');
    this.touch();
    this.scrollStrip('middle');
    if (this.audioMode() === 'connect') void this.playCurrent();
  }

  choose(i: number): void { const g = this.game(); if (g && g.phase === 'guess') { g.sel = i; this.touch(); } }

  confirm(): void {
    const g = this.game();
    const p = this.current();
    if (!g || !p || !g.card || g.sel === null) return;
    const prev = p.tl[g.sel - 1];
    const next = p.tl[g.sel];
    const c = g.card;
    g.ok = (!prev || prev.year <= c.year) && (!next || c.year <= next.year);
    if (g.ok) { p.tl.splice(g.sel, 0, c); g.placedId = c.id; }
    g.phase = 'reveal';
    this.touch();
    this.scrollStrip(g.ok ? 'new' : 'none');
  }

  skip(): void { const p = this.current(); if (p && p.tokens > 0) { p.tokens--; this.draw(); } }
  bonus(): void { const g = this.game(); const p = this.current(); if (g && p && !g.bonus) { p.tokens++; g.bonus = true; this.touch(); } }

  next(): void {
    const g = this.game();
    const p = this.current();
    if (!g || !p) return;
    if (p.tl.length >= this.goal()) { g.winner = p.name; this.touch(); return; }
    g.cur = (g.cur + 1) % g.players.length;
    this.draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private finish(): void {
    const g = this.game();
    if (!g) return;
    g.winner = [...g.players].sort((a, b) => b.tl.length - a.tl.length)[0].name;
    this.touch();
  }

  quit(): void {
    if (this.audioMode() === 'connect' && this.playing()) void this.pausePlayback();
    this.game.set(null);
  }

  slotLabel(tl: Song[], i: number): string {
    if (i === 0) return `Antes de ${tl[0].year}`;
    if (i === tl.length) return `Depois de ${tl[tl.length - 1].year}`;
    return `Entre ${tl[i - 1].year} e ${tl[i].year}`;
  }
  // ---------- linha do tempo horizontal + arrastar ----------
  private strip = viewChild<ElementRef<HTMLElement>>('strip');
  drag = signal<{ x: number; y: number; fromStrip: boolean } | null>(null);
  dragOver = signal<number | null>(null);

  private scrollStrip(where: 'middle' | 'new' | 'none'): void {
    if (where === 'none') return;
    setTimeout(() => {
      const el = this.strip()?.nativeElement;
      if (!el) return;
      if (where === 'new') {
        el.querySelector('.sq.new')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      } else {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      }
    }, 60);
  }

  dragStart(e: PointerEvent, fromStrip: boolean): void {
    if (this.game()?.phase !== 'guess') return;
    e.preventDefault();
    this.drag.set({ x: e.clientX, y: e.clientY, fromStrip });
    this.dragOver.set(fromStrip ? this.game()?.sel ?? null : null);
  }

  @HostListener('document:pointermove', ['$event'])
  onMove(e: PointerEvent): void {
    if (!this.drag()) return;
    this.drag.update((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const el = this.strip()?.nativeElement;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (e.clientY < box.top - 90 || e.clientY > box.bottom + 90) { this.dragOver.set(null); return; }
    // rolagem automática perto das bordas
    if (e.clientX < box.left + 48) el.scrollLeft -= 14;
    else if (e.clientX > box.right - 48) el.scrollLeft += 14;
    let best: number | null = null;
    let dist = Infinity;
    el.querySelectorAll<HTMLElement>('[data-i]').forEach((g) => {
      const r = g.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - e.clientX);
      if (d < dist) { dist = d; best = Number(g.dataset['i']); }
    });
    this.dragOver.set(best);
  }

  @HostListener('document:pointerup')
  @HostListener('document:pointercancel')
  onUp(): void {
    const d = this.drag();
    if (!d) return;
    const target = this.dragOver();
    const g = this.game();
    if (g && g.phase === 'guess') {
      g.sel = target;
      this.touch();
    }
    this.drag.set(null);
    this.dragOver.set(null);
  }

  slots(tl: Song[]): number[] { return Array.from({ length: tl.length + 1 }, (_, i) => i); }
}
