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
