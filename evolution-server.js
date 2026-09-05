const configuredEvolutionUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const evolutionApiUrl = configuredEvolutionUrl.replace(/\/manager$/, '');
const evolutionApiKey = process.env.EVOLUTION_API_KEY;
const webhookPublicUrl = (process.env.WEBHOOK_PUBLIC_URL || '').replace(/\/+$/, '');

async function createEvolutionInstance(instanceOptions = {}) {
  if (!evolutionApiUrl || !evolutionApiKey) {
    throw Object.assign(
      new Error('A Evolution API nao esta configurada no servidor.'),
      { statusCode: 500 }
    );
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: evolutionApiKey
  };

  const payload = {
    instanceName: instanceOptions.instanceName || `zapmesa-${Date.now()}`,
    integration: instanceOptions.integration || 'WHATSAPP-BAILEYS',
    qrcode: instanceOptions.qrcode ?? true
  };

  if (webhookPublicUrl) {
    payload.webhook = {
      enabled: true,
      url: `${webhookPublicUrl}/webhooks/evolution`,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']
    };
  }

  const response = await fetch(`${evolutionApiUrl}/instance/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = { message: responseText };
  }

  if (!response.ok) {
    const errorMessage = responseData.message
      || responseData.response?.message
      || responseData.error
      || 'A Evolution API recusou a criacao da instancia.';
    const error = new Error(errorMessage);
    error.statusCode = response.status;
    throw error;
  }

  const createdInstanceName = responseData.instance?.instanceName || payload.instanceName;
  const connectionResponse = await fetch(
    `${evolutionApiUrl}/instance/connect/${encodeURIComponent(createdInstanceName)}`,
    {
      method: 'GET',
      headers: { apikey: evolutionApiKey }
    }
  );
  const connectionText = await connectionResponse.text();
  let connectionData;

  try {
    connectionData = connectionText ? JSON.parse(connectionText) : {};
  } catch {
    connectionData = { message: connectionText };
  }

  if (!connectionResponse.ok) {
    const errorMessage = connectionData.message
      || connectionData.response?.message
      || connectionData.error
      || 'A Evolution API nao conseguiu conectar a instancia.';
    const error = new Error(errorMessage);
    error.statusCode = connectionResponse.status;
    throw error;
  }

  return {
    ...responseData,
    qrcode: connectionData
  };
}

async function getEvolutionInstanceState(instanceName) {
  const response = await fetch(
    `${evolutionApiUrl}/instance/connectionState/${encodeURIComponent(instanceName)}`,
    {
      method: 'GET',
      headers: { apikey: evolutionApiKey }
    }
  );
  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = { message: responseText };
  }

  if (!response.ok) {
    const error = new Error(
      responseData.message || responseData.response?.message || responseData.error || 'Nao foi possivel consultar o estado da instancia.'
    );
    error.statusCode = response.status;
    throw error;
  }

  return responseData;
}

async function deleteEvolutionInstance(instanceName) {
  const response = await fetch(
    `${evolutionApiUrl}/instance/delete/${encodeURIComponent(instanceName)}`,
    {
      method: 'DELETE',
      headers: { apikey: evolutionApiKey }
    }
  );
  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = { message: responseText };
  }

  if (!response.ok) {
    const error = new Error(
      responseData.message || responseData.response?.message || responseData.error || 'Nao foi possivel desconectar a instancia.'
    );
    error.statusCode = response.status;
    throw error;
  }

  return responseData;
}

async function sendEvolutionText(instanceName, number, text) {
  const response = await fetch(
    `${evolutionApiUrl}/message/sendText/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: evolutionApiKey
      },
      body: JSON.stringify({ number, text })
    }
  );
  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = { message: responseText };
  }

  if (!response.ok) {
    const error = new Error(
      responseData.message || responseData.response?.message || responseData.error || 'Nao foi possivel enviar a mensagem.'
    );
    error.statusCode = response.status;
    throw error;
  }

  return responseData;
}

module.exports = {
  createEvolutionInstance,
  getEvolutionInstanceState,
  deleteEvolutionInstance,
  sendEvolutionText
};
