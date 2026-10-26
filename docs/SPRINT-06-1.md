# Sprint 06.1 — Importação PSD Diretamente nas Pastas de Ofertas · v0.6.1

## Objetivo

Integrar o importador de artes PSD existente (`PsdImport.tsx`, `importer.ts`, `service.ts`, `importedRenderer.ts`) aos produtos classificados como **“Sem cartaz”** dentro das **Pastas de Ofertas**, permitindo importar o `.psd`, salvar o novo documento `.skcartaz` na biblioteca com F7 vinculado e prepará-lo imediatamente para impressão na campanha com o preço futuro, sem exigir nova importação do Excel e sem alterar os preços base da biblioteca.

---

## Fluxo Implementado

1. **Botão “Importar arte PSD” nas linhas Sem Cartaz**:
   - Na tabela da Pasta de Ofertas (`src/components/ofertas/OfferFolders.tsx`), quando um produto do Excel não possui cartaz na biblioteca (`v.missingPoster === true`), a linha exibe o status **`Sem cartaz (F7 ...)`** e o botão **`Importar arte PSD`**.
2. **Transmissão Automática de Contexto (`PsdImportOfferContext`)**:
   - Ao clicar em **Importar arte PSD**, o modal `PsdImport` recebe:
     ```json
     {
       "folderId": "id-da-pasta",
       "offerItemId": "id-do-item",
       "productCode": "25037",
       "description": "FLV.ABÓBORA KG CABOTIÁ",
       "futurePriceCents": 289
     }
     ```
   - O **Código F7** é pré-preenchido exatamente como string (preservando zeros à esquerda).
   - A descrição do Excel gera uma sugestão estruturada (`suggestFromExcelDescription`: nome `ABÓBORA`, complemento `CABOTIÁ`, unidade `KG`), sem sobrescrever silenciosamente os textos e elementos artísticos extraídos das camadas do PSD (com opção explícita *"Usar descrição do Excel nos metadados"*).
   - A prévia de teste do modal já renderiza o cartaz com o **preço futuro programado** (`R$ 2,89`), enquanto exibe também o **preço base original do PSD** (`R$ 2,99`).
3. **Separação Estrita entre Preço da Biblioteca e Preço da Oferta**:
   - Ao salvar o cartaz importado (`.skcartaz`), o documento salvo na biblioteca preserva seu **UUID próprio** e armazena o **preço base da arte PSD** (ex.: `R$ 2,99` / `299` centavos), mantendo o preço vigente da biblioteca independente da oferta futura.
   - Na Pasta de Ofertas, o cartaz recém-salvo é associado imediatamente ao item da campanha (`linkSavedPosterToCampaignItem`), passando para o status **`Preparado`** (`1` cópia selecionada) e renderizando a **Prévia com Preço Programado** (`R$ 2,89`) sem exigir nova importação do Excel.
4. **Tratamento de Erros e Guardas**:
   - **F7 ausente ou divergente**: exige confirmação manual explícita (`checkbox`) antes de permitir o salvamento.
   - **Camadas incompatíveis**: marca a arte como `Requer preparação` e bloqueia o salvamento.
   - **Cancelamento ou erro de gravação**: mantém a linha como `Sem cartaz`, sem criar associações incompletas nem duplicar registros por cliques repetidos (`savingRef`).
   - **Importação normal pela Biblioteca**: continua funcionando exatamente como na Sprint 05.0 quando aberta por *Meus Cartazes → Importar Arte · PSD*.
5. **Prevenção e Correção de Inversão Reais/Centavos em Artes PSD (ex.: F7 38340 — `R$ 19,89` vs `R$ 89,19`)**:
   - **Causa identificada**: em arquivos PSD com preço de 2 dígitos nos reais onde a camada dos centavos aparece antes da camada dos reais na árvore de camadas do Photoshop (ex.: `arroz rampinelli 5kg tipo1.psd`, camada `9` = `"89"` em `left: 654` e camada `10` = `"19"` em `left: 46`), o mapeamento automático por ordem de índice sugeria a camada da direita (`"89"`) como `whole` (Reais) e a da esquerda (`"19"`) como `fraction` (Centavos).
   - **Correções aplicadas**:
     - `suggest()` em `src/features/psd/importer.ts` agora ordena as camadas numéricas candidatas pela posição horizontal (`bounds.left`/`right`, esquerda → direita) e altura, mapeando sempre a camada da esquerda como **Reais** e a da direita como **Centavos**.
     - `buildArtwork()` bloqueia o salvamento (`requires-preparation`) caso o usuário selecione manualmente uma camada de Reais posicionada à direita da camada de Centavos.
     - `inspectScheduledPriceApplication()` em `src/features/ofertas/service.ts` valida a correspondência exata do preço em centavos inteiros e a ordem geométrica das camadas antes da impressão, **sinalizando o produto na Pasta de Ofertas e bloqueando sua impressão** até a correção, além de oferecer o botão **"Corrigir inversão Reais/Centavos neste cartaz"** na própria linha da oferta e no editor.

---

## Resultado Verificado da Entrega (GitHub Actions · Windows x64)

- **Commit compilado**: `2aa93964ffec779dc9b13a8d4b2bbd51cd9831c4`
- **Workflow concluído com sucesso**: [Execução #40410131691](https://github.com/Lucasskalee/altomacao-de-cartaz/actions/runs/40410131691) (`conclusion: success` em todas as etapas).
- **Verificações aprovadas**:
  - `npm run typecheck`: aprovado.
  - `npm test`: **38/38 testes aprovados localmente** (e 36/36 no CI, onde os 2 arquivos privados locais `consulta01.dbf` e `repolho verde kg.psd` não estão presentes).
  - `npm run build` e `npm run check:config`: aprovados.
  - `cargo test --manifest-path src-tauri/Cargo.toml`: aprovado.
  - `npm run tauri -- build --bundles nsis`: aprovado.
- **Artefato publicado (retido por 30 dias)**:
  - Nome: [`Skalee-Cartazes-A5-v0.6.1-Windows-x64`](https://github.com/Lucasskalee/altomacao-de-cartaz/actions/runs/40410131691/artifacts/12692683811) (`4.662.425 bytes`)
  - Instalador: `Skalee-Cartazes-A5-0.6.1-windows-x64-setup.exe`
  - Digest SHA-256 do artefato ZIP: `8ccedbd0f8e9a7a38aadc0bbecdeb30763263cfb28d3825c64d13e4be5c5eb8a`

