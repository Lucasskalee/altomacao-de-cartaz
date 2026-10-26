# Sprint 05.0 — Importação de Artes PSD e Vinculação por F7 · v0.5.0

## Fluxo de Importação e Edição

1. Em **Meus Cartazes**, clique **Importar Arte · PSD**.
2. Clique **Selecionar arquivo PSD**. O diálogo nativo do Windows filtra `.psd` e autoriza a leitura somente do arquivo escolhido, sem modificar o original.
3. O importador analisa a composição, extrai as camadas e grupos, identifica automaticamente as camadas candidatas de **Reais**, **Centavos**, **Vírgula** e **Linha dos centavos**, e extrai das camadas visíveis o **Nome**, **Complemento**, **Unidade** e **Preço original** (quando presentes e reconhecíveis; nenhum valor fictício é preenchido caso ausentes).
4. Confira lado a lado a **Composição original** (imagem composta incorporada ao PSD) e o **Teste do preço** (reconstruído sobre a base estática sem as camadas dinâmicas do preço antigo).
5. Ajuste ou confirme o mapeamento das camadas, preencha o **Código F7** (string de dígitos preservando zeros à esquerda) e teste diferentes valores de preço.
6. Clique **Salvar cartaz importado**, escolha o destino `.skcartaz` pelo diálogo nativo. O cartaz salvo é aberto automaticamente no editor e exibido na biblioteca.
7. No **Editor de Cartazes**, para artes PSD importadas, somente **Preço (R$)** e **Código F7** permanecem editáveis; nome, complemento e unidade ficam bloqueados por pertencerem à arte estática preservada.
8. Cartazes PSD importados participam normalmente da busca por nome/F7, duplicação (gerando novo UUID), exportação **PNG 300 DPI** (`1748 × 2480 px`), **Impressão A5** (`148 × 210 mm`) e **Importação/Atualização de Preços via DBF** com backup e histórico de restauração.

## Independência do PSD Original e Persistência Segura

- O documento `.skcartaz` permanece no `schemaVersion: 1`, utilizando `layout.template: "imported-psd"` e incorporando `staticBackground` e `originalPreview` como PNG `data:image/png;base64,...` dentro do próprio JSON.
- O cartaz salvo é **100% autocontido**: pode ser reaberto, editado, impresso, exportado ou atualizado via DBF mesmo que o arquivo `.psd` original seja movido, renomeado ou excluído.
- Caminhos externos em `staticBackground` ou `originalPreview` são recusados na validação tanto no frontend quanto no backend Rust.
- O limite de tamanho de documento `.skcartaz` e dos respectivos backups em `price-updates` foi ampliado de 1 MB para **12 MB** (`MAX_DOCUMENT_BYTES`), com limite de lote de atualização DBF ajustado para **128 MB** (mantendo até 500 cartazes por lote), garantindo que falhas ou interrupções não causem atualização parcial silenciosa nem invalidem backups de cartazes PSD.

## Regras de Composição e Limitações Reais de Compatibilidade PSD

Para garantir fidelidade visual sem sobrepor o preço novo ao antigo:

1. **Remoção das camadas dinâmicas da base estática**: Ao construir a arte (`buildArtwork`), todas as camadas visíveis **exceto** as camadas mapeadas em `priceParts` (`whole`, `fraction`, `decimal`, `fractionRule`) são desenhadas na ordem original (respeitando opacidade e modos de mesclagem suportados) para formar o `staticBackground`. Assim, os números antigos nunca ficam por baixo do novo preço.
2. **Reconstrução tipográfica e vetorial do preço**:
   - As camadas de texto do preço (`whole`, `fraction`, `decimal`) devem estar visíveis e utilizar a fonte **Zullia** embarcada no aplicativo (`/fonts/Zullia.otf` e `/fonts/Zullia.ttf`).
   - A matriz de transformação afim (`transform`), tamanho de fonte, cor (`fillColor`) e sombra projetada (`dropShadow`: ângulo, distância e desfoque) são extraídos da camada do Photoshop e aplicados no `<canvas>`.
   - A linha abaixo dos centavos (`fractionRule`) é redesenhada vetorialmente nas coordenadas originais com a cor e sombra da camada mapeada.
