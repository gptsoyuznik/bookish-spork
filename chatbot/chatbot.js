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

// Кэш для хранения текущей сессии
const chatHistoryCache = new Map();

// Максимальное количество сообщений в кэше для одного юзера
const MAX_MESSAGES_PER_USER = 50;

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

// Периодическая генерация summary (каждые 12 часов)
setInterval(async () => {
  for (const [chatId, messages] of chatHistoryCache.entries()) {
    if (messages.length > 0) {
      try {
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          fetch
        });

        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'Ты эмпатичный союзник, который делает краткую эмоциональную сводку диалога за день. Опиши ключевые темы, эмоции и выводы в 1-2 предложениях.'
            },
            {
              role: 'user',
              content: messages.map(msg => `${msg.role}: ${msg.content}`).join('\n')
            }
          ],
          max_tokens: 100
        });

        const summary = response.choices[0].message.content;

        await supabase
          .from('daily_summaries')
          .upsert({
            chat_id: String(chatId),
            summary_date: new Date().toISOString().split('T')[0],
            summary: summary,
            created_at: new Date().toISOString()
          });

        chatHistoryCache.set(String(chatId), []);
        console.log(`Summary generated and saved for chatId: ${chatId}`);
      } catch (err) {
        console.error(`Error generating summary for chat ${chatId}:`, err);
      }
    }
  }
}, 12 * 60 * 60 * 1000);

// Обработка вебхука Telegram
app.post('/chatbot-webhook', express.raw({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  try {
    console.log('Webhook headers:', req.headers);

    if (!req.body || req.body.length === 0) {
      console.error('Empty webhook body received');
      return res.status(400).json({ error: 'Empty request body' });
    }

    let update;
    let rawBody;

    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else {
      console.error('Invalid webhook body type:', typeof req.body, req.body);
      return res.status(400).json({ error: 'Invalid body type' });
    }

    console.log('Raw chatbot webhook body:', rawBody);

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

// Теперь добавляем express.json для остальных маршрутов
app.use(express.json());

// Обработчик сообщений для второго бота
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    console.log(`Chatbot message from ${chatId}: ${text || 'Non-text message'}`);

    // Находим юзера по telegram_chat_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, status, custom_name, persona, priority')
      .eq('telegram_chat_id', String(chatId))
      .single();

    if (userError || !user) {
      console.error('User fetch error:', userError);
      await bot.sendMessage(
        chatId,
        '⛔ Ошибка: пользователь не найден. Пожалуйста, начните с @gpt_soyuznik_bot.'
      );
      return;
    }

    console.log(`User ${chatId} found:`, user);

    if (user.status !== 'paid' && user.status !== 'active') {
      console.log(`User ${chatId} status: ${user.status}, access denied`);
      await bot.sendMessage(
        chatId,
        '⛔ Доступ закрыт. Пожалуйста, вернитесь в основной чат @gpt_soyuznik_bot для оплаты.'
      );
      return;
    }

    // Если юзер уже в процессе диалога
    const { data: states, error: stateError } = await supabase
      .from('user_states')
      .select('step')
      .eq('user_id', user.id);

    if (stateError) {
      console.error('State fetch error:', stateError);
    }

    const state = states && states.length > 0 ? states[0] : null;
    console.log(`Current state for user ${chatId}:`, state);

    // Инициализация истории для нового юзера
    if (!chatHistoryCache.has(String(chatId))) {
      chatHistoryCache.set(String(chatId), []);
    }

    // Загружаем последнее summary из daily_summaries
    let lastSummary = null;
    try {
      const { data: lastSummaries, error: summaryError } = await supabase
        .from('daily_summaries')
        .select('summary')
        .eq('chat_id', String(chatId))
        .order('summary_date', { ascending: false })
        .limit(1);

      if (summaryError) {
        console.error('Summary fetch error:', summaryError);
      } else {
        lastSummary = lastSummaries && lastSummaries.length > 0 ? lastSummaries[0] : null;
      }
    } catch (err) {
      console.error('Error fetching daily_summaries:', err);
    }
    console.log(`Last summary for user ${chatId}:`, lastSummary);

    const systemPrompt = lastSummary
      ? `Ты эмпатичный союзник, использующий модель GPT-4o от OpenAI. Вчера в нашем диалоге: ${lastSummary.summary}. Используй эту информацию, чтобы сделать диалог более тёплым и продолжительным. Общайся в дружеском стиле, как близкий друг, избегай формальностей, будь внимателен к эмоциям пользователя.`
      : 'Ты эмпатичный союзник, использующий модель GPT-4o от OpenAI. Мы начинаем новый диалог, будь внимателен к эмоциям и запросам пользователя. Общайся в тёплом, разговорном стиле, без формальностей, с заботой и поддержкой.';

    // Обработка фото
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.CHATBOT_TOKEN}/${file.file_path}`;

      const messages = chatHistoryCache.get(String(chatId));
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Опиши это изображение.' },
          { type: 'image_url', image_url: { url: fileUrl } }
        ]
      });

      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        fetch
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        max_tokens
