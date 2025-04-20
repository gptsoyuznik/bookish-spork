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

// Инициализация второго бота
const bot = new TelegramBot(process.env.CHATBOT_TOKEN, {
  polling: false,
  request: { timeout: 10000 }
});

// Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: { fetch }
  }
);

// Проверка соединений
async function checkConnections() {
  try {
    const botInfo = await bot.getMe();
    console.log('✅ Чат-бот подключен:', botInfo.username);
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

// Обработка вебхука Telegram для второго бота
app.post('/chatbot-webhook', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}), async (req, res) => {
  try {
    // Проверяем наличие заголовков и тела запроса
    console.log('Webhook headers:', req.headers);
    if (!req.body || req.body.length === 0) {
      console.error('Empty webhook body received');
      return res.status(400).json({ error: 'Empty request body' });
    }

    let update;
    const rawBody = req.body.toString('utf8');
    console.log('Raw chatbot webhook body:', rawBody);

    // Проверяем, что тело — валидный JSON
    if (!rawBody || rawBody.trim() === '' || rawBody === ']' || !rawBody.startsWith('{') && !rawBody.startsWith('[')) {
      console.error('Invalid webhook body: not a valid JSON', rawBody);
      return res.status(400).json({ error: 'Invalid JSON format' });
    }

    try {
      update = JSON.parse(rawBody);
    } catch (parseError) {
      console.error('JSON parse error:', parseError, 'Raw body:', rawBody);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (!update.update_id) {
      console.error('Invalid Telegram update:', update);
      return res.status(400).json({ error: 'Invalid Telegram update format' });
    }

    await bot.processUpdate(update);
    res.sendStatus(200);
  } catch (err) {
    console.error('Chatbot webhook processing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Обработчик сообщений для второго бота
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    console.log(`Chatbot message from ${chatId}: ${text || 'Non-text message'}`);

    // Проверка статуса paid для начала GPT-чата
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_chat_id', String(chatId))
      .single();

    if (error || !user || user.status !== 'paid') {
      await bot.sendMessage(
        chatId,
        '⛔ Доступ закрыт. Пожалуйста, вернитесь в основной чат @gpt_soyuznik_bot для оплаты.'
      );
      return;
    }

    // Если юзер уже в процессе диалога
    const { data: state } = await supabase
      .from('user_states')
      .select('step')
      .eq('chat_id', String(chatId))
      .single();

    // Обработка фото
    if (msg.photo) {
      // Получаем файл самого высокого качества (последний элемент массива msg.photo)
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;

      // Получаем URL файла через Telegram API
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.CHATBOT_TOKEN}/${file.file_path}`;

      // Отправляем фото в OpenAI GPT-4 для анализа
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        fetch
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Опиши это изображение.' },
              { type: 'image_url', image_url: { url: fileUrl } }
            ]
          }
        ],
        max_tokens: 500
      });

      const description = response.choices[0].message.content;
      await bot.sendMessage(chatId, `Описание изображения: ${description}`);
      return;
    }

    // Обработка текстовых сообщений
    if (!text) return;
    console.log(`Chatbot message from ${chatId}: ${text}`);

    if (!state) {
      // Начало диалога
      await supabase
        .from('user_states')
        .upsert({ chat_id: String(chatId), step: 1 });
      await bot.sendMessage(
        chatId,
        '🎯 Добро пожаловать!\n1️⃣ Как мне к вам обращаться?'
      );
      return;
    }

    switch (state.step) {
      case 1:
        await supabase
          .from('users')
          .update({ custom_name: text })
          .eq('telegram_chat_id', String(chatId));
        await supabase
          .from('user_states')
          .update({ step: 2 })
          .eq('chat_id', String(chatId));
        return bot.sendMessage(chatId, '2️⃣ Кто для вас союзник?');
      
      case 2:
        await supabase
          .from('users')
          .update({ persona: text })
          .eq('telegram_chat_id', String(chatId));
        await supabase
          .from('user_states')
          .update({ step: 3 })
          .eq('chat_id', String(chatId));
        return bot.sendMessage(chatId, '3️⃣ Что для вас сейчас важно?');
      
      case 3:
        await supabase
          .from('users')
          .update({ 
            priority: text,
            status: 'active',
            chat_started_at: new Date().toISOString()
          })
          .eq('telegram_chat_id', String(chatId));
        await supabase
          .from('user_states')
          .delete()
          .eq('chat_id', String(chatId));
        return bot.sendMessage(
          chatId,
          '💡 Отлично! Теперь я вас знаю. Можете задавать любые вопросы, и я помогу!'
        );
      
      default:
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          fetch
        });
        const response = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: text }],
          max_tokens: 500
        });
        await bot.sendMessage(chatId, response.choices[0].message.content);
    }
  } catch (err) {
    console.error('Chatbot message processing error:', err);
  }
});

// Запуск сервера для второго бота
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Chatbot server running on port ${PORT}`);
  await checkConnections();
});
