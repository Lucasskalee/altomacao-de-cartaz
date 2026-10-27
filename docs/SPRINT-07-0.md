# Sprint 07.0 — Criar Cartaz Scantech (Exportação PSD Editável via Adobe Photoshop)

## 1. Objetivo

Implementar o módulo **Criar Cartaz Scantech** no aplicativo desktop **Skalee Cartazes A5** (`v0.7.0`), permitindo:

1. Criar e persistir pastas de campanhas Scantech localmente (`.skscantech`).
2. Importar planilhas Excel (`.xlsx`) mapeando **F7**, **Descrição**, **Preço**, **Data Inicial** e **Data Final**.
3. Definir uma **validade global** para a campanha ou **validade individual** por produto.
4. Identificar e mapear automaticamente (ou manualmente) as camadas dinâmicas do PSD:
   - **Reais (`whole`)** — parte inteira do preço (à esquerda).
   - **Centavos (`fraction`)** — 2 dígitos decimais (à direita).
   - **Validade (`validity`)** — camada de texto da validade (ex.: `"OFERTA VÁLIDA ATÉ 25/10"`).
5. Apresentar **prévia visual antes da exportação** com o preço e o texto de validade atualizados.
6. Integrar com o **Adobe Photoshop instalado no Windows** via automação **ExtendScript JSX (`photoshop.exe -r`)** para abrir o PSD original, atualizar somente o conteúdo textual das camadas de Reais, Centavos e Validade preservando fontes, efeitos (`DropShadow`, `Stroke`), vetores e demais elementos, e **salvar uma cópia `.psd` editável** sem modificar o PSD original.

---

## 2. Inspeção da Arte de Referência e Ambiente Photoshop

### 2.1. Arte de Referência (`cerveja corona extra lata 350ml.psd`)
- **Dimensões:** `1179 × 1770 px`, RGB 8 bits, 14 camadas:
  - `[2]` `"CERVEJA "` (Texto, `ArialMT`, `Stroke`)
  - `[3]` `"CORONA"` (Texto, `BrushHandNew`)
  - `[5]` `"EXTRA / LATA"` (Texto, `ArialMT`, `Stroke`)
  - `[7]` `"269ML"` (Texto, `BrushHandNew`)
  - `[8]` `"Rectangle 3"` (Linha dos centavos, `DropShadow`)
  - `[9]` `", "` (Vírgula, `Zullia`, `DropShadow`)
  - `[10]` `"4"` (Reais, `Zullia`, `bounds=[105,812,587,1571]`, `DropShadow`)
  - `[11]` `"19"` (Centavos, `Zullia`, `bounds=[612,798,1013,1313]`, `DropShadow`)
  - `[12]` `"OFERTA VÁLIDA ATÉ 15/10"` (Oculta `hidden=true`, `Impact`)
  - `[13]` `"OFERTA VÁLIDA ATÉ 25/10"` (Visível `hidden=false`, `Impact`, `bounds=[118,1602,1033,1675]`)

### 2.2. Detecção do Adobe Photoshop no Windows
- **Versão instalada detectada:** **Adobe Photoshop CS6 (`13.0.1`, 32-bit)**
- **Caminho do executável:** `C:\programinha\app\photoshopcs6\photoshop.exe`
- **Registro COM (`LocalServer32`):** `HKLM\SOFTWARE\WOW6432Node\Classes\CLSID\{99aea70e-4d13-44bf-a878-33345cbfcbc8}\LocalServer32`
- **Mecanismo de automação selecionado:** Execução de lote via **ExtendScript JSX (`photoshop.exe -r script.jsx`)** com `app.displayDialogs = DialogModes.NO`.
  - **Por que JSX `-r` em vez de COM direto (`New-Object -ComObject`):** Como o aplicativo Tauri roda em 64-bit e o Photoshop CS6 instalado é um servidor 32-bit (`WOW6432Node`), chamadas COM fora de processo podem aguardar diálogos modais quando o Photoshop está fechado. Já a invocação via linha de comando `photoshop.exe -r <job.jsx>` funciona tanto com o Photoshop aberto quanto fechado, processa múltiplos arquivos em lote numa única sessão e grava um JSON estruturado de verificação após reabrir cada `.psd` salvo.

---

## 3. Segurança e Validação do PSD Gerado

1. **Proteção do PSD original:**
   - Tanto no Rust (`validate_export_job` em `src-tauri/src/scantech.rs`) quanto no script ExtendScript (`srcFile.fsName.toLowerCase() === dstFile.fsName.toLowerCase()`), a sobrescrita do arquivo PSD original é bloqueada.
   - O tamanho em bytes e o hash SHA-256 do arquivo original são verificados antes e depois da exportação.
2. **Rejeição de imagens rasterizadas renomeadas como `.psd`:**
   - A função `validate_editable_psd_file` inspeciona binariamente o arquivo `.psd` exportado:
     - Verifica a assinatura mágica `8BPS` e versão `1`.
     - Verifica dimensões válidas (`1..=10000`).
     - Verifica que a seção **Layer and Mask Information** possui tamanho `> 0` (não achatada).
     - Verifica a presença de blocos tipográficos nativos do Photoshop (`TySh` — Type Tool Object Setting), garantindo que as camadas de texto continuam editáveis.
   - Além disso, o próprio script ExtendScript reabre o `.psd` exportado no Photoshop e lê `textItem.contents` das camadas de Reais, Centavos e Validade para confirmar a gravação.

---

## 4. Limitações Documentadas

1. **Dependência do Adobe Photoshop no Windows para exportação `.psd` editável:**
   - A prévia visual em tela funciona 100% offline sem Photoshop (usando o motor Canvas/ag-psd do aplicativo).
   - A geração de novos arquivos `.psd` mantendo camadas de texto nativas (`TySh`) e efeitos de camada (`lfx2` / `DropShadow` / `Stroke`) requer o Adobe Photoshop instalado localmente no Windows. Caso o Photoshop não seja detectado, o botão de exportação PSD fica desabilitado com aviso claro.
2. **Fontes instaladas no sistema operacional:**
   - Ao atualizar `layer.textItem.contents` no Photoshop, o Photoshop utiliza as fontes instaladas no Windows (`Zullia`, `Impact`, `BrushHandNew`, `ArialMT`) para recalcular os glifos da camada de texto. Caso uma fonte específica da arte não esteja instalada no Windows, o Photoshop poderá substituir a renderização tipográfica da camada editada.
3. **Camadas de validade com formatação mista:**
   - A atualização preserva integralmente o estilo da camada de validade e substitui apenas a data (ex.: `"OFERTA VÁLIDA ATÉ 25/10"` → `"OFERTA VÁLIDA ATÉ 31/10"`), mantendo o prefixo artístico original.

