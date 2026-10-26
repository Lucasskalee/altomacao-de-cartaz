# Sprint 04.1 — Confirmação e salvamento de preços · v0.4.1

## Fluxo

1. Importe o DBF e compare com a biblioteca, como no Sprint 04.0.
2. Selecione cada documento desejado ou use **Selecionar todas as alterações válidas**. A seleção abrange todas as páginas, identifica o arquivo por **UUID + caminho** e pode ser desmarcada individualmente. Não inclui iguais, produtos sem cartaz, registros inválidos, F7 conflitantes nem documentos abertos com edição não salva.
3. Clique **Aplicar preços selecionados**. O backend reabre e valida os arquivos antes de preparar uma revisão; nada é gravado nessa etapa.
4. Confira quantidade, nome/F7/caminho, preço anterior/novo e número de F7 conflitantes ignorados. Marque **Revisei os preços e autorizo a gravação destes cartazes** e clique **Confirmar e salvar**. Cancelar descarta a revisão sem gravar arquivos.
5. Confira o resultado de cada arquivo. A biblioteca, a comparação e o cartaz aberto sem edição pendente são recarregados. Um cartaz com edição não salva não é substituído; seu conteúdo continua no editor.
6. Em **Histórico local e restauração**, escolha **Restaurar preço anterior…**, revise a inversão de preços e confirme novamente. Não é necessário reimportar o DBF para restaurar.

Não há criação automática de cartazes. O arquivo DBF não é modificado. O formato `.skcartaz` continua no esquema 1, compatível com as versões anteriores.

## Gravação e concorrência

O índice da biblioteca mantém o conteúdo original do arquivo, além do documento interpretado. Cada proposta contém esse snapshot, UUID, F7, caminho e preço esperado. Um plano de revisão imutável fica apenas na memória do backend e expira após dez minutos; só pode ser consumido uma vez. Limites por lote: 500 documentos e 16 MB de snapshots. Divida seleções maiores em lotes.

No preparo e novamente ao aplicar, o backend exige arquivo existente dentro da biblioteca, formato válido, UUID/F7/preço correspondentes e **conteúdo exato igual** ao observado na comparação. A guarda do editor é consultada novamente ao confirmar. Uma edição pendente invalida o plano antes da primeira gravação. F7 conflitante e preços iguais são recusados também no backend.

Para cada arquivo confirmado:

1. Reabre e valida o original e as datas do documento.
2. Cria backup exclusivo do conteúdo original e sincroniza a escrita.
3. Persiste um diário **prepared** antes de tocar no cartaz.
4. Revalida o arquivo imediatamente antes da substituição.
5. Altera somente `product.priceCents` e `metadata.updatedAt` em UTC. Campos desconhecidos, números JSON grandes, UUID, layout, produto, código, unidade e datas de criação são preservados.
6. Usa a escrita temporária/sincronizada e substituição segura já existente no projeto.
7. Reabre o arquivo, valida o documento e confere o conteúdo salvo.
8. Persiste o resultado individual.

Uma falha interrompe o lote. Arquivos já concluídos permanecem atualizados, com backup; os seguintes recebem resultado **Não executado**. O lote não é uma transação única de vários arquivos. Falhas de histórico são exibidas, nunca escondidas. Se não puder criar backup/diário, o original não é alterado. Se a verificação após gravar falhar, o resultado exige recuperação e mantém o backup.

As operações de preços são serializadas no backend da instância atual. As verificações de snapshot detectam mudanças externas anteriores às leituras de validação. Não existe bloqueio compartilhado com editores externos: evite editar o mesmo arquivo em outro programa durante a aplicação, especialmente no intervalo muito curto entre a última validação e a substituição.

## Histórico, backups e recuperação

O diretório privado do aplicativo retornado por `app_local_data_dir()` contém `price-updates/<id-da-operação>/record.json` e `before.skcartaz.bak` (normalmente sob `%LOCALAPPDATA%/dev.skalee.cartazes/`). Esses backups não entram em Meus Cartazes. O caminho aparece no histórico para recuperação manual.

Cada registro contém data/hora, nome do DBF, nome/F7 do produto, UUID/caminho do cartaz, preço anterior/novo, ação, resultado, mensagem e fingerprints SHA-256. Só são registrados os cartazes selecionados que participaram da operação, inclusive falhas/não executados; os demais produtos do DBF não entram no histórico. Não há conteúdo do DBF salvo no histórico.

