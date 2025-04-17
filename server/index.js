import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import TelegramBot from 'node-telegram-bot-api';

const app = express();
app.use(cors());
app.use(express.json());

// ─── OpenAI ─────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Supabase ───────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// …вместо upsert/status-update:
app.post('/bothelp/webhook', async (req, res) => {
  const { subscriber } = req.body;           // BotHelp-шаблон
  const chatId = subscriber.bothelp_user_id; // или subscriber.id

  // сохраняем запись о попытке оплаты
  await supabase
    .from('payments')
    .insert({ bothelp_user_id: chatId, ts: new Date().toISOString() });

  // сообщаем пользователю, что мы увидели его клик
  await bot.sendMessage(chatId, '✅ Я получил твоё нажатие «Я оплатил». Скоро включу доступ вручную.');

  res.sendStatus(200);
});

// ─── BotHelp Webhook endpoint ───────────────────
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  const text =
    typeof message === 'object' ? message.text || '' : String(message || '');

  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

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

// ─── Telegram API Chat (Polling) ────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
console.log('✅ Telegram polling запущен');

const userStates = new Map();

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('bothelp_user_id', String(chatId))
    .eq('status', 'paid')
    .single();

  if (!user || error) {
    await bot.sendMessage(
      chatId,
      '⛔️ Доступ пока не открыт. Если ты уже оплатил, нажми «Я оплатил» в BotHelp.'
    );
    return;
  }

  userStates.set(chatId, { step: 1 });

  bot.sendMessage(
    chatId,
    '🎯 Ты с союзником. Он здесь, чтобы слушать, понимать и быть рядом каждый день.\n\nНо сначала давай немного познакомимся.\n\n1️⃣ Как ты хочешь, чтобы союзник к тебе обращался?'
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 1) {
    await supabase.from('users').update({ custom_name: text }).eq('bothelp_user_id', String(chatId));
    userStates.set(chatId, { step: 2 });
    bot.sendMessage(chatId, '2️⃣ Кем ты видишь союзника? (друг, наставник, философ, коуч, собеседник)');
    return;
  }

  if (state.step === 2) {
    await supabase.from('users').update({ persona: text }).eq('bothelp_user_id', String(chatId));
    userStates.set(chatId, { step: 3 });
    bot.sendMessage(chatId, '3️⃣ Что сейчас для тебя главное? (работа, отношения, покой, сила, развитие, свобода и т.д.)');
    return;
  }

  if (state.step === 3) {
    await supabase.from('users').update({ priority: text }).eq('bothelp_user_id', String(chatId));
    userStates.delete(chatId);
    bot.sendMessage(chatId, 'Спасибо! Союзник теперь знает тебя лучше. Можешь писать, он уже рядом.');
    return;
  }
});

// ─── Start Server ───────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

