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
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/^\/start(?:\s+paid)?$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Привет! Я GPT‑СОЮЗНИК. Напиши любой вопрос – отвечу мгновенно.'
  );
});

bot.onText(/^\/upgrade$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Нажми, чтобы вернуться к тарифам 👇',
    {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Изменить тариф',
          url: 'https://t.me/<ТВОЙ_BOTHELP_BOT>?start=upgrade'
        }]]
      }
    }
  );
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;   // команды не трогаем
  try {
    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: msg.text }]
    });
    bot.sendMessage(msg.chat.id, gpt.choices[0].message.content);
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, 'Упс, что‑то сломалось. Попробуй позже.');
  }
});

/* ───── Telegram fast chat ───── */
import TelegramBot from 'node-telegram-bot-api';
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/^\/start(?:\s+paid)?$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Привет! Я GPT‑СОЮЗНИК. Напиши любой вопрос – отвечу мгновенно.'
  );
});

bot.onText(/^\/upgrade$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Нажми, чтобы вернуться к тарифам 👇',
    {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Изменить тариф',
          url: 'https://t.me/<ТВОЙ_BOTHELP_BOT>?start=upgrade'
        }]]
      }
    }
  );
});

// обычные сообщения → GPT
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;   // игнорируем команды
  try {
    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: msg.text }]
    });
    bot.sendMessage(msg.chat.id, gpt.choices[0].message.content);
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, 'Упс, что‑то сломалось. Попробуй позже.');
  }
});

