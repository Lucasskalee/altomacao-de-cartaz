# Sprint 04.0 — Teste de importação DBF · v0.4.0

## Uso

Abra **Importação de Preços → Importar DBF**, selecione um arquivo local e confira nome, contagens e avisos. Pesquise F7/descrição e filtre a situação. Cada arquivo de cartaz correspondente aparece em uma linha; os detalhes mostram caminho, UUID, registro DBF, quantidade de repetições e valores originais. A tabela tem até 100 linhas por página. A consulta permanece em memória ao alternar as abas.

**Comparar novamente com a biblioteca** relê os cartazes já salvos. Alterações não salvas no editor não entram na comparação. Se a biblioteca falhar, o DBF continua disponível para inspeção, mas a situação fica **Não comparado**; não é confundida com **Sem cartaz**. A consulta é um snapshot: reimporte para reler um DBF alterado fora do aplicativo.

Não existem comandos de aplicar preços, editar DBF, sobrescrever documentos ou importar para o editor nesta sprint. Impressão A5, PNG, biblioteca e identificação F7 existentes foram preservados.

## Leitura e mapeamento

Leitor compatível com dBASE III (`0x03`/`0x83`), descritores de 32 bytes, campos mapeados `C`, `N` e `F`; campos memo/binários mapeados, versões diferentes e criptografia são recusados claramente. Limites: 25 MB e 100 mil registros. A leitura do arquivo usa handle somente leitura no Rust, acessível apenas para o DBF escolhido no diálogo nativo. A permissão não abrange diretórios nem escrita.

| Campo DBF | Uso |
|---|---|
| CODPROD | F7 como string, sem converter para número nem adicionar zeros |
| DESCRICAO | Descrição exibida e pesquisável |
| PRVENDA | Preço de referência convertido para centavos |
| PRVENDA02 | Preço alternativo somente para visualização |
| CODBAR | Código de barras como string |

Os campos numéricos DBF são lidos do texto original. Quando o DBF já perdeu zeros à esquerda, o leitor não os reconstrói: `1245` e `001245` continuam códigos diferentes, conforme o Sprint 03. Há um aviso quando CODPROD é numérico.

Preços usam aritmética decimal inteira (`BigInt`) e arredondamento de metade para cima quando necessário, com limite de R$ 999.999,99. Exemplos sintéticos: `2.890 → 289` centavos; `1.005 → 101`. Valores vazios não viram zero. Negativos, overflow e formatos inválidos geram diagnóstico por registro. Alternativo vazio é permitido. A comparação continua mostrando os valores originais.

Registros marcados como excluídos são contados e ignorados. Cabeçalho truncado, descritores repetidos, campos obrigatórios ausentes, tamanhos inconsistentes, marcadores inválidos e dados adicionais incompatíveis geram erro. Registros com campos inválidos permanecem inspecionáveis com diagnóstico; códigos/preços inválidos não recebem situação Igual/Sem cartaz.

Codificações: CP850, CP860, CP437, Windows-1252 e UTF-8. O modo automático usa LDID quando conhecido e assume CP850 com aviso explícito quando o cabeçalho não informa a codificação. O usuário pode escolher outra codificação e reprocessar o mesmo buffer local. Não há detecção infalível quando LDID é zero. As tabelas OEM fixas correspondem às páginas de código do Windows/.NET; UTF-8 inválido gera diagnóstico.

## Comparação e conflitos

A comparação reutiliza `findCartazesByF7` do Sprint 03 sobre um índice local agrupado por F7 para evitar uma leitura de disco por produto. Retorna **Igual**, **Alterado**, **Sem cartaz**, **Conflito no DBF** ou **Dados inválidos**. Todos os cartazes associados ao F7 são apresentados, sem consolidar por UUID ou escolher um arquivo preferido.

Registros idênticos nos cinco campos mapeados são agrupados e mantêm a quantidade de ocorrências. A regra de conflito é conservadora: qualquer divergência na descrição, preço de referência original, alternativo ou código de barras para o mesmo F7 cria variantes conflitantes. Isso inclui possíveis aliases de código de barras do mesmo produto: nesta primeira versão, exigem inspeção, mesmo se os preços forem iguais. Frações de centavo divergentes também conflitam, ainda que arredondem para o mesmo centavo. Não há resolução automática de conflito.

