# Linha do Som

Jogo de linha do tempo musical, no estilo do Hitster. Você cola o link de uma playlist do Spotify, o app carrega as faixas, confere o ano original de cada música e toca tudo na própria página, com o nome escondido.

Feito em Angular 20 (standalone, signals, sem zone.js). Não tem backend: o login no Spotify usa PKCE direto no navegador.

## Como publicar (uns 10 minutos)

### 1. GitHub
1. Crie um repositório, por exemplo `linha-do-som`, e envie estes arquivos para a branch `main`.
2. No repositório, abra **Settings → Pages** e, em *Source*, escolha **GitHub Actions**.
3. O workflow `.github/workflows/deploy.yml` compila e publica sozinho a cada push. O endereço fica assim:
   `https://SEU-USUARIO.github.io/linha-do-som/`

### 2. Spotify (precisa de conta Premium)
1. Entre em https://developer.spotify.com/dashboard e crie um app.
2. Em **Redirect URIs**, coloque o endereço exato do site, com a barra no final:
   `https://SEU-USUARIO.github.io/linha-do-som/`
   (o próprio app mostra esse endereço em **Ajustes**, com um botão para copiar)
3. Em *Which API/SDKs are you planning to use?*, marque **Web API**.
4. Copie o **Client ID** (o Client Secret não é usado).
5. Se outras pessoas também forem entrar com o Spotify delas, adicione o e-mail de cada uma em **User Management**. O modo de desenvolvimento aceita até 5 usuários. Para jogar em grupo, basta você entrar.

### 3. Jogar
1. Abra o site, toque em **Ajustes** e cole o Client ID.
2. Cole o link da playlist e toque em **Entrar e carregar**.
3. O app confere os anos no MusicBrainz (cerca de 1 música por segundo). Você pode revisar e corrigir os anos em **Revisar músicas e anos**.
4. Coloque os jogadores e comece.

## Regras implementadas
- Cada jogador começa com uma carta aberta.
- Na sua vez, dê o play na música (o nome fica escondido) e escolha o espaço da sua linha do tempo onde ela entra.
- Se acertar, o cartão fica com você. Se errar, vai para o descarte.
- Se acertar o artista e o nome da música, ganha +1 ficha (a turma confere). Uma ficha serve para pular uma música.
- Ganha quem chegar primeiro ao número de cartas combinado.

## Limitações conhecidas
- **Só playlists suas ou colaborativas.** Desde fevereiro de 2026 o Spotify não libera, para apps em modo de desenvolvimento, as faixas de playlists de outras pessoas. Para usar uma dessas, duplique a playlist para a sua conta antes.
- **Onde a música toca.** No modo *App do Spotify* (o padrão), o jogo usa o Spotify Connect: manda a faixa tocar inteira no app do Spotify, que fica aberto em segundo plano. Exige Premium. No modo *Player embutido*, o player do Spotify fica dentro da página, mas no celular ele só toca prévias.
- **Máscara do player (só no modo embutido).** O nome e a capa ficam cobertos e só o botão de play aparece. Se o Spotify mudar o layout e o botão ficar escondido, ajuste em "O botão de play ficou escondido?".
- **Anos.** O Spotify mostra o ano do álbum, que pode ser de um remaster ou de uma coletânea. O app usa o menor ano entre o do Spotify e o do MusicBrainz. Músicas pouco conhecidas podem ficar com o ano errado, então vale revisar a lista.

## Rodar localmente
```bash
npm install
npx ng serve --host 127.0.0.1
```
Cadastre também `http://127.0.0.1:4200/` como Redirect URI no Spotify, porque o Spotify não aceita `localhost`.
