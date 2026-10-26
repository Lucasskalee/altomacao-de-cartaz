# Sprint 03 — Identificação de produtos por F7

Versão do aplicativo: **0.3.0**. Formato `.skcartaz`: **schemaVersion 1**, sem migração.

## Como usar

1. No editor, preencha **Código F7 do produto**. É opcional e aceita digitação/colagem de dígitos ASCII, sem comprimento fixo. O limite global de segurança de 1 MB por documento continua existindo.
2. Salve e reabra o cartaz. `001245` permanece uma string com os zeros à esquerda.
3. A consulta local mostra outros arquivos com esse F7 em qualquer pasta, com produto, preço e caminho. O arquivo atualmente aberto é excluído do aviso por caminho; UUIDs nunca são usados para esconder cópias físicas. O aviso não bloqueia criar, editar ou salvar.
4. Em **Meus Cartazes**, pesquise nome, complemento, nome do arquivo ou F7. A pesquisa textual é parcial e percorre todas as pastas. O filtro **Somente cartazes sem F7** também percorre todas as pastas; sem pesquisa/filtro, a navegação por pasta é preservada.
5. A biblioteca mostra **F7: código** ou **Sem F7** nos detalhes. Nenhum arquivo é renomeado automaticamente.

O F7 identifica o produto. Cada cartaz mantém seu UUID; duplicar cria outro UUID e preserva o F7. Vários cartazes podem ter o mesmo F7, com preços e pastas diferentes. Não há importação Excel/CSV ou alteração automática de preços.

## Compatibilidade

- Documentos antigos com `productCode` ausente, `null` ou vazio abrem com campo vazio. Os demais dados, inclusive campos adicionais, são preservados.
- A v0.2.0 permitia códigos em texto livre. Esses valores também são preservados ao abrir/salvar, mas não são considerados F7 válido. O editor mostra o código antigo em uma nota e deixa o novo campo F7 vazio; inserir um F7 substitui explicitamente o código antigo. A biblioteca identifica esses arquivos como sem F7 e mostra o código antigo nos detalhes.
- Códigos numéricos em JSON, por exemplo `1245` sem aspas, são recusados: poderiam ter perdido zeros. Não há conversão automática para número nem normalização que faça `001245` corresponder a `1245`.

## Consulta reutilizável para futuras importações

```ts
import { findCartazesByF7 } from './src/features/cartazes/storage';

const cartazes = await findCartazesByF7('001245');
for (const { path, document } of cartazes) {
  console.log(path, document.id, document.product.priceCents);
}
```

Essa função relê a biblioteca local recursivamente via IPC Tauri e retorna todos os documentos válidos com correspondência **exata** de F7. Não grava arquivos, não altera preços e não usa rede. Códigos vazios/inválidos retornam lista vazia. Arquivos corrompidos não entram na consulta e continuam aparecendo como erro na biblioteca.

`f7.ts` fornece também `indexCartazes`, a consulta pura `findCartazesByF7(f7, indice)`, `matchesCartazSearch`, `withoutF7`, `getF7` e `digitsOnly`. A biblioteca indexa o snapshot em memória; o editor faz consulta ao disco após 300 ms sem digitação, descartando respostas obsoletas. O botão Atualizar relê alterações externas. Erros de consulta são visíveis e não impedem salvar.

## Arquivos criados/modificados

- `src/features/cartazes/f7.ts` — regras de F7, índice, pesquisa e consulta exata (novo).
- `src/features/cartazes/presentation.ts` — projeção explícita dos dados visuais, sem F7 (novo).
- `src/components/editor/F7Field.tsx` — campo e aviso de cartazes correspondentes (novo).
- `src/hooks/useF7Matches.ts` — consulta com atraso e proteção contra respostas obsoletas (novo).
- `src/features/cartazes/types.ts`, `validation.ts`, `storage.ts` — campo opcional, compatibilidade e consulta local.
- `src/hooks/useCartaz.ts` — novos valores de F7 aceitam apenas dígitos.
- `src/App.tsx`, `src/components/library/Library.tsx`, `src/styles.css` — integração com editor/biblioteca.
- `src-tauri/src/storage.rs` — compatibilidade com códigos sem tamanho fixo e teste real de persistência F7.
- `tests/cartazes.test.tsx` — cobertura automatizada do F7 e regressões.
- `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `scripts/check-config.mjs`, `.github/workflows/windows-exe.yml` — versão 0.3.0 e nome do artefato.
- `README.md` e este documento — instruções e limites da verificação.

`PosterView.tsx` e `exportPng.ts` não foram alterados. A função `posterFromDocument` projeta apenas nome, complemento, preço e unidade para todas as saídas visuais.

## Testes e compilação

Comandos locais executados com sucesso na implementação: `npm.cmd run typecheck`, `npm.cmd test` (15 testes), `npm.cmd run build` e `npm.cmd run check:config`.

Os testes cobrem: serialização/reabertura, centavos, dados adicionais, zeros à esquerda, código longo, dados antigos ausentes/nulos/vazios/textuais, rejeição de código numérico, consulta em subpastas, múltiplos cartazes/UUIDs/preços, busca por nome/F7, filtro sem código, aviso não bloqueante e manutenção de preço/layout/UUID ao editar F7.

O teste de impressão compara o markup de prévia/impressão antes/depois do F7. O teste PNG usa um contexto canvas simulado e confere que os comandos de desenho e dimensões 1748 × 2480 são idênticos. O teste offline bloqueia `fetch` e usa o mock IPC oficial do Tauri para salvar, reabrir e consultar a biblioteca. Essas verificações não substituem uma sessão manual no WebView nem impressão física.

Rust/Cargo não estão instalados no ambiente local. O workflow Windows executa os testes frontend e `cargo test --manifest-path src-tauri/Cargo.toml`, incluindo leitura/escrita real em diretório temporário para preservar F7 e dados antigos. Depois compila NSIS e publica **Skalee-Cartazes-A5-v0.3.0-Windows-x64**, com instalador **Skalee-Cartazes-A5-0.3.0-windows-x64-setup.exe**, checksum e commit de origem. Consulte o resultado da execução na [página do workflow](https://github.com/Lucasskalee/altomacao-de-cartaz/actions/workflows/windows-exe.yml); a configuração por si só não prova sucesso da compilação.

## Conferência manual recomendada

Criar Repolho Verde com F7 `001245`, salvar em Hortifruti, fechar/reabrir, buscar `001245`, duplicar para outra pasta e conferir os dois resultados. Alterar somente F7 e conferir preço/layout; abrir arquivo antigo sem o campo, adicionar F7 e salvar. Com rede desligada, repetir a consulta e o salvamento. Imprimir em A5 e exportar PNG, conferindo que nenhum F7 foi acrescentado ao desenho. Instalação interativa e impressão física não fazem parte dos testes automatizados.
