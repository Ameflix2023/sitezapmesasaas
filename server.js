require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { createEvolutionInstance, getEvolutionInstanceState, deleteEvolutionInstance, sendEvolutionText } = require('./evolution-server');

const port = Number(process.env.PORT || 3000);
const defaultRestaurantId = process.env.STORE_RESTAURANT_ID || '';
const publicFiles = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/loja.html': { file: 'loja.html', type: 'text/html; charset=utf-8' },
  '/dashboard.html': { file: 'dashboard.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' }
};

let database = null;
let firebaseError = null;

try {
  let credential;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (process.env.FIREBASE_CLIENT_EMAIL && privateKey) {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    });
  } else {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || path.join(__dirname, 'firebase-service-account.json');
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    credential = admin.credential.cert(serviceAccount);
  }

  const firebaseApp = admin.initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://venus-develops-default-rtdb.firebaseio.com'
  });

  database = admin.database(firebaseApp);
} catch (error) {
  firebaseError = error;
  console.error(`Firebase nao configurado: ${error.message}`);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function serveFile(response, fileConfig) {
  const filePath = path.join(__dirname, fileConfig.file);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Erro ao carregar o painel.');
      return;
    }

    response.writeHead(200, { 'Content-Type': fileConfig.type });
    response.end(content);
  });
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

function getOrderSummary(ordersData) {
  const orders = Object.entries(ordersData || {}).map(([id, order]) => ({ id, ...order }));
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthKey = todayKey.slice(0, 7);
  const monthDays = {};
  const products = {};
  let todayRevenue = 0;
  let weekRevenue = 0;
  let monthRevenue = 0;

  orders.forEach((order) => {
    const createdAt = new Date(order.createdAt || 0);
    const total = Number(order.total || 0);
    const orderDate = createdAt.toISOString().slice(0, 10);
    if (orderDate === todayKey) todayRevenue += total;
    if (createdAt >= weekStart) weekRevenue += total;
    if (orderDate.slice(0, 7) === monthKey) {
      monthRevenue += total;
      monthDays[orderDate] = (monthDays[orderDate] || 0) + total;
    }
    (order.items || []).forEach((item) => {
      const name = item.name || 'Produto';
      products[name] = (products[name] || 0) + Number(item.quantity || 0);
    });
  });

  return {
    orders,
    totals: { todayRevenue, weekRevenue, monthRevenue, orderCount: orders.length },
    dailyRevenue: monthDays,
    topProducts: Object.entries(products)
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((left, right) => right.quantity - left.quantity)
      .slice(0, 5)
  };
}