3. **Ajuste para múltiplos dígitos**:
   - Preços de 1 dígito nos reais (ex.: `R$ 2,99`, `R$ 3,49`) usam a escala exata da matriz original do PSD.
   - Preços de 2 dígitos nos reais (ex.: `R$ 12,99`) aplicam redução proporcional automática e alinhamento dentro da margem esquerda da composição para evitar corte na borda do cartaz.
   - Preços de 3 ou mais dígitos nos reais em artes projetadas para 1 dígito (ex.: `R$ 129,90` no layout do Repolho Verde) exibem o alerta explícito *"O valor é largo demais para a área mapeada. Reduza os dígitos ou prepare a arte."* e bloqueiam a impressão/exportação/salvamento até que um valor compatível seja informado ou a arte seja preparada com área maior para os reais.
4. **Limitações conhecidas do piloto (geram status `Requer preparação` ou avisos)**:
   - **Modo de cor e profundidade**: aceita exclusivamente PSD em modo **RGB** com **8 bits por canal**, até **25 MB**, **10.000 × 10.000 px** e **300 camadas**. Arquivos CMYK, 16/32 bits ou PSB não são aceitos.
   - **Fontes nas camadas dinâmicas de preço**: se uma camada mapeada para reais, centavos ou vírgula não for texto ou usar outra fonte diferente de `Zullia`, a arte é marcada como `requires-preparation` e o salvamento como editável é bloqueado para evitar substituição tipográfica silenciosa. Camadas estáticas (como `REPOLHO` em `BrushHandNew` e `VERDE` em `Impact`) usam os pixels já renderizados pelo Photoshop na camada e não exigem a fonte instalada no sistema.
   - **Máscaras raster e clipping masks**: camadas visíveis com máscara de pixel ativa (`mask` não vetorial / `realMask`) ou recorte de camada (`clipping`) marcam a arte como `requires-preparation`. Máscaras vetoriais de formas (`fromVectorData: true`, como retângulos do Photoshop) já estão incorporadas no bitmap da camada e são suportadas.
   - **Efeitos de camada complexos nas camadas dinâmicas**: nas camadas de preço reconstruídas, são suportados cor sólida e `dropShadow`. Efeitos como traçado (`stroke` ativo), chanfro/entalhe (`bevel`), brilho interno/externo, sobreposição de degradê/padrão ou deformação de texto (*warp*) não são recriados dinamicamente no texto do preço.
   - **Proporção A5**: quando a proporção do PSD difere de `148:210` (ex.: `886 × 1240 px`), o aplicativo emite aviso informativo e aplica encaixe proporcional (`contain`) centralizado em fundo branco, sem distorcer a arte.

## Validação do Piloto (`repolho verde kg.psd`)

O arquivo real `repolho verde kg.psd` foi testado localmente (mantido fora do repositório via `.gitignore`):

- **Dimensões e estrutura**: `886 × 1240 px`, 150 PPI, RGB 8 bits, **26 camadas** detectadas.
- **Integridade do arquivo original**: SHA-256 `d91501bde0f799225917361cbede8aaf71c7d18f1e7ed79412d8d9cddf07e86d` idêntico antes e depois de todos os testes.
- **Extração automática de dados**:
  - Nome: `REPOLHO` (camada `3`)
  - Complemento: `VERDE` (camada `24`)
  - Unidade: `KG` (camada `16`)
  - Preço original: `2,99` (camada `7` = `"2"`, camada `14` = `","`, camada `15` = `"99"`, camada `22` = `"Rectangle 3"`)
- **Comparação visual (`Original 2,99` vs `Reconstruído 2,99`)**: diferença média RGB de **1,49** (em 255) e apenas **1,82%** de pixels com variação perceptível (decorrente exclusivamente do antialiasing entre o motor de texto do Photoshop e o Canvas 2D com a mesma fonte Zullia).
- **Testes de preços**:
  - `R$ 2,99`: reconstruído fielmente, 0 pixels cortados nas bordas, sem avisos de largura.
  - `R$ 3,49`: preço atualizado sem resíduos do `2,99` anterior, mantendo sombra, inclinação, vírgula e linha dos centavos.
  - `R$ 12,99`: ajustado proporcionalmente na área de reais, 0 pixels cortados nas bordas, sem avisos de largura.
  - `R$ 129,90`: aciona corretamente o aviso de largura excessiva para a área de 1 dígito do template original.
- **Persistência e Exportação**: documento `.skcartaz` salvo com F7 `"001245"` e preço `349` centavos (`230.210 bytes`), reaberto e validado com sucesso; PNG exportado em `1748 × 2480 px` (300 DPI).

