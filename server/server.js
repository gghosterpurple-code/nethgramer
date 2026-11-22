/**
 * NETHGRAM — точка входа (запуск: node server.js).
 * Сначала загружает данные из PostgreSQL (если задан DATABASE_URL), потом стартует сервер из app.js.
 */
const storage = require('./storage');

storage.loadAll()
  .then(data => { global.__NETHGRAM_DATA = data; require('./app.js'); })
  .catch(e => {
    // Не стартуем с пустым состоянием: иначе первое же сохранение затёрло бы базу.
    console.error('\n❌ Не удалось загрузить данные из базы:', e.message);
    console.error('   Проверь переменную DATABASE_URL и что база доступна. Сервер остановлен.\n');
    process.exit(1);
  });
