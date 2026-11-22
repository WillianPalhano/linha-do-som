import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { AuthError, Device, Song, SpotifyService, store } from './spotify.service';
import { MusicBrainzService } from './musicbrainz.service';

interface Player { name: string; tl: Song[]; tokens: number }
/** Uma posição escolhida na linha do tempo do jogador da vez (a dele ou a de quem contestou). */
interface Pick { p: number; slot: number; ok?: boolean }
interface Game {
  players: Player[];
  deck: Song[];
  cur: number;
  card: Song | null;
  /** guess: jogador da vez escolhe · challenge: rodada de "Hitster!" · reveal: ano aberto */
  phase: 'guess' | 'challenge' | 'reveal';
  picks: Pick[];        // picks[0] é sempre do jogador da vez
  picker: number | null; // quem está escolhendo agora
  sel: number | null;    // posição sendo escolhida (ainda não confirmada)
  ok: boolean;           // o jogador da vez acertou?
  winnerOfCard: number | null;
  log: string[];
  placedId: string | null;
  /** Rodada de nome e artista: alguém já acertou? quem já tentou? quem está tentando? */
  nameDone: boolean;
  nameTried: number[];
  namePending: number | null;
  nameLog: string[];
  /** Depois de revelar o ano, nome e artista ficam escondidos até alguém tocar em "Revelar nome e artista". */
  namesShown: boolean;
  winner: string | null;
}

/** Janelas sobre o jogo: música pulada, carta comprada ou aviso de que a pessoa vai ficar sem ficha. */
interface Notice {
  kind: 'skip' | 'bought' | 'confirm';
  who: string;
  card?: Song;
  /** confirm: quantas fichas a ação custa, o que ela faz e o que rodar se a pessoa seguir em frente. */
  cost?: number;
  action?: string;
  run?: () => void;
  /** bought: índice de quem comprou, para conferir se completou a linha. */
  buyer?: number;
}

/** Custo de comprar uma carta extra, que entra direto na posição certa. */
export const BUY_COST = 3;

const COLORS = ['#ff4f9a', '#2fd6c3', '#ffd23f', '#ff9f43', '#a78bfa'];
const LIB = 'lds.library';          // formato antigo (uma playlist só), migrado na primeira abertura
const PLAYLISTS = 'lds.playlists';
const CURRENT = 'lds.current';

