# Skalee Cartazes A5 (MVP v0.1.0)

Editor desktop para cartazes promocionais em A5 vertical, baseado no layout de referência do usuário.

## Requisitos Windows
- Node.js 20+
- Rust (rustup, toolchain MSVC)
- Microsoft C++ Build Tools (Desktop development with C++)
- WebView2 (normalmente presente no Windows 11)

## Rodar interface (sem Rust)
```powershell
npm install
npm run dev
```
Abra http://127.0.0.1:1420.

## Rodar aplicativo desktop
```powershell
npm run tauri dev
```

## Gerar instalador Windows (.exe NSIS)
```powershell
npm run tauri build
```
Saída esperada: `src-tauri/target/release/bundle/nsis/` (instalador .exe). O build MSI também pode exigir componentes adicionais do Windows.

## Funcionalidades atuais
- Nome, complemento, preço e unidade
- Prévia A5
- Impressão A5 pelo diálogo do sistema
- Exportação PNG 1748 × 2480 (aprox. 300 DPI)
- Lista local temporária de cartazes (sem impressão em lote ainda)

## Limitações conhecidas
- A tipografia reproduz aproximadamente o cartaz original; fontes exatas do PSD não foram fornecidas.
- A impressão exige confirmar o papel e margens no driver. Faça um teste de régua em papel.
- O PNG tem resolução A5 ~300 DPI, mas não incorpora necessariamente metadados físicos de DPI.
- A lista de cartazes não persiste após fechar o aplicativo.
- Impressão em lote, Excel/F7, PDF e editor de modelos são etapas futuras.
- Para nomes muito extensos, o layout pode precisar de ajuste de tamanho automático.

## Compilar pelo GitHub Actions (sem instalar Rust no computador)
Envie o conteúdo da pasta para um repositório GitHub (branch `main`).
Na aba **Actions**, selecione **Compilar instalador Windows** e clique **Run workflow**.
Após o workflow terminar com sucesso, baixe o artefato **Skalee-Cartazes-A5-Windows-EXE**.
O arquivo `.exe` fica dentro do ZIP do artefato.
