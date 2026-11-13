# 🎨 PintaMundo

**Um wplace para chamar de seu:** canvas colaborativo de pixels sobre o mapa-múndi,
100% estático (funciona no GitHub Pages de graça) com banco de dados grátis (Supabase).

Todo mundo que abrir o link pinta **no mesmo mapa**, em tempo real — e o melhor:
**sem limitação de pintura** (sem cargas, sem cooldown, sem moeda, sem nível).

## ✨ Funcionalidades

- 🗺️ Mapa real (OpenStreetMap) com ~4,4 trilhões de células de 2,09 milhões × 2,09 milhões
- 🖌️ **Todas as cores do mundo**: seletor de cor livre (🎨) + 63 cores rápidas + borracha — pintura clicando **ou arrastando** (traço contínuo)
- ⚡ **Sem limites**: pinte quanto quiser, quando quiser
- 🌍 Multiplayer de verdade: salva no Supabase e sincroniza com todo mundo (polling de 8s)
- 🔍 Zoom de 2× a 18×, coordenadas na tela, dica de zoom mínimo
- 🎲 Botão **Aleatório** que leva você a um lugar já pintado
- 🧭 **Visão geral ao abrir**: sem link de posição, o mapa já encaixa **de cima** onde tem desenho (união dos tiles recentes + a overlay salva), entre os zooms 12 e 13 — um link `#lat,lng,z` sempre abre exatamente onde foi pedido
- ⬇️ Exporta a área visível em **PNG**
- 🔎 **Busca de lugar** no topo (Nominatim/OSM) — aceita nome, `lat, lng` ou coordenadas de pixel `x, y` + botão 📍 **minha localização**
- ⭐ **Favoritos**: salve lugares com nome, gere link para compartilhar (`#lat,lng,z`)
- 🖼️ **Overlay de referência**: carregue uma imagem (ou **arraste e solte** no painel), ancore no mapa e **1 clique pinta um quadrado inteiro** da arte — a resolução define o bloco inicial (1×1 a 8×8) e o **tamanho é livre**: no modo ✋ mover a **pinça (2 dedos) aumenta/reduz** a imagem do jeito que quiser (ou use o controle "Tamanho no mapa"), e a pintura se adapta célula a célula. Imagens maiores que a resolução são reduzidas **por passo inteiro, sem borrão** (cada px da arte vira um bloco puro d×d — arte pixel continua nítida) e **o grid de pixels da imagem é detectado sozinho**: numa arte pixel, cada clique pinta exatamente 1 pixel dela. O botão **📥 importar no mapa** pinta a imagem inteira de uma vez (cor cheia de cada pixel, `Ctrl+Z` desfaz tudo). Barra de progresso e marcas de células faltantes (cinza) ou com cor errada (vermelho)
- 🎨 **Pixel-art Studio**: converta qualquer imagem em pixel art **preservando todas as cores da imagem**, baixe em PNG ou use direto como overlay
- ↩️ **Desfazer/refazer** traços (`Ctrl+Z` / `Ctrl+Shift+Z`)
- 💉 **Conta-gotas**: `Alt`+clique (ou botão) pega a cor **exata** do mapa — ou **da imagem do overlay**, se o clique estiver dentro dela (qualquer cor do mundo)
- ▦ **Grade de pixels** em zoom alto (`G`)
- 🕐 **Atividade recente**: veja os últimos tiles pintados e pule para lá
- 🔗 **Compartilhar posição**: copia um link que reabre exatamente onde você está
- 📊 Contador de tiles pintados na barra de status
- ⌨️ Atalhos: `B` pincel · `M` mover · `E` borracha · `R` aleatório · `G` grade · `O` overlay · `S` studio · `F` favoritos · `Ctrl+Z` desfazer · `Alt`+clique conta-gotas · `+`/`−` zoom · `1`–`9` cores · 🎨 seletor livre · `?` ajuda
- 📱 Funciona no celular (pinça para zoom, dedo para pintar no modo pincel) — **dar zoom nunca pinta**: a pinça cancela o traço em andamento; no modo ✋ mover da overlay, a mesma pinça **muda o tamanho da imagem** em vez de dar zoom

## 🚀 Como colocar no ar (5 minutos)

### 1. Crie o banco grátis no Supabase

1. Crie uma conta em <https://supabase.com> (plano gratuito) e crie um **projeto novo**
   (qualquer nome e senha — anote a senha se quiser).
2. No menu lateral, abra **SQL Editor**, cole o script abaixo e clique em **Run**:

