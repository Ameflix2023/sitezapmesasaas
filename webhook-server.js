require('dotenv').config();

const http = require('node:http');
const { sendEvolutionText } = require('./evolution-server');

const webhookPort = Number(process.env.WEBHOOK_PORT || 3001);
const autoReplyEnabled = process.env.AUTO_REPLY_ENABLED !== 'false';
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const storePublicUrl = (process.env.STORE_PUBLIC_URL || '').replace(/\/+$/, '');
const storeRestaurantId = process.env.STORE_RESTAURANT_ID || '';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error('Requisicao muito grande.'), { statusCode: 413 }));
        request.destroy();
      }
    });

    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('JSON invalido.'), { statusCode: 400 }));
      }
    });

    request.on('error', reject);
  });
}

function getMessageEvent(payload) {
  return payload?.data || payload;
}

function getIncomingMessage(payload) {
  const event = getMessageEvent(payload);
  const remoteJid = event?.key?.remoteJid;
  const message = event?.message;
  const text = message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption;

  if (!remoteJid || event?.key?.fromMe || remoteJid.endsWith('@g.us') || !text) {
    return null;
  }

  return {
    instanceName: payload.instance,
    number: remoteJid.split('@')[0],
    text
  };
}

async function generateGeminiReply(messageText) {
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY nao configurada.');
  }

  const storeLink = storePublicUrl && storeRestaurantId
    ? `${storePublicUrl}/loja.html?restaurant=${encodeURIComponent(storeRestaurantId)}`
    : '';
  const systemPrompt = 'Voce e o atendente virtual de um restaurante. Responda em portugues do Brasil, de forma cordial, objetiva e natural. Nao invente precos, produtos ou horarios. Quando nao souber, diga que vai encaminhar para a equipe.'
    + (storeLink ? ` Quando o cliente pedir cardapio, menu ou produtos, envie este link: ${storeLink}` : '');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiApiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: messageText }]
      }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 300
      }
    })
  });
  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = { message: responseText };
  }

  if (!response.ok) {
    const error = new Error(responseData.error?.message || responseData.message || 'O Gemini recusou a solicitacao.');
    error.statusCode = response.status;
    throw error;
  }

  const reply = responseData.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim();
  if (!reply) {
    throw new Error('O Gemini nao retornou uma resposta.');
  }

  return reply;
}

const webhookServer = http.createServer(async (request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (request.method === 'GET' && requestPath === '/health') {
    sendJson(response, 200, { ok: true, service: 'evolution-webhook' });
    return;
  }

  if (request.method === 'POST' && requestPath === '/webhooks/evolution') {
    try {
      const payload = await readJsonBody(request);
      const event = getMessageEvent(payload);
      const incomingMessage = getIncomingMessage(payload);

      console.log('Evento recebido da Evolution:', JSON.stringify({
        event: payload.event,
        instance: payload.instance,
        remoteJid: event?.key?.remoteJid,
        message: event?.message
      }));

      if (autoReplyEnabled && incomingMessage?.instanceName) {
        try {
          const reply = await generateGeminiReply(incomingMessage.text);
          await sendEvolutionText(
            incomingMessage.instanceName,
            incomingMessage.number,
            reply
          );
          console.log(`Resposta do Gemini enviada para ${incomingMessage.number}.`);
        } catch (error) {
          console.error(`Falha ao gerar resposta do Gemini: ${error.message}`);
        }
      }

      sendJson(response, 200, { ok: true, received: true });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      sendJson(response, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: 'Nao encontrado.' });
});

webhookServer.listen(webhookPort, () => {
  console.log(`Webhook Evolution em http://localhost:${webhookPort}`);
});
