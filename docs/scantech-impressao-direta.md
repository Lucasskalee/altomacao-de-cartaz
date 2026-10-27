# Impressão direta de cartazes Scantech

## Funcionamento

A aba `Criar Cartaz Scantech` reutiliza o mesmo fluxo de impressão A5 do editor e de `Pastas de Ofertas`:

1. A arte PSD importada é usada como base pela prévia em canvas.
2. O preço `POR` da planilha e a validade resolvida (individual ou global) são aplicados na composição.
3. O usuário revisa a prévia e pode imprimir um produto ou os produtos selecionados.
4. A quantidade de cópias é definida por produto; a impressão em lote gera uma página A5 por cópia.
5. O `window.print()` do aplicativo abre o diálogo normal da impressora. A recomendação é A5, retrato, escala 100%, margens nenhuma e cabeçalhos/rodapés desativados.

## Segurança

A impressão direta não abre nem consulta o Photoshop e não escreve nos PSDs de origem. Produtos com F7, preço, validade, camadas obrigatórias ou arte PSD ausentes são bloqueados. Alertas de largura podem ser aprovados visualmente; erros reais de dados, inversão de camadas ou arte cortada continuam bloqueando.

## Limitações

- A composição impressa é renderizada pelo canvas do aplicativo; ela não gera um novo PSD editável.
- A fidelidade depende das fontes instaladas/disponíveis no navegador e do driver da impressora.
- A impressão física pode variar por margens não imprimíveis, calibração de cor e escala do driver.
- A exportação PSD pelo Photoshop continua disponível separadamente e não é necessária para imprimir.

## Verificação

O fluxo usa `PosterView` e `drawImported`, portanto preserva o background, cores, sombras, fontes, validade e ajustes de largura já usados na prévia. A suíte de testes também cobre preços de um, dois e três dígitos e a aplicação de validade da planilha. Os testes de automação real do Photoshop permanecem independentes deste fluxo.
