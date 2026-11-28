import { useEffect } from 'react';

type ShortcutGroup = {
  title: string;
  items: { keys: string[]; description: string }[];
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Editor de Cartazes',
    items: [
      { keys: ['Alt', 'P'], description: 'Imprimir o cartaz atual (ou selecionados na aba ativa)' },
      { keys: ['Ctrl', 'S'], description: 'Salvar alterações no cartaz atual' },
      { keys: ['G'], description: 'Ativar ou ocultar a grade de alinhamento na prévia' },
      { keys: ['Alt', '→'], description: 'Salvar e ir para o próximo item na edição em lote' },
      { keys: ['Alt', '←'], description: 'Voltar ao item anterior na edição em lote' },
    ],
  },
  {
    title: 'Ajuste Fino no Canvas (Números e Textos)',
    items: [
      { keys: ['Clique'], description: 'Selecionar número, centavos, vírgula ou texto direto na arte' },
      { keys: ['Arrastar'], description: 'Mover a camada selecionada livremente; alça inferior direita redimensiona' },
      { keys: ['↑', '↓', '←', '→'], description: 'Mover camada selecionada em 2 px' },
      { keys: ['Shift', 'Setas'], description: 'Mover camada selecionada em 10 px' },
      { keys: ['+', '-'], description: 'Aumentar ou diminuir escala da camada selecionada (±5%)' },
      { keys: ['Delete'], description: 'Restaurar posição e escala original da camada selecionada' },
    ],
  },
  {
    title: 'Pastas de Oferta & Biblioteca',
    items: [
      { keys: ['Arrastar'], description: 'Desenhar caixa azul para selecionar múltiplos cartazes (Ctrl/Shift soma)' },
      { keys: ['Shift', 'Clique'], description: 'Selecionar intervalo contínuo de produtos na Pasta de Ofertas' },
      { keys: ['Alt', 'P'], description: 'Imprimir os produtos selecionados na Pasta de Ofertas' },
      { keys: ['Delete'], description: 'Excluir permanentemente cartazes selecionados na Biblioteca ou remover da Pasta de Ofertas (com confirmação)' },
      { keys: ['↑', '↓'], description: 'Navegar pelos cartazes e atualizar a prévia lateral' },
    ],
  },
  {
    title: 'Geral',
    items: [
      { keys: ['?'], description: 'Abrir ou fechar este guia de atalhos de teclado' },
      { keys: ['Esc'], description: 'Fechar modais ou desmarcar camada ativa no canvas' },
    ],
  },
];

export function ShortcutsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="panel modal sk-lib-modal sk-shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Atalhos de teclado do operador"
      >
        <div className="sk-shortcuts-header">
          <div>
            <h2 className="sk-confirm-title">Atalhos de Teclado</h2>
            <p className="sk-confirm-description" style={{ marginBottom: 0 }}>
              Comandos rápidos para agilizar o dia a dia de edição e impressão.
            </p>
          </div>
          <button
            type="button"
            className="editor-btn subtle"
            onClick={onClose}
            aria-label="Fechar guia de atalhos"
          >
            Fechar
          </button>
        </div>

        <div className="sk-shortcuts-grid">
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title} className="sk-shortcut-group">
              <h3>{group.title}</h3>
              <dl className="sk-shortcut-list">
                {group.items.map((item, index) => (
                  <div key={index} className="sk-shortcut-row">
                    <dt className="sk-shortcut-keys">
                      {item.keys.map((keyLabel, kIdx) => (
                        <span key={kIdx} className="sk-shortcut-key-wrap">
                          {kIdx > 0 && <span className="sk-shortcut-plus">+</span>}
                          <kbd className="sk-kbd">{keyLabel}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd className="sk-shortcut-desc">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
