# Skalee Cartazes A5 — Sprint 02

Editor desktop Tauri 2 + React + TypeScript. Os cartazes são documentos JSON `.skcartaz` no computador. O aplicativo instalado funciona offline, sem serviços remotos, banco de dados ou localStorage.

## Usar

- **Editor de Cartazes**: preencha nome, complemento, preço, unidade e código opcional. A prévia, a impressão e o PNG usam os mesmos dados.
- **Salvar**: no primeiro salvamento, escolha nome e pasta pelo diálogo nativo. Depois atualiza o mesmo arquivo.
- **Salvar como**: exige um destino novo e mantém o original. Destinos existentes são recusados, mesmo quando o diálogo do Windows permite selecioná-los.
- **Duplicar** no editor: cria uma cópia com outro ID, pronta para salvar. Na biblioteca, escolha diretamente o destino da cópia.
- **Meus Cartazes**: árvore de pastas, subpastas, pesquisa em toda a biblioteca, ordenação por produto ou data real do arquivo, grade/lista, miniaturas, abrir, renomear, mover e excluir. Atualizar relê alterações feitas fora do aplicativo.
- **Nova Pasta** cria uma subpasta da pasta selecionada. Para mover um cartaz, escolha uma pasta dentro da biblioteca pelo diálogo nativo.
- Excluir pede confirmação nativa, inclusive para pastas e todo seu conteúdo. A exclusão é permanente.
- Alterações não salvas pedem confirmação antes de abrir outro documento, criar, duplicar ou fechar a janela. Escolha Não para voltar e salvar.

A biblioteca padrão é o diretório Documentos conhecido pelo Windows, acrescido de `Skalee Cartazes`. A primeira utilização cria Hortifruti, Açougue, Padaria, Mercearia e Bebidas. Nenhum cartaz de exemplo é criado automaticamente. Arquivos escolhidos fora da biblioteca podem ser abertos e salvos; só os arquivos dentro dela aparecem em Meus Cartazes.

## Formato

```json
{
  "schemaVersion": 1,
  "id": "identificador-preservado-ao-editar",
  "product": { "name": "REPOLHO", "complement": "VERDE", "priceCents": 289, "unit": "KG", "productCode": null },
  "layout": { "template": "oferta-classica", "paper": "A5", "orientation": "portrait" },
  "metadata": { "createdAt": "2026-10-26T12:00:00Z", "updatedAt": "2026-10-26T12:00:00Z" }
}
```

`priceCents` é inteiro (289 representa R$ 2,89), com limite de R$ 999.999,99. O documento é validado ao abrir e salvar; versões desconhecidas são recusadas. Campos adicionais são preservados. Não há execução de conteúdo do documento. Arquivos inválidos são apresentados como erros na biblioteca sem impedir a leitura dos demais.

O backend usa comandos Tauri 2, diretório Documentos pelo resolvedor oficial, Rust std para arquivos e rfd para diálogos nativos. Acesso é restrito à biblioteca ou aos arquivos selecionados pelo usuário durante a sessão. Não são concedidas permissões genéricas de filesystem ao frontend. Links/junctions são ignorados na varredura. Escrita usa temporário no mesmo diretório, sincronização e persistência; novos destinos usam no-clobber. Mover arquivos escreve sem sobrescrever antes de remover a origem. Se a remoção falhar, ambas as cópias permanecem e a operação apresenta erro.

## Estrutura / arquivos do Sprint

```text
src/
  App.tsx                         navegação e composição (modificado)
  styles.css                      estilos existentes + biblioteca (modificado)
  components/editor/
    PosterView.tsx                prévia e impressão extraídas do editor
    exportPng.ts                  exportação existente extraída
  components/library/Library.tsx  biblioteca, pastas e ações
  features/cartazes/
    types.ts                      documento e itens da biblioteca
    validation.ts                 validação, centavos e nomes sugeridos
    serialization.ts              JSON, criação e duplicação
    storage.ts                    serviços de acesso ao backend
  hooks/useCartaz.ts               edição, salvamento e alterações pendentes
src-tauri/
  src/lib.rs                      registro dos comandos (modificado)
  src/storage.rs                  arquivos, diálogos, escopo e testes Rust
  Cargo.toml                      dependências Rust (modificado)
  capabilities/default.json       fechamento seguro (modificado)
scripts/test.mjs                  runner de testes frontend
scripts/check-config.mjs          conferência estrutural da configuração
tests/cartazes.test.tsx           testes automatizados
.github/workflows/windows-exe.yml verificações e instalador Windows (modificado)
package.json / package-lock.json  comandos de teste e dependência esbuild
README.md                         instruções e validação
```

