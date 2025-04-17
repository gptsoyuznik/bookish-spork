import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── /chat ───────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  // BotHelp шлёт объект message; если это строка — берём как есть
  const { message } = req.body;
  const text =
    typeof message === 'object'
      ? message.text || ''   // вытаскиваем поле text из объекта
      : String(message || '');

  if (!text) {
    return res.status(400).json({ error: 'Пустое сообщение' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: text }],
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('OpenAI error:', err);
    res.status(500).json({ error: 'Ошибка на сервере' });
  }
});

// ─── server start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

import TelegramBot from 'node-telegram-bot-api';

// Инициализация Telegram бота
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Сообщения от пользователя в Telegram
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  try {
    // Запрос в GPT-4o
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: userMessage }],
    });

    const reply = response.choices[0].message.content;

    // Ответ обратно в Telegram
    await bot.sendMessage(chatId, reply);
  } catch (error) {
    console.error('Ошибка:', error);
    bot.sendMessage(chatId, 'Сорри, что-то пошло не так.');
  }
});

