/* Связь страницы с Android: цвет панелей, кнопка «Назад», копирование и сохранение фото */
(function () {
  if (window.__nethgramBridge) return;
  window.__nethgramBridge = true;

  const post = o => {
    try { if (window.NethgramNative) NethgramNative.postMessage(JSON.stringify(o)); } catch (e) {}
  };

  /* Цвет системных панелей = цвет темы */
  let lastColor = '';
  function sendTheme() {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(css) && css !== lastColor) { lastColor = css; post({ type: 'theme', color: css }); }
  }
  // Скрипт запускается очень рано: подписываемся, когда документ уже есть
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    sendTheme();
  });
  window.addEventListener('load', sendTheme);

  /* Сохранение фото: в WebView обычная ссылка download с data: не работает */
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[download]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('data:image/')) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'save', dataUrl: href, name: a.getAttribute('download') || '' });
  }, true);

  /* Копирование текста */
  try {
    const write = text => { post({ type: 'copy', text: String(text) }); return Promise.resolve(); };
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: write, configurable: true });
    else Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
  } catch (e) {}

  /* Нажатие на уведомление: открыть нужный чат (список чатов может ещё загружаться) */
  window.__nethgramOpenChat = function (id, tries) {
    tries = tries || 0;
    try {
      if (typeof contacts !== 'undefined' && contacts.has(id) && typeof myUser !== 'undefined' && myUser) {
        window.__nethgramBackToChats && window.__nethgramBackToChats();
        window.openChat(id);
        return;
      }
    } catch (e) {}
    if (tries < 40) setTimeout(() => window.__nethgramOpenChat(id, tries + 1), 250);
  };
  window.__nethgramBackToChats = function () {
    // закрываем окна поверх чата, но не выходим из приложения
    for (let i = 0; i < 12; i++) {
      if (!document.querySelector('.tgv:not([hidden]),.tg-gift-fx,.mx-modal-ov,.mx-menu,.open[id$="Overlay"],#vlpTrade.open,#vlpSheet.open')) break;
      if (!window.__nethgramBack()) break;
    }
  };

  /* Кнопка «Назад»: закрывает верхнее окно. true — обработано, false — можно свернуть приложение */
  const isOpen = id => { const el = document.getElementById(id); return !!el && el.classList.contains('open'); };
  const call = name => { if (typeof window[name] === 'function') { window[name](); return true; } return false; };
  // от верхних окон к нижним
  const OVERLAYS = [
    ['nftTransferOverlay', 'closeNftTransfer'], ['giftConfirmOverlay', 'closeGiftConfirm'], ['giftViewOverlay', 'closeGiftView'],
    ['cardOverlay', 'closeCardModal'], ['payOverlay', 'closePaymentModal'], ['premOverlay', 'closePremiumModal'],
    ['badgePickerOverlay', 'closeBadgePicker'], ['punModalOverlay', 'closePunModal'], ['giftShopOverlay', 'closeGiftShop'],
    ['chEditOverlay', 'closeChannelEdit'], ['createOverlay', 'closeCreateModal'], ['chMembersOverlay', 'closeMembersOverlay'],
    ['chInfoOverlay', 'closeChannelInfo'], ['contactProfileOverlay', 'closeContactProfile'], ['settingsOverlay', 'closeSettings'],
    ['profileOverlay', 'closeProfile'], ['starsOverlay', 'closeStars'], ['menuOverlay', 'closeMenu'],
  ];
  window.__nethgramBack = function () {
    try {
      const viewer = document.querySelector('.tgv');
      if (viewer && !viewer.hidden && call('tgvClose')) return true;
      const fx = document.querySelector('.tg-gift-fx');
      if (fx) { fx.click(); return true; }
      const modals = document.querySelectorAll('.mx-modal-ov');
      if (modals.length) { modals[modals.length - 1].remove(); return true; }
      if (document.querySelector('.mx-menu') && call('mxCloseMenu')) return true;
      if (isOpen('devConfirmOverlay')) { document.getElementById('devConfirmOverlay').classList.remove('open'); return true; }
      if (isOpen('vlpTrade') && call('closeTrade')) return true;
      if (isOpen('vlpSheet') && call('closeAsset')) return true;
      if (isOpen('vlpOverlay') && call('closeVelosipe')) return true;
      for (const [id, fn] of OVERLAYS) if (isOpen(id) && call(fn)) return true;
      if (isOpen('emojiPicker')) { document.getElementById('emojiPicker').classList.remove('open'); return true; }
      if (isOpen('fabMenu') && call('toggleFabMenu')) return true;
      if (document.getElementById('mxEditBar') && call('mxCancelEdit')) return true;
      if (document.body.classList.contains('mob-chat') && call('mobShowChatList')) return true;
    } catch (e) {}
    return false;
  };
})();