## Executar e compilar no Windows

Requisitos: Node.js 22.12+ (ou 24), Rust stable MSVC, Microsoft C++ Build Tools com Desktop development with C++ e Windows SDK, e WebView2. A instalação de dependências e a compilação inicial precisam de internet; o uso do aplicativo instalado não precisa.

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:config
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri -- dev
npm.cmd run tauri -- build --bundles nsis
```

Instalador: `src-tauri/target/release/bundle/nsis/*.exe`. Para visualizar somente a interface, use `npm.cmd run dev`. A biblioteca exige o aplicativo Tauri; no navegador é exibida uma orientação, sem simular persistência.

O workflow **Compilar instalador Windows** continua disponível em Actions, manualmente ou em push em main. Agora executa tipos, testes frontend e Rust antes de gerar o instalador. Baixe o artefato **Skalee-Cartazes-A5-Windows-EXE** após sucesso. Nenhum workflow remoto foi disparado nesta implementação.

## Validação desta entrega

- TypeScript: aprovado (`npm.cmd run typecheck`).
- Testes frontend: 7 aprovados, cobrindo serialização e reabertura, alteração de preço preservando ID, duplicação, dados adicionais, centavos, documentos inválidos, nomes e renderização com escape HTML.
- Build frontend: aprovado (`npm.cmd run build`).
- Testes Rust adicionados para persistência, atualização, duplicação, no-clobber, caminhos, nomes e documentos inválidos; **não executados neste ambiente**.
- `tauri info` identificou Tauri 2/WebView2 e ausência de Rust, Cargo e MSVC/SDK.
- Build NSIS tentado: bloqueado em `cargo metadata` porque Cargo não está instalado. **Não foi gerado instalador nem validada compilação Rust.** A configuração JSON também possui uma verificação estrutural local; a validação completa do Tauri depende do build.

### Roteiro manual pendente no aplicativo Windows

1. Criar REPOLHO / VERDE / 2,89 / KG e salvar em Hortifruti.
2. Fechar e reabrir o aplicativo. Abrir pela biblioteca; confirmar R$ 2,89 e os demais campos.
3. Alterar para 3,49, salvar, fechar e reabrir; confirmar R$ 3,49 no mesmo arquivo e ID.
4. Duplicar, salvar com outro nome, mover a cópia para Mercearia. Confirmar que original e cópia continuam presentes, com IDs distintos.
5. Abrir JSON inválido e versão desconhecida; conferir mensagem e manutenção do documento em edição.
6. Criar subpasta, renomear, tentar usar nome existente, cancelar exclusão de pasta preenchida; verificar preservação dos arquivos.
7. Cancelar os diálogos Abrir/Salvar/Mover; confirmar que nada se perde.
8. Editar e tentar fechar/abrir outro cartaz; conferir confirmação de descarte.
9. Imprimir em A5 vertical, 100%, sem margens/cabeçalhos; medir 148 × 210 mm. Exportar PNG e conferir 1748 × 2480 px e os mesmos dados.
10. Repetir o fluxo com a rede desligada.

## Limitações

Os fluxos nativos de fechar/reabrir, filesystem, diálogos, impressão física e exportação pelo WebView ainda precisam do roteiro acima em uma máquina com toolchain. Os testes de markup não substituem essa validação. A biblioteca faz uma varredura recursiva e gera as miniaturas na interface; coleções muito grandes podem demandar indexação/paginação futura. Não há monitoramento automático de alterações externas nem resolução de conflitos com outro aplicativo editando simultaneamente o mesmo arquivo.

A impressão depende do driver; o PNG tem dimensões equivalentes a aproximadamente 300 DPI, sem metadados físicos de DPI. A tipografia e o desenho de PNG originais foram preservados e podem diferir visualmente da prévia. A lista de preparação continua temporária e não imprime em lote. PDF, Excel/F7 e editor de modelos permanecem fora deste sprint.

Referências das APIs utilizadas: [comandos Tauri 2](https://v2.tauri.app/develop/calling-rust/), [persistência temporária](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html), [diálogos nativos](https://docs.rs/rfd/0.15.4/rfd/struct.AsyncMessageDialog.html).
