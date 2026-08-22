# Versão antiga (Socket.io) — não usada em produção

Esta pasta guarda a implementação original do Planning Poker, baseada em
Express + Socket.io com estado em memória no servidor (`server.js`) e
front-end em `public/`.

O app foi migrado para Firebase Realtime Database + GitHub Pages. **A
versão em produção é a pasta `docs/` na raiz do repositório** — é o que o
GitHub Pages serve e o que os squads realmente usam.

Estes arquivos ficam aqui só como referência histórica. Não fazem deploy
automático (o `railway.json`/`render.yaml` aqui dentro não estão mais
conectados a nenhum serviço). Para rodar localmente (fora do fluxo normal
de desenvolvimento): `node legacy-socketio/server.js`.
