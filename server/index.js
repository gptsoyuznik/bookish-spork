import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import TelegramBot from 'node-telegram-bot-api';

const app = express();
app.use(cors());
app.use(express.json());

// ─── Webhook Telegram ──────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });


app.post('/telegram-webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ─── Инициализация OpenAI и Supabase ────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── Хранилище состояния пользователя ──────────────
const userStates = new Map();

// ─── Обработка сообщений Telegram ───────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // ⛳️ Первый вход: /start
  if (text === '/start') {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('bothelp_user_id', String(chatId))
      .single();

    if (!user || error) {
      await supabase
        .from('users')
        .upsert([{ bothelp_user_id: String(chatId), status: 'new' }]);

      await bot.sendMessage(
        chatId,
        '⛔️ Пока доступ не открыт. Если ты уже оплатил, нажми кнопку «Я оплатил» в BotHelp.'
      );
      return;
    }

    if (user.status !== 'paid') {
      await bot.sendMessage(
        chatId,
        '⛔️ Пока доступ не открыт. Если ты уже оплатил, нажми кнопку «Я оплатил» в BotHelp.'
      );
      return;
    }

    userStates.set(chatId, { step: 1 });
    await bot.sendMessage(
      chatId,
      '🎯 Ты с союзником. Первое знакомство:\n1️⃣ Как хочешь, чтобы союзник к тебе обращался?'
    );
    return;
  }

  // 🤖 Дальнейшие шаги — если пользователь активен
  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 1) {
    await supabase
      .from('users')
      .update({ custom_name: text })
      .eq('bothelp_user_id', String(chatId));
    userStates.set(chatId, { step: 2 });
    return bot.sendMessage(chatId, '2️⃣ Кем ты видишь союзника?');
  }

  if (state.step === 2) {
    await supabase
      .from('users')
      .update({ persona: text })
      .eq('bothelp_user_id', String(chatId));
    userStates.set(chatId, { step: 3 });
    return bot.sendMessage(chatId, '3️⃣ Что для тебя сейчас важно?');
  }

  if (state.step === 3) {
    await supabase
      .from('users')
      .update({ priority: text })
      .eq('bothelp_user_id', String(chatId));
    userStates.delete(chatId);
    return bot.sendMessage(
      chatId,
      '💡 Спасибо! Союзник теперь знает тебя лучше. Можешь писать что угодно.'
    );
  }
});

// ─── Кнопка "Я оплатил" из BotHelp ─────────────────
app.post('/bothelp/webhook', async (req, res) => {
  const { subscriber } = req.body;
  const chatId = subscriber?.bothelp_user_id || subscriber?.id;

  if (!chatId) {
    res.sendStatus(400);
    return;
  }

  await supabase
    .from('users')
    .upsert([{ bothelp_user_id: String(chatId), status: 'paid' }]);

  await supabase
    .from('payments')
    .insert({ bothelp_user_id: String(chatId), ts: new Date().toISOString() });

  await bot.sendMessage(chatId, '✅ Я получил твоё нажатие «Я оплатил». Доступ открыт — пиши /start.');
  res.sendStatus(200);
});

// ─── Быстрый Fast Chat (для формы в BotHelp) ───────
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  const text =
    typeof message === 'object' ? message.text || '' : String(message || '');

  if (!text) {
    return res.status(400).json({ error: 'Пустое сообщение' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: text }],
    });
    return res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: 'Ошибка на сервере' });
  }
});

// ─── Старт сервера ────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