## Verificação real executada

Arquivo local **consulta01.dbf**:

- 6.923.159 bytes; dBASE III, LDID 0; 18 campos, cabeçalho 610 bytes e registros de 186 bytes.
- **37.218 registros lidos**, zero excluídos, **28.196 F7 distintos**.
- Zero registros com dados inválidos; zero valores precisaram arredondar frações de centavo nesta amostra.
- **6.146 F7 com variantes conflitantes**, pela regra conservadora descrita acima.
- SHA-256 antes/depois: `db2f8643bd4064af153c39f17c2a34cd2493c76c764329c9ca56140753bc1951` — original intacto.

A leitura foi executada pelo parser completo nos testes, com comparação de cartazes de teste em memória. O fluxo da tela também foi executado no Edge headless: arquivo real, Web Worker real, contagens corretas, paginação de 100 linhas, pesquisa e preservação ao alternar abas, zero comandos de escrita e zero exceções observadas. Apenas o diálogo/IPC Tauri e a biblioteca usados nesse teste de navegador foram simulados. Evidência local em `artifacts/dbf-ui-verification.json` (não versionada).

O DBF real não foi incluído no commit, no frontend, no instalador nem enviado ao GitHub. O teste opcional lê `consulta01.dbf` da raiz somente quando esse arquivo está presente. O CI usa fixtures sintéticas geradas em memória; o teste do arquivo real fica explicitamente ignorado no CI.

## Arquivos criados/modificados

- `src/features/importacao/types.ts`, `dbf.ts`, `oem-codepages.json`, `comparison.ts`, `dbf.worker.ts`, `service.ts` (novos): modelo, leitura, codificações, comparação, Worker e integração IPC.
- `src/components/importacao/PriceImport.tsx` (novo), `src/App.tsx`, `src/styles.css`: aba e tabela de comparação.
- `src-tauri/src/dbf.rs` (novo), `src-tauri/src/lib.rs`: diálogo, leitura binária limitada e testes de acesso somente leitura.
- `tests/dbf.test.ts` (novo), `tests/cartazes.test.tsx`: leitura, centavos, codificações, exclusões, campos vazios, duplicidades/conflitos, comparação e arquivo real opcional.
- `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `scripts/check-config.mjs`, `.github/workflows/windows-exe.yml`: versão 0.4.0 e artefato correspondente.
- `README.md` e este documento: instruções, regras, evidências e limitações.

## Comandos e limites da validação

Executados localmente: `npm.cmd run typecheck`, `npm.cmd test` (**24 testes aprovados**, incluindo o arquivo real), `npm.cmd run build` e `npm.cmd run check:config`. O bundle do Worker foi gerado pelo Vite. Rust/Cargo não estão instalados localmente; os testes Rust e a compilação NSIS são executados pelo workflow Windows. O teste Rust do novo módulo verifica autorização por arquivo, extensão, tamanho máximo e leitura sem alterar o conteúdo.

Workflow: [Compilar instalador Windows](https://github.com/Lucasskalee/altomacao-de-cartaz/actions/workflows/windows-exe.yml). Artefato esperado **Skalee-Cartazes-A5-v0.4.0-Windows-x64**, com `Skalee-Cartazes-A5-0.4.0-windows-x64-setup.exe`, checksum e commit de origem. Confirme o resultado da execução; a configuração não prova sucesso.

Para teste manual no aplicativo instalado: importar o DBF, conferir contagens e acentos, pesquisar um F7 presente na biblioteca, verificar todos os cartazes e seus preços, inspecionar conflitos, cancelar/repetir a seleção e confirmar que os arquivos originais continuam intactos. Repetir com rede desligada. Os diálogos nativos, instalação interativa e impressão física ainda precisam dessa conferência.

Referências técnicas: [formato dBASE](https://www.dbase.com/Knowledgebase/int/db7_file_fmt.htm), [retorno binário oficial do Tauri 2](https://v2.tauri.app/develop/calling-rust/).