O histórico é relido do disco após reabrir o aplicativo. Um diário **prepared** deixado por interrupção é mostrado para conferência/recuperação; não é reaplicado automaticamente. Backup ausente/corrompido gera aviso e bloqueia restauração.

A restauração verifica a integridade do backup e exige que o cartaz atual ainda corresponda ao conteúdo produzido pela atualização, inclusive UUID, F7 e preço. Se houve edição posterior, ela é bloqueada para não perder mudanças. O preço anterior é extraído do backup; só o preço e a nova data de modificação são gravados. A própria restauração cria novo backup e registro. Backups não são apagados automaticamente; preserve a pasta privada do aplicativo.

## Arquivos criados/modificados

- `src-tauri/src/price_updates.rs` e `price_updates_tests.rs` (novos): planos, validação, histórico/backup, aplicação, restauração e testes em disco.
- `src-tauri/src/storage.rs`: reaproveitamento interno de leitura/validação/escrita/escopo.
- `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`: comandos, estado e dependências SHA-256, UUID e datas; JSON com preservação de ordem/precisão.
- `src/features/importacao/updates.ts` (novo), `types.ts`, `comparison.ts`, `src/features/cartazes/f7.ts`: elegibilidade, seleção por documento, snapshot e serviços IPC.
- `src/components/importacao/PriceConfirmation.tsx`, `PriceHistory.tsx` (novos), `PriceImport.tsx`: revisão explícita, resultados, histórico e restauração.
- `src/hooks/useCartaz.ts`, `src/App.tsx`: guarda de edição e recarga somente de cartazes limpos afetados.
- `src/styles.css`: apresentação da seleção, confirmação e histórico.
- `tests/updates.test.tsx` (novo), `tests/cartazes.test.tsx`: regressões e cobertura frontend.
- Manifests/lock npm, configuração Tauri, script de conferência e workflow: versão 0.4.1.
- `README.md` e este documento: operação e limites.

Ajustes de fonte já presentes na área de trabalho antes deste sprint foram preservados e mantidos fora do commit de preços. O DBF real continua fora do repositório e do instalador.

## Validação

Localmente passaram TypeScript, **30 testes frontend**, build Vite e conferência da configuração. Os testes incluem um DBF de milhares de produtos com apenas um cartaz selecionável, seleção por UUID/caminho, bloqueio de conflitos/iguais/sem cartaz/edição pendente, snapshot, revisão com checkbox obrigatório e comandos separados de preparo/confirmação com rede desativada no teste.

O fluxo da interface foi verificado no Edge headless com **5.001 registros**, Worker real e **IPC simulado**: selecionar dois cartazes, desmarcar um, cancelar sem aplicar, confirmar explicitamente um único arquivo, recarregar a prévia limpa, restaurar, bloquear um cartaz com edição não salva e atualizar outro sem perder a edição pendente. Evidência local não versionada: `artifacts/price-update-ui-verification.json`. Esse teste não comprova gravação nativa.

Rust/Cargo não estão instalados localmente. O workflow Windows executa os testes nativos, que usam **arquivos `.skcartaz` reais em diretórios temporários**, não mocks de filesystem. Cobrem atualização/reabertura em nova instância, restauração após confirmação, campos adicionais/números grandes, conflito/igualdade/edição pendente, mudanças externas antes/depois da revisão, interrupção do lote, falha de diário, falha real de substituição de arquivo somente leitura no Windows com backup preservado, backup corrompido, recuperação de diário interrompido e UUID repetido em caminhos distintos. Consulte a execução para confirmar os resultados, sem inferir sucesso apenas pela configuração.

Workflow: [Compilar instalador Windows](https://github.com/Lucasskalee/altomacao-de-cartaz/actions/workflows/windows-exe.yml). Artefato esperado: **Skalee-Cartazes-A5-v0.4.1-Windows-x64**, com `Skalee-Cartazes-A5-0.4.1-windows-x64-setup.exe`, checksum e commit de origem. A leitura real do `consulta01.dbf` é testada apenas quando o arquivo está presente localmente; no CI, esse teste é explicitamente ignorado.

Impressão A5 e PNG mantêm os testes de regressão existentes. Instalação interativa, diálogos nativos e impressão física continuam precisando de conferência manual no instalador. Faça o primeiro teste com cópias de cartazes, revise a seleção, confirme os preços após fechar/reabrir e teste uma restauração.