const server = http.createServer(async (request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (requestPath === '/api/firebase-status') {
    if (!database) {
      sendJson(response, 503, { connected: false, configured: false });
      return;
    }

    try {
      await database.ref('/').limitToFirst(1).once('value');
      sendJson(response, 200, { connected: true, configured: true });
    } catch (error) {
      sendJson(response, 503, { connected: false, configured: true });
    }
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/config') {
    sendJson(response, 200, { ok: true, defaultRestaurantId });
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/store') {
    const restaurantId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('restaurant');
    if (!database || !restaurantId || !/^[A-Za-z0-9_-]+$/.test(restaurantId)) {
      sendJson(response, 400, { ok: false, error: 'Restaurante invalido.' });
      return;
    }

    try {
      const snapshot = await database.ref(`restaurants/${restaurantId}`).once('value');
      const restaurantData = snapshot.val() || {};
      const productsData = restaurantData.products || {};
      const products = Object.entries(productsData).map(([id, product]) => ({ id, ...product }));
      sendJson(response, 200, {
        ok: true,
        restaurantName: restaurantData.name || restaurantData.profileName || 'Seu restaurante',
        whatsapp: restaurantData.whatsapp || '',
        products
      });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: 'Nao foi possivel carregar o cardapio.' });
    }
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/dashboard') {
    const restaurantId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('restaurant');
    if (!database || !restaurantId || !/^[A-Za-z0-9_-]+$/.test(restaurantId)) {
      sendJson(response, 400, { ok: false, error: 'Restaurante invalido.' });
      return;
    }

    try {
      const snapshot = await database.ref(`restaurants/${restaurantId}`).once('value');
      const restaurantData = snapshot.val() || {};
      sendJson(response, 200, {
        ok: true,
        restaurantName: restaurantData.name || restaurantData.profileName || 'Seu restaurante',
        products: Object.entries(restaurantData.products || {}).map(([id, product]) => ({ id, ...product })),
        ...getOrderSummary(restaurantData.orders)
      });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: 'Nao foi possivel carregar o dashboard.' });
    }
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/orders') {
    try {
      const payload = await readJsonBody(request);
      const { restaurantId, customerName, address, items } = payload;
      if (!database || !restaurantId || !/^[A-Za-z0-9_-]+$/.test(restaurantId) || !customerName || !address || !Array.isArray(items) || !items.length) {
        sendJson(response, 400, { ok: false, error: 'Dados do pedido incompletos.' });
        return;
      }

      const normalizedItems = items.map((item) => ({
        name: String(item.name || 'Produto').slice(0, 120),
        quantity: Math.max(1, Number(item.quantity || 1)),
        price: Number(item.price || 0)
      }));
      const total = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const orderRef = database.ref(`restaurants/${restaurantId}/orders`).push();
      await orderRef.set({
        customerName: String(customerName).slice(0, 120),
        address: String(address).slice(0, 300),
        items: normalizedItems,
        total,
        status: 'new',
        createdAt: new Date().toISOString()
      });
      sendJson(response, 201, { ok: true, orderId: orderRef.key, total });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: 'Nao foi possivel salvar o pedido.' });
    }
    return;
  }

  const orderStatusMatch = requestPath.match(/^\/api\/orders\/([^/]+)$/);
  if (request.method === 'PATCH' && orderStatusMatch) {
    try {
      const payload = await readJsonBody(request);
      const { restaurantId, status } = payload;
      const allowedStatuses = ['new', 'preparing', 'completed', 'cancelled'];
      if (!database || !restaurantId || !/^[A-Za-z0-9_-]+$/.test(restaurantId) || !allowedStatuses.includes(status)) {
        sendJson(response, 400, { ok: false, error: 'Status ou restaurante invalido.' });
        return;
      }
      await database.ref(`restaurants/${restaurantId}/orders/${orderStatusMatch[1]}`).update({ status });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: 'Nao foi possivel atualizar o pedido.' });
    }
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/evolution/instances') {
    try {
      const payload = await readJsonBody(request);
      const result = await createEvolutionInstance(payload);
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      sendJson(response, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  const instanceStateMatch = requestPath.match(/^\/api\/evolution\/instances\/([^/]+)\/state$/);
  if (request.method === 'GET' && instanceStateMatch) {
    try {
      const instanceName = decodeURIComponent(instanceStateMatch[1]);
      const result = await getEvolutionInstanceState(instanceName);
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      sendJson(response, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  const deleteInstanceMatch = requestPath.match(/^\/api\/evolution\/instances\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteInstanceMatch) {
    try {
      const instanceName = decodeURIComponent(deleteInstanceMatch[1]);
      const result = await deleteEvolutionInstance(instanceName);
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      sendJson(response, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/evolution/messages') {
    try {
      const payload = await readJsonBody(request);
      const { instanceName, number, text } = payload;

      if (!instanceName || !number || !text) {
        sendJson(response, 400, { ok: false, error: 'instanceName, number e text sao obrigatorios.' });
        return;
      }

      const result = await sendEvolutionText(instanceName, number, text);
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      sendJson(response, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  const fileConfig = publicFiles[requestPath];
  if (request.method === 'GET' && fileConfig) {
    serveFile(response, fileConfig);
    return;
  }

  sendJson(response, 404, { error: 'Nao encontrado.' });
});

server.listen(port, () => {
  console.log(`Zapmesa em http://localhost:${port}`);
  if (firebaseError) {
    console.log('Adicione as credenciais administrativas no .env antes de usar o Firebase.');
  }
});