```sql
create table if not exists public.tiles (
  tx         int  not null,
  ty         int  not null,
  d          text not null default '',
  v          int  not null default 1,
  updated_at timestamptz not null default now(),
  primary key (tx, ty)
);

create index if not exists tiles_updated_at_idx
  on public.tiles (updated_at desc);

alter table public.tiles enable row level security;

drop policy if exists "leitura publica" on public.tiles;
create policy "leitura publica" on public.tiles
  for select to anon using (true);

drop policy if exists "escrita publica" on public.tiles;
create policy "escrita publica" on public.tiles
  for insert to anon with check (true);

drop policy if exists "atualizacao publica" on public.tiles;
create policy "atualizacao publica" on public.tiles
  for update to anon using (true) with check (true);
```

3. Vá em **Project Settings → API** e copie:
   - **Project URL** (tipo `https://abcdef.supabase.co`)
   - **anon public key** (chave longa que começa com `eyJ...`)

### 2. Configure o `config.js`

Abra o arquivo `config.js` e cole os dois valores:

```js
window.PINTAMUNDO_CONFIG = {
  supabaseUrl: 'https://SEU-PROJETO.supabase.co',
  supabaseAnonKey: 'eyJ...'
};
```

> A chave `anon` é **pública por natureza** (é para o navegador usar). Não coloque a
> `service_role` nesse arquivo, jamais.

### 3. Suba no GitHub e ative o Pages

```bash
cd pintamundo
git init
git add .
git commit -m "PintaMundo v1"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/pintamundo.git
git push -u origin main
```

No repositório no GitHub: **Settings → Pages → Build and deployment →
Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.

Em ~1 minuto o site estará em `https://SEU-USUARIO.github.io/pintamundo/`.

### 4. Teste localmente (opcional)

```bash
python3 -m http.server 8080
# abra http://localhost:8080
```

## 🧪 Testes

```bash
npm install   # só na primeira vez (instala o jsdom)
npm test      # 203 verificações: geometria, codificação e fumaça do app inteiro
```

- `test/logic.test.mjs` — geometria Mercator, paleta, Bresenham, compressão dos tiles
- `test/smoke.test.mjs` — carrega o `index.html` real num jsdom e exercita mapa,
  pintura, salvamento, conflito de versão e cenário sem configuração

## 🏗️ Como funciona por dentro

| Problema | Solução |
|---|---|
| Só HTML/JS (Pages não tem servidor) | Supabase PostgREST como banco (`GET/PATCH/POST` puros, sem SDK) |
| 4,4 trilhões de células não cabem num arquivo | Grade dividida em **tiles de 256×256** — cada célula guarda **RGBA cheio** (4 bytes, ~256 KB por tile) |
| Tamanho de rede | Cada tile é comprimido com **deflate** e salvo como texto (`C:…`; sem deflate, cru `U:…`) — tiles antigos em índice de paleta (`D:`/`R:`) são lidos e convertidos para cor cheia automaticamente |
| Dois jogadores pintando juntos | Cada tile tem **versão `v`**; gravação usa `WHERE v = …` e, se falhar, recarrega, mescla e reenvia |
| Atualização dos outros jogadores | **Polling de 8s** só nos tiles visíveis (`updated_at > último`) |
| Renda no zoom baixo | Pixels só renderizam a partir do **zoom 12**; pintura a partir do **zoom 14** |
| Pincel arrastando rápido | Interpolação de **Bresenham** entre o ponto anterior e o atual |

### Personalização

Em `logic.js`:

- `PALETTE` — as 63 cores rápidas do seletor (índice `0` é sempre a borracha); o mapa em si guarda **cor cheia RGBA**, então qualquer cor fora da paleta também pinta
- `MIN_RENDER_ZOOM` / `MIN_PAINT_ZOOM` — quando aparecem/pintam os pixels

Em `app.js`, `initMap()`:

- `center` / `zoom` — para onde o mapa abre (padrão: centro do Brasil, zoom 4)

## ⚠️ Segurança e limites

- As políticas RLS acima permitem **leitura e escrita anônima** de propósito
  (é um canvas público, tipo r/place). Se o projeto crescer muito, você pode:
  - limitar taxa no Supabase (Edge Rules / funções), ou
  - exigir login (`auth.users`) nas políticas.
- O plano gratuito do Supabase aguenta bem uma comunidade pequena/média
  (500 MB de banco e 5 GB de transferência/mês).
- Os tiles do OpenStreetMap têm política de uso razoável para sites pequenos —
  mantenha a atribuição (já está no rodapé do mapa). Para alto tráfego, troque por
  outro provedor de tiles.

## 📄 Licença

MIT — use, modifique, publique. Divulda o OSM onde for possível.

Mapa © [OpenStreetMap](https://www.openstreetmap.org/copyright) contribuidores.
Inspirado em [wplace.live](https://wplace.live) e no r/place do Reddit.
