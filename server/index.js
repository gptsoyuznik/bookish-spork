import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import TelegramBot from 'node-telegram-bot-api';

const app = express();
app.use(cors());
app.use(express.json());

// ─── Инициализация бота с улучшенной обработкой ошибок ──────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false,
  request: { timeout: 5000 }
});

// ─── Улучшенный вебхук Telegram с raw-парсингом ─────────────────
app.post('/telegram-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    console.log('Получен вебхук:', req.body.toString());
    const update = JSON.parse(req.body.toString());
    bot.processUpdate(update);
    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка обработки вебхука:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─── Инициализация Supabase с таймаутами ────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    db: { schema: 'public' },
    global: { fetch: { timeout: 5000 } }
  }
);

// ─── Проверка соединений при старте ────────────────────────────
async function checkConnections() {
  try {
    await bot.getMe();
    console.log('✅ Бот подключен');
    
    const { error } = await supabase.from('users').select('*').limit(1);
    if (error) throw error;
    console.log('✅ Supabase подключен');
  } catch (err) {
    console.error('❌ Ошибка подключения:', err.message);
    process.exit(1);
  }
}

// ─── Улучшенная обработка сообщений с сохранением состояний ─────
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;

    console.log(`Получено сообщение от ${chatId}:`, text);

    if (!text) return;

    // Обработка /start
    if (text === '/start') {
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('bothelp_user_id', String(chatId))
        .single();

      if (error) throw error;

      if (!user) {
        await supabase
          .from('users')
          .upsert([{ 
            bothelp_user_id: String(chatId), 
            status: 'new',
            created_at: new Date().toISOString()
          }]);
      }

      if (!user || user.status !== 'paid') {
        await bot.sendMessage(
          chatId,
          '⛔️ Пока доступ не открыт. Если ты уже оплатил, нажми кнопку «Я оплатил» в BotHelp.'
        );
        return;
      }

      // Очистка предыдущего состояния
      await supabase
        .from('user_states')
        .delete()
        .eq('chat_id', String(chatId));

      // Установка первого шага
      await supabase
        .from('user_states')
        .upsert({ chat_id: String(chatId), step: 1 });

      await bot.sendMessage(
        chatId,
        '🎯 Ты с союзником. Первое знакомство:\n1️⃣ Как хочешь, чтобы союзник к тебе обращался?'
      );
      return;
    }

    // Получение текущего состояния
    const { data: state, error: stateError } = await supabase
      .from('user_states')
      .select('step')
      .eq('chat_id', String(chatId))
      .single();

    if (stateError || !state) return;

    // Обработка шагов
    if (state.step === 1) {
      await supabase
        .from('users')
        .update({ 
          custom_name: text,
          updated_at: new Date().toISOString()
        })
        .eq('bothelp_user_id', String(chatId));

      await supabase
        .from('user_states')
        .update({ step: 2 })
        .eq('chat_id', String(chatId));

      return bot.sendMessage(chatId, '2️⃣ Кем ты видишь союзника?');
    }

    if (state.step === 2) {
      await supabase
        .from('users')
        .update({ 
          persona: text,
          updated_at: new Date().toISOString()
        })
        .eq('bothelp_user_id', String(chatId));

      await supabase
        .from('user_states')
        .update({ step: 3 })
        .eq('chat_id', String(chatId));

      return bot.sendMessage(chatId, '3️⃣ Что для тебя сейчас важно?');
    }

    if (state.step === 3) {
      await supabase
        .from('users')
        .update({ 
          priority: text,
          updated_at: new Date().toISOString(),
          status: 'active'
        })
        .eq('bothelp_user_id', String(chatId));

      await supabase
        .from('user_states')
        .delete()
        .eq('chat_id', String(chatId));

      return bot.sendMessage(
        chatId,
        '💡 Спасибо! Союзник теперь знает тебя лучше. Можешь писать что угодно.'
      );
    }
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
  }
});

// ─── Улучшенный обработчик BotHelp ──────────────────────────────
app.post('/bothelp/webhook', async (req, res) => {
  try {
    console.log('Получен запрос от BotHelp:', req.body);
    
    const { subscriber } = req.body;
    const chatId = subscriber?.bothelp_user_id || subscriber?.id;

    if (!chatId || isNaN(Number(chatId))) {
      console.error('Неверный chat_id:', chatId);
      return res.status(400).json({ error: 'Invalid chat_id' });
    }

    const { error: userError } = await supabase
      .from('users')
      .upsert({ 
        bothelp_user_id: String(chatId), 
        status: 'paid',
        payment_date: new Date().toISOString()
      });

    if (userError) throw userError;

    const { error: paymentError } = await supabase
      .from('payments')
      .insert({ 
        bothelp_user_id: String(chatId), 
        ts: new Date().toISOString(),
        amount: subscriber?.amount || 0
      });

    if (paymentError) throw paymentError;

    await bot.sendMessage(
      chatId, 
      '✅ Я получил твоё нажатие «Я оплатил». Доступ открыт — пиши /start.'
    );
    
    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка обработки BotHelp:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Быстрый Fast Chat с улучшенной обработкой ошибок ──────────
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const text = typeof message === 'object' 
      ? message.text || '' 
      : String(message || '');

    if (!text.trim()) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: text }],
      timeout: 10000
    });

    return res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ 
      error: 'Ошибка на сервере',
      details: err.message
    });
  }
});

// ─── Эндпоинты для мониторинга ─────────────────────────────────
app.get('/status', async (req, res) => {
  try {
    const botStatus = await bot.getMe();
    const { data: userCount } = await supabase
      .from('users')
      .select('*', { count: 'exact' });

    res.json({
      status: 'operational',
      bot: botStatus ? 'connected' : 'disconnected',
      supabase: userCount !== null ? 'connected' : 'disconnected',
      users: userCount || 0,
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({ status: 'degraded', error: err.message });
  }
});

app.get('/debug', async (req, res) => {
  res.json({
    env: {
      TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY
    }
  });
});

// ─── Запуск сервера с проверкой подключений ────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  await checkConnections();
});
