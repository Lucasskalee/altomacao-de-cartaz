# Sprint 06.0 — Pastas de Ofertas e Importação Excel · v0.6.0

## Visão Geral e Objetivo

A aba **Pastas de Ofertas** permite organizar campanhas de ofertas futuras por data (ex.: *Ofertas de Amanhã*), importar planilhas Excel (`.xlsx`) contendo **Código F7**, **Descrição** e **Preço Programado**, localizar automaticamente os cartazes existentes na biblioteca local pelo F7 e imprimir versões em lote ou por partes usando o preço programado, **sem modificar em nenhum momento os preços vigentes na biblioteca nem o arquivo Excel original**.

---

## Funcionalidades Implementadas

### 1. Gerenciamento de Pastas de Ofertas
- **Criar, renomear, abrir, duplicar e arquivar/desarquivar** pastas de ofertas independentes.
- Cada pasta possui `id` (UUID v4), `name` (nome da campanha), `campaignDate` (data programada `AAAA-MM-DD`), `archived`, `sourceExcel` e a lista de `items` com seus respectivos cartazes e status de impressão.
- Persistência local em arquivos `.skoferta` dentro de `Documentos/Skalee Cartazes/.ofertas-programadas`, utilizando escrita atômica (`NamedTempFile` + `sync_all` + `persist`) no backend Rust (`src-tauri/src/offers.rs`).
- O diretório `.ofertas-programadas` é oculto na varredura normal de documentos `.skcartaz` (`src-tauri/src/storage.rs`), mantendo a biblioteca existente limpa e 100% compatível.

### 2. Importação de Planilhas Excel (`.xlsx`)
- Leitura 100% local e somente-leitura via comandos Tauri `choose_excel` e `read_excel` (com verificação de assinatura ZIP `PK\x03\x04`, escopo de sessão e limite de 25 MB).
- Descompactação e análise OOXML pura em `src/features/ofertas/excel.ts` (suportando múltiplas abas `xl/workbook.xml`, `xl/sharedStrings.xml`, strings inline, células numéricas e texto formatado).
- **Escolha da aba da planilha** e **seleção da linha do cabeçalho**.
- **Sugestão inteligente de mapeamento** (`suggestColumnMapping`) por nomes de cabeçalho (*F7 / Código / SKU*, *Descrição / Produto*, *Preço / Oferta / Amanhã*) com possibilidade de **mapeamento manual** de cada coluna.
- **Prévia antes da confirmação**, exibindo validações linha a linha:
  - Preservação do **F7 como string**, incluindo zeros à esquerda (`"001245"` ≠ `"1245"`).
  - Conversão exata de preços para **centavos inteiros** (`parseExcelPriceToCents` com `BigInt`).
  - Detecção de células vazias, valores inválidos, códigos F7 duplicados e **preços conflitantes para o mesmo F7** na planilha.

### 3. Associação aos Cartazes da Biblioteca
- Consulta todos os cartazes existentes na biblioteca pelo F7 (`findCartazesByF7`).
- Permite **vários cartazes para o mesmo produto** (ex.: cartaz clássico e arte PSD importada com o mesmo F7).
- Destaca claramente os **produtos sem cartaz** na biblioteca e permite clicar em **Localizar cartazes na biblioteca** após criar novos cartazes.
- Permite selecionar individualmente uma ou mais artes por produto para impressão.

### 4. Preços Programados Isolados
- O preço futuro (`scheduledPriceCents`) é armazenado **exclusivamente na pasta de ofertas**.
- O preço atual de cada `.skcartaz` na biblioteca é exibido lado a lado como referência (`Preço atual na biblioteca: R$ X,XX (intacto)`) e **jamais é sobrescrito**.
- Permite **editar o preço futuro manualmente** dentro da pasta de ofertas.
- Gera prévia visual (`buildScheduledDocument` / `buildScheduledPoster` + `<PosterView />`) preservando integralmente a arte, fontes, temas e camadas PSD.

### 5. Preparação e Impressão por Partes
- Seleção individual de cartazes e definição de **quantidade de cópias** (`copies`) por cartaz.
- Controle de tamanho do lote (**Cartazes por parte**, ex.: 10 cartazes por vez) para impressão fracionada em A5.
- Rastreamento de status por cartaz: **`pendente`**, **`preparado`** e **`impresso`**.
- **Confirmação manual de conclusão da impressão**: após enviar uma parte para `window.print()`, o operador confirma manualmente se a impressão física foi concluída para marcar aquele lote como `impresso` e avançar para a próxima parte.
- Suporte a **reimpressão** de cartazes selecionados e manutenção integral do progresso ao fechar e reabrir o aplicativo.

---

## Segurança e Compatibilidade

- **100% Offline**: nenhuma requisição de rede.
- **Zero mutação de preços vigentes**: nenhuma função de `src/features/ofertas/*` ou `src-tauri/src/offers.rs` escreve em arquivos `.skcartaz`.
- **Zero mutação do Excel**: o arquivo `.xlsx` é aberto apenas com `fs::read` após seleção explícita do usuário no diálogo nativo.
- **Compatibilidade total**: funciona tanto com cartazes do modelo `oferta-classica` quanto com artes `imported-psd` da Sprint 05.0, sem alterar o fluxo DBF da aba *Importação de Preços*.