/** Playlist já analisada, guardada no navegador com os anos conferidos e as edições. */
interface SavedPlaylist { id: string; name: string; input: string; songs: Song[]; savedAt: number }

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
  playlists = signal<SavedPlaylist[]>([]);
  currentId = signal('');
  confirmDelete = signal('');
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
    let list = this.readJson<SavedPlaylist[]>(PLAYLISTS) ?? [];
    const old = this.readJson<{ name: string; input: string; songs: Song[] }>(LIB);
    if (old?.songs?.length) {
      const id = SpotifyService.parsePlaylistId(old.input) ?? 'antiga';
      if (!list.some((p) => p.id === id)) list = [{ id, name: old.name, input: old.input, songs: old.songs, savedAt: Date.now() }, ...list];
      store.del(LIB);
      store.set(PLAYLISTS, JSON.stringify(list));
    }
    this.playlists.set(list);
    const cur = list.find((p) => p.id === store.get(CURRENT)) ?? list[0];
    if (cur) this.select(cur.id);
    void this.finishLogin();
  }

  // ---------- util ----------
  private readJson<T>(k: string): T | null {
    try { return JSON.parse(store.get(k) ?? 'null') as T | null; } catch { return null; }
  }
  /** Grava a playlist atual (songs/nome) dentro da biblioteca. */
  private saveLib(): void {
    const id = this.currentId();
    if (!id) return;
    const entry: SavedPlaylist = {
      id, name: this.playlistName(), songs: this.songs(),
      input: this.playlists().find((p) => p.id === id)?.input ?? this.playlistInput(),
      savedAt: this.playlists().find((p) => p.id === id)?.savedAt ?? Date.now(),
    };
    const list = this.playlists().some((p) => p.id === id)
      ? this.playlists().map((p) => (p.id === id ? entry : p))
      : [entry, ...this.playlists()];
    this.playlists.set(list);
    store.set(PLAYLISTS, JSON.stringify(list));
    store.set(CURRENT, id);
  }

  select(id: string): void {
    const p = this.playlists().find((x) => x.id === id);
    if (!p || this.checking()) return;
    this.currentId.set(p.id);
    this.playlistName.set(p.name);
    this.songs.set(p.songs);
    this.showList.set(false);
    this.confirmDelete.set('');
    store.set(CURRENT, p.id);
  }

  remove(id: string): void {
    if (this.checking() && id === this.currentId()) return;
    if (this.confirmDelete() !== id) { this.confirmDelete.set(id); return; }
    const list = this.playlists().filter((p) => p.id !== id);
    this.playlists.set(list);
    store.set(PLAYLISTS, JSON.stringify(list));
    this.confirmDelete.set('');
    if (id === this.currentId()) {
      this.currentId.set(''); this.songs.set([]); this.playlistName.set(''); store.del(CURRENT);
      if (list[0]) this.select(list[0].id);
    }
  }

  /** Recarrega do Spotify uma playlist salva (pega músicas novas, mantém anos já conferidos/editados). */
  refresh(p: SavedPlaylist): void { this.playlistInput.set(p.input); void this.load(); }

  savedDate(t: number): string { return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }); }
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
      const used = await this.sp.playTrack(c.id, this.deviceId(), this.deviceName());
      if (used && used !== this.deviceId()) {
        this.deviceId.set(used); store.set('lds.device', used);
      }
      this.playing.set(true);
      void this.sp.repeatTrack(used);
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
      // Se a playlist já estava salva, preserva o que foi conferido/editado em cada faixa.
      const prev = new Map((this.playlists().find((p) => p.id === id)?.songs ?? []).map((s) => [s.id, s]));
      const songs = r.songs.map((s) => {
        const o = prev.get(s.id);
        return o ? { ...s, year: o.year, mbYear: o.mbYear, checked: o.checked, off: o.off } : s;
      });
      this.currentId.set(id);
      this.playlistName.set(r.name);
      this.songs.set(songs);
      const others = this.playlists().filter((p) => p.id !== id);
      this.playlists.set([{ id, name: r.name, input: this.playlistInput(), songs, savedAt: Date.now() }, ...others]);
      this.saveLib();
      this.playlistInput.set('');
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
      deck, cur: 0, card: null, phase: 'guess', picks: [], picker: 0, sel: null, ok: false,
      winnerOfCard: null, log: [], placedId: null, nameDone: false, nameTried: [], namePending: null, nameLog: [],
      namesShown: false, winner: null,
    });
    this.notice.set(null);
    void this.keepAwake();
    this.draw();
    window.scrollTo({ top: 0 });
  }

  private draw(): void {
    const g = this.game();
    if (!g) return;
    if (!g.deck.length) { this.finish(); return; }
    g.card = g.deck.pop()!;
    g.phase = 'guess'; g.picks = []; g.picker = g.cur; g.sel = null;
    g.ok = false; g.winnerOfCard = null; g.log = []; g.placedId = null;
    g.nameDone = false; g.nameTried = []; g.namePending = null; g.nameLog = []; g.namesShown = false;
    this.nameWinner.set(null); this.nameMissed.set([]);
    this.playMsg.set('');
    this.touch();
    this.scrollStrip('middle');
    if (this.audioMode() === 'connect') void this.playCurrent();
  }

  /** Posição já ocupada por um palpite confirmado? */
  takenBy(i: number): Pick | undefined { return this.game()?.picks.find((k) => k.slot === i); }
  firstName(i: number): string { return this.game()?.players[i]?.name.split(' ')[0] ?? ''; }

  choose(i: number): void {
    const g = this.game();
    if (!g || g.picker === null || g.phase === 'reveal' || this.takenBy(i)) return;
    g.sel = i; this.touch();
  }

  /** Quem ainda pode gritar "Hitster!": outros jogadores com ficha que não contestaram nesta rodada. */
  challengers = computed(() => {
    const g = this.game();
    if (!g || g.phase !== 'challenge') return [];
    return g.players
      .map((q, i) => ({ q, i }))
      .filter(({ q, i }) => i !== g.cur && q.tokens > 0 && !g.picks.some((k) => k.p === i));
  });

  confirm(): void {
    const g = this.game();
    if (!g || g.picker === null || g.sel === null || this.takenBy(g.sel)) return;
    g.picks.push({ p: g.picker, slot: g.sel });
    g.picker = null; g.sel = null; g.phase = 'challenge';
    this.touch();
    if (!this.challengers().length) this.reveal();
  }

  startChallenge(i: number): void {
    const g = this.game();
    if (!g || g.phase !== 'challenge') return;
    this.askSpend(i, 1, 'contestar', () => { g.picker = i; g.sel = null; this.touch(); });
  }
  cancelChallenge(): void { const g = this.game(); if (g) { g.picker = null; g.sel = null; this.touch(); } }

  reveal(): void {
    const g = this.game();
    const cur = this.current();
    if (!g || !cur || !g.card) return;
    const c = g.card;
    const valid = (slot: number) => {
      const prev = cur.tl[slot - 1];
      const next = cur.tl[slot];
      return (!prev || prev.year <= c.year) && (!next || c.year <= next.year);
    };
    g.picks.forEach((k) => (k.ok = valid(k.slot)));
    const [mine, ...rivals] = g.picks;
    g.ok = !!mine.ok;
    g.log = [];

    // Quem fica com o cartão: o jogador da vez se acertou; senão o primeiro que contestou e acertou.
    const taker = g.ok ? mine : rivals.find((k) => k.ok);
    if (taker) {
      const owner = g.players[taker.p];
      const at = taker.p === g.cur ? mine.slot : owner.tl.findIndex((s) => s.year > c.year);
      owner.tl.splice(at < 0 ? owner.tl.length : at, 0, c);
      g.winnerOfCard = taker.p;
      g.placedId = taker.p === g.cur ? c.id : null;
    }
    g.log.push(g.ok ? `${cur.name} acertou e ficou com o cartão.` : `${cur.name} errou a posição.`);

    // Quem contesta paga 1 ficha, a não ser que também tenha acertado junto com o jogador da vez
    // (só acontece quando o ano é igual ao de um cartão vizinho).
    for (const k of rivals) {
      const r = g.players[k.p];
      if (g.ok && k.ok) {
        g.log.push(`${r.name} contestou, mas o ano empatou: não perde a ficha.`);
      } else {
        r.tokens = Math.max(0, r.tokens - 1);
        g.log.push(k === taker
          ? `${r.name} contestou, acertou e roubou o cartão (−1 ficha).`
          : `${r.name} contestou e ${k.ok ? 'acertou, mas chegou depois' : 'errou'} (−1 ficha).`);
      }
    }
    if (!taker && rivals.length) g.log.push('Ninguém acertou: o cartão vai para o descarte.');

    g.phase = 'reveal'; g.picker = null; g.sel = null;
    this.touch();
    this.scrollStrip(g.placedId ? 'new' : 'none');
  }

  /** Pula a música (1 ficha) e mostra nome e artista dela por curiosidade; a próxima sai ao fechar. */
  skip(): void {
    const g = this.game();
    const p = this.current();
    if (!g || !p || !g.card || p.tokens < 1 || g.phase !== 'guess') return;
    const card = g.card;
    this.askSpend(g.cur, 1, 'pular a música', () => {
      p.tokens--;
      this.touch();
      this.notice.set({ kind: 'skip', who: p.name, card });
    });
  }

  // ---------- fichas: avisos e carta extra ----------
  notice = signal<Notice | null>(null);
  readonly buyCost = BUY_COST;

  /** Roda a ação direto, ou avisa antes se ela deixar o jogador sem nenhuma ficha. */
  private askSpend(i: number, cost: number, action: string, run: () => void): void {
    const q = this.game()?.players[i];
    if (!q || q.tokens < cost) return;
    if (q.tokens - cost > 0) { run(); return; }
    this.notice.set({ kind: 'confirm', who: q.name, cost, action, run });
  }

  confirmSpend(): void {
    const n = this.notice();
    this.notice.set(null);
    n?.run?.();
  }

  closeNotice(): void {
    const n = this.notice();
    const g = this.game();
    this.notice.set(null);
    if (!n || !g) return;
    if (n.kind === 'skip') this.draw();
    if (n.kind === 'bought' && n.buyer !== undefined && g.players[n.buyer].tl.length >= this.goal()) {
      g.winner = g.players[n.buyer].name;
      this.touch();
    }
  }

  /**
   * Qualquer um pode comprar a qualquer momento. A única trava é o jogador da vez depois de confirmar
   * a posição (rodada de contestação): a carta nova mudaria os espaços já escolhidos.
   */
  canBuy(i: number): boolean {
    const g = this.game();
    const q = g?.players[i];
    if (!g || !q || g.winner || this.drag() || this.notice()) return false;
    if (q.tokens < BUY_COST || !g.deck.length) return false;
    return !(i === g.cur && g.phase === 'challenge');
  }

  buy(i: number): void {
    const g = this.game();
    if (!g || !this.canBuy(i)) return;
    this.askSpend(i, BUY_COST, 'comprar uma carta', () => {
      const q = g.players[i];
      const c = g.deck.pop();
      if (!c) return;
      q.tokens -= BUY_COST;
      const at = q.tl.findIndex((s) => s.year > c.year);
      q.tl.splice(at < 0 ? q.tl.length : at, 0, c);
      if (i === g.cur) {
        if (g.phase === 'guess') g.sel = null; // os espaços mudaram de lugar
        g.placedId = c.id;
      }
      this.touch();
      if (i === g.cur) this.scrollStrip('new');
      this.notice.set({ kind: 'bought', who: q.name, card: c, buyer: i });
    });
  }

  /** A carta da rodada já na linha do tempo, com nome e artista ainda escondidos? */
  hideName(s: Song): boolean {
    const g = this.game();
    return !!g && g.phase === 'reveal' && !g.namesShown && g.card?.id === s.id;
  }

  showNames(): void { const g = this.game(); if (g) { g.namesShown = true; this.touch(); } }
  // ---------- nome e artista ----------
  /**
   * Quem acertou nome e artista: o jogador da vez ganha +1 de graça.
   * Outro jogador aposta 1 ficha: acertando recupera e ganha +1 (saldo +1); errando perde a apostada (−1).
   */
  nameWinner = signal<number | 'none' | null>(null);
  nameMissed = signal<number[]>([]);

  /** Outros jogadores que podem ter apostado (precisam de pelo menos 1 ficha). */
  nameBettors = computed(() => {
    const g = this.game();
    if (!g) return [];
    return g.players.map((q, i) => ({ q, i })).filter(({ q, i }) => i !== g.cur && q.tokens > 0);
  });

  pickNameWinner(w: number | 'none'): void {
    this.nameWinner.set(this.nameWinner() === w ? null : w);
    this.nameMissed.update((m) => m.filter((i) => i !== w));
  }
  toggleNameMiss(i: number): void {
    this.nameMissed.update((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i]));
  }

  applyNames(): void {
    const g = this.game();
    const w = this.nameWinner();
    if (!g || g.nameDone || w === null) return;
    if (w === 'none') g.nameLog.push('Ninguém acertou nome e artista.');
    else {
      g.players[w].tokens += 1;
      g.nameLog.push(w === g.cur
        ? `${g.players[w].name} acertou nome e artista (+1 ficha).`
        : `${g.players[w].name} apostou, acertou nome e artista (+1 ficha).`);
    }
    for (const i of this.nameMissed()) {
      if (i === w || i === g.cur) continue;
      const r = g.players[i];
      r.tokens = Math.max(0, r.tokens - 1);
      g.nameLog.push(`${r.name} apostou no nome e errou (−1 ficha).`);
    }
    g.nameDone = true;
    this.nameWinner.set(null); this.nameMissed.set([]);
    this.touch();
  }

  next(): void {
    const g = this.game();
    const p = this.current();
    // Só passa a vez depois de revelar o ano e decidir nome e artista.
    if (!g || !p || g.phase !== 'reveal' || !g.nameDone) return;
    const done = [p, ...g.players].find((q) => q.tl.length >= this.goal());
    if (done) { g.winner = done.name; this.touch(); return; }
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
    void this.releaseAwake();
    this.notice.set(null);
    this.game.set(null);
  }

  // ---------- tela sempre ligada (Screen Wake Lock API) ----------
  awake = signal<'on' | 'off' | 'unsupported'>('off');
  private lock: { release(): Promise<void>; addEventListener(t: 'release', f: () => void): void } | null = null;

  private async keepAwake(): Promise<void> {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<NonNullable<AppComponent['lock']>> } }).wakeLock;
    if (!wl) { this.awake.set('unsupported'); return; }
    try {
      this.lock = await wl.request('screen');
      this.awake.set('on');
      this.lock.addEventListener('release', () => { this.lock = null; this.awake.set('off'); });
    } catch { this.awake.set('off'); }
  }
  private async releaseAwake(): Promise<void> {
    const l = this.lock; this.lock = null;
    try { await l?.release(); } catch { /* já liberado */ }
    this.awake.set('off');
  }
  /** O sistema solta o bloqueio quando a aba some; pede de novo ao voltar. */
  @HostListener('document:visibilitychange')
  onVisible(): void {
    if (document.visibilityState === 'visible' && this.game() && !this.lock) void this.keepAwake();
  }
  retryAwake(): void { void this.keepAwake(); }

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
    const g = this.game();
    if (!g || g.picker === null || g.phase === 'reveal') return;
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
    if (g && g.picker !== null && g.phase !== 'reveal') {
      g.sel = target !== null && this.takenBy(target) ? g.sel : target;
      this.touch();
    }
    this.drag.set(null);
    this.dragOver.set(null);
  }

  slots(tl: Song[]): number[] { return Array.from({ length: tl.length + 1 }, (_, i) => i); }
}
