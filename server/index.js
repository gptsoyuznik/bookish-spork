import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';

// Полифилл для fetch
globalThis.fetch = fetch;

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация бота с таймаутами
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false,
  request: { timeout: 10000 }
});

// Инициализация Supabase с полифиллом fetch
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: { fetch }
  }
);

// Проверка соединений при старте
async function checkConnections() {
  try {
    const botInfo = await bot.getMe();
    console.log('✅ Бот подключен:', botInfo.username);

    const { error } = await supabase
      .from('users')
      .select('*')
      .limit(1);
      
    if (error) throw error;
    console.log('✅ Supabase подключен');
  } catch (err) {
    console.error('❌ Ошибка подключения:', err.message);
    process.exit(1);
  }
}

// Обработка вебхука Telegram
app.post('/telegram-webhook', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty request body' });
    }

    let update;
    try {
      const rawBody = req.body.toString('utf8');
      console.log('Raw webhook body:', rawBody);
      update = JSON.parse(rawBody);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (!update.update_id) {
      console.error('Invalid Telegram update:', update);
      return res.status(400).json({ error: 'Invalid Telegram update format' });
    }

    await bot.processUpdate(update);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Обработчик сообщений
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    console.log(`Message from ${chatId}: ${text}`);

    // Находим юзера по bothelp_user_id (chatId)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, status')
      .eq('bothelp_user_id', String(chatId))
      .single();

    if (userError || !user) {
      console.error('User fetch error:', userError);
      await bot.sendMessage(
        chatId,
        '⛔ Ошибка: пользователь не найден. Пожалуйста, начните заново.'
      );
      return;
    }

    // Обработка команды /start
    if (text === '/start') {
      if (user.status !== 'paid') {
        await bot.sendMessage(
          chatId,
          '⛔ Доступ закрыт. После оплаты нажмите «Я оплатил» в BotHelp.'
        );
        return;
      }

      await supabase
        .from('user_states')
        .upsert({ user_id: user.id, step: 1 });

      await bot.sendMessage(
        chatId,
        '🎯 Добро пожаловать!\n1️⃣ Как мне к вам обращаться?'
      );
      return;
    }

    // Получение текущего шага
    const { data: state, error: stateError } = await supabase
      .from('user_states')
      .select('step')
      .eq('user_id', user.id)
      .single();

    if (stateError) {
      console.error('State fetch error:', stateError);
      return;
    }

    if (!state) return;

    // Обработка шагов
    switch (state.step) {
      case 1:
        await supabase
          .from('users')
          .update({ custom_name: text })
          .eq('bothelp_user_id', String(chatId));

        await supabase
          .from('user_states')
          .update({ step: 2 })
          .eq('user_id', user.id);

        return bot.sendMessage(chatId, '2️⃣ Кто для вас союзник?');
      
      case 2:
        await supabase
          .from('users')
          .update({ persona: text })
          .eq('bothelp_user_id', String(chatId));

        await supabase
          .from('user_states')
          .update({ step: 3 })
          .eq('user_id', user.id);

        return bot.sendMessage(chatId, '3️⃣ Что для вас сейчас важно?');
      
      case 3:
        await supabase
          .from('users')
          .update({ 
            priority: text,
            status: 'active'
          })
          .eq('bothelp_user_id', String(chatId));

        await supabase
          .from('user_states')
          .delete()
          .eq('user_id', user.id);

        return bot.sendMessage(
          chatId,
          '💡 Отлично! Теперь я вас знаю. Можете задавать любые вопросы.\nПерейдите в чат: @GPTSoyuznikChatBot и напишите /start.'
        );
    }
  } catch (err) {
    console.error('Message processing error:', err);
  }
});

// Обработчик BotHelp для регистрации юзера
app.post('/bothelp/register', async (req, res) => {
  try {
    console.log('Received /bothelp/register body:', req.body);
    const { bothelp_user_id, id, user_id } = req.body;
    const userId = bothelp_user_id || id;

    if (!userId) {
      console.error('Missing user ID in /bothelp/register:', req.body);
      return res.status(400).json({ error: 'Missing user ID' });
    }

    console.log('Saving user with telegram_chat_id:', user_id || userId);

    await supabase
      .from('users')
      .upsert([{ 
        bothelp_user_id: String(userId),
        telegram_chat_id: String(user_id || userId),
        status: 'new',
        created_at: new Date().toISOString()
      }]);

    console.log(`User created with bothelp_user_id: ${userId}, telegram_chat_id: ${user_id || userId}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Обработчик BotHelp для оплаты
app.post('/bothelp/webhook', async (req, res) => {
  try {
    console.log('BotHelp Webhook Triggered:', req.body);
    const { bothelp_user_id, id } = req.body;
    const userId = bothelp_user_id || id;

    if (!userId) {
      console.error('Missing user ID in /bothelp/webhook:', req.body);
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const { error: userError } = await supabase
      .from('users')
      .upsert(
        {
          bothelp_user_id: String(userId),
          status: 'pending',
          payment_date: new Date().toISOString()
        },
        {
          onConflict: 'bothelp_user_id'
        }
      );

    if (userError) throw userError;

    const { error: paymentError } = await supabase
      .from('payments')
      .insert({
        bothelp_user_id: String(userId),
        ts: new Date().toISOString()
      });

    if (paymentError) throw paymentError;

    console.log(`Payment recorded for bothelp_user_id: ${userId}, status: pending`);
    res.sendStatus(200);
  } catch (err) {
    console.error('BotHelp Webhook Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Обработчик BotHelp для смены статуса на paid и отправки уведомления
app.post('/bothelp/update-status', async (req, res) => {
  try {
    console.log('Update status request:', req.body);
    const { bothelp_user_id, telegram_chat_id, status } = req.body;

    if (!bothelp_user_id || !telegram_chat_id || !status) {
      console.error('Missing fields in /bothelp/update-status:', req.body);
      return res.status(400).json({ error: 'Missing bothelp_user_id, telegram_chat_id, or status' });
    }

    const { error: userError } = await supabase
      .from('users')
      .upsert(
        {
          bothelp_user_id: String(bothelp_user_id),
          telegram_chat_id: String(telegram_chat_id),
          status: status,
          payment_date: new Date().toISOString()
        },
        {
          onConflict: 'bothelp_user_id'
        }
      );

    if (userError) throw userError;

    if (status === 'paid') {
      await bot.sendMessage(
        telegram_chat_id,
        'Доступ к GPT-чату открыт! Перейдите в чат: @GPTSoyuznikChatBot и напишите /start. Чтобы вернуться к меню, используйте /start в этом чате.\nhttps://t.me/GPTSoyuznikChatBot'
      );
    }

    console.log(`Status updated for bothelp_user_id: ${bothelp_user_id} to ${status}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fast Chat API
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const text = message?.text || String(message || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'Empty message' });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      fetch
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: text }],
      max_tokens: 500
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('OpenAI error:', err);
    res.status(500).json({ error: 'AI service unavailable' });
  }
});

// Health Check Endpoints
app.get('/status', async (req, res) => {
  try {
    const [botInfo, dbStatus] = await Promise.all([
      bot.getMe(),
      supabase.from('users').select('*', { count: 'exact' })
    ]);

    res.json({
      status: 'OK',
      bot: botInfo ? 'connected' : 'disconnected',
      database: dbStatus.data ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await checkConnections();
});
